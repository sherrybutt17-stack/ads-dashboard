import { agencyEmailKey } from "@/lib/reports/email";
import type { DnsRecord } from "./identity";

/**
 * Resend's Domains API, for the team that holds agencies' sending domains.
 *
 * No database here and no `server-only` import — the key is read from the
 * environment at call time, and `server-only` cannot be resolved under vitest,
 * where `send.test.ts` imports this module through `deliver.ts`.
 *
 * ── 🔴 The key never reaches a message ─────────────────────────────────
 *
 * Every error is rebuilt from Resend's own `message`, and those are read by
 * agency operators on the Email domain tab. The key is a Full-access credential
 * for a whole Resend team; nothing here interpolates it anywhere but the
 * Authorization header.
 *
 * ── Each call carries its own timeout ──────────────────────────────────
 *
 * These run inside a page render and inside the hourly cron. A budget checked
 * between calls cannot stop one request that hangs, so every request is bounded
 * on its own.
 */

const BASE = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  records: DnsRecord[];
}

export class DomainApiError extends Error {
  constructor(
    message: string,
    /** Resend's HTTP status, or 503 when the feature is not configured. */
    readonly status: number,
    /** Resend's error `name` — "validation_error", "restricted_api_key" … */
    readonly code: string | null,
    /**
     * True when the fault is on our side — the key, or the plan — rather than
     * anything the agency typed. Routes answer 503 for these, and log them.
     */
    readonly ours: boolean = false,
  ) {
    super(message);
    this.name = "DomainApiError";
  }
}

/**
 * Whether Resend's refusal is about our key or our plan.
 *
 * Read from the message as well as the status, because Resend does not keep to
 * one status for it: an invalid key on the domains endpoints comes back as a
 * 400 `validation_error` reading "API key is invalid", not the 401 its docs
 * suggest — seen against the live API.
 */
function isOurs(status: number, code: string, raw: string): boolean {
  return (
    code === "restricted_api_key" ||
    code === "missing_api_key" ||
    status === 401 ||
    /api key/i.test(raw) ||
    (status === 403 && /limit|plan|upgrade/i.test(raw))
  );
}

/** Resend's message, rewritten into what an agency operator can act on. */
function friendlyMessage(status: number, body: { message?: unknown; name?: unknown } | null): string {
  // Resend's keys all start `re_`. Anything shaped like one is hidden before
  // the message can reach an agency — it should never be there, and if it ever
  // is, this is the last place it can be stopped.
  const raw =
    typeof body?.message === "string"
      ? body.message.replace(/\bre_[A-Za-z0-9_]{6,}/g, "[hidden]").trim()
      : "";
  const code = typeof body?.name === "string" ? body.name : "";

  if (/already (been )?registered|already exists/i.test(raw)) {
    return "This domain is already set up in another email account, so it can't be added here. Use a subdomain instead, such as mail.yourdomain.com.";
  }
  if (code === "restricted_api_key") {
    return "Our email service refused the request (the RESEND_AGENCY_API_KEY key can only send — it needs Full access). Please contact Growth Guild.";
  }
  if (code === "missing_api_key" || status === 401 || /api key/i.test(raw)) {
    return "Our email service refused the request (the RESEND_AGENCY_API_KEY key isn't valid). Please contact Growth Guild.";
  }
  if (status === 429) {
    return "Too many requests to the email service just now. Try again in a minute.";
  }
  if (status === 403 && /limit|plan|upgrade/i.test(raw)) {
    return "We've reached the number of domains our email plan allows. Please contact Growth Guild.";
  }
  if (status >= 500) {
    return "The email service is having trouble. Try again in a few minutes.";
  }
  return raw ? `The email service said: ${raw.replace(/[.\s]+$/, "")}.` : `The email service returned ${status}.`;
}

async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const key = agencyEmailKey();
  if (!key) {
    throw new DomainApiError(
      "Custom sending domains aren't set up on this dashboard yet.",
      503,
      "not_configured",
    );
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof body?.name === "string" ? body.name : "";
    const raw = typeof body?.message === "string" ? body.message : "";
    throw new DomainApiError(
      friendlyMessage(res.status, body),
      res.status,
      code || null,
      isOurs(res.status, code, raw),
    );
  }
  return body;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Resend's domain object, read defensively — every field is someone else's. */
export function parseDomain(json: unknown): ResendDomain {
  const o = (json ?? {}) as Record<string, unknown>;
  const id = asString(o.id);
  if (!id) throw new DomainApiError("The email service sent back a domain without an id.", 502, null);
  const records = Array.isArray(o.records) ? o.records : [];
  return {
    id,
    name: asString(o.name) ?? "",
    status: asString(o.status) ?? "not_started",
    records: records
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
      .map((r) => ({
        record: asString(r.record) ?? "",
        name: asString(r.name) ?? "",
        type: asString(r.type) ?? "",
        value: asString(r.value) ?? "",
        priority: typeof r.priority === "number" ? r.priority : null,
        ttl: asString(r.ttl),
        status: asString(r.status),
      }))
      .filter((r) => r.name && r.type && r.value),
  };
}

export async function createDomain(name: string): Promise<ResendDomain> {
  return parseDomain(await call("POST", "/domains", { body: { name } }));
}

export async function getDomain(id: string, timeoutMs?: number): Promise<ResendDomain> {
  return parseDomain(await call("GET", `/domains/${encodeURIComponent(id)}`, { timeoutMs }));
}

/** Starts Resend's check. Asynchronous at Resend: read the result with `getDomain`. */
export async function verifyDomain(id: string, timeoutMs?: number): Promise<void> {
  await call("POST", `/domains/${encodeURIComponent(id)}/verify`, { timeoutMs });
}

/** Removes it from Resend. Already gone counts as done. */
export async function deleteDomain(id: string): Promise<void> {
  try {
    await call("DELETE", `/domains/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof DomainApiError && err.status === 404) return;
    throw err;
  }
}
