"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CANONICAL_STAGES,
  REQUIRED_CANONICAL_STAGES,
  STAGE_LABELS,
  suggestCanonicalStage,
  type CanonicalStage,
} from "@/lib/stages";

/**
 * Connection wizard.
 *
 * Every step VERIFIES against the live API before it will advance, and echoes
 * back what the API returned — the GHL business name, the Meta account name and
 * currency. A mistyped ad account id or a token generated against the wrong
 * sub-account is then caught in the moment, instead of surfacing weeks later as
 * an inexplicably empty dashboard.
 *
 * The final step is the important one: it does not declare success when the
 * webhook URL has been *displayed*, it polls until a real event arrives.
 * Configured and working are different things.
 */

/**
 * A failed response, rendered as one line.
 *
 * Since `api-failure.ts` these routes return `{ error, hint }` rather than a
 * raw upstream string, and the hint carries the half that changes what somebody
 * does next — "nothing needs reconnecting, this clears on its own" versus
 * "re-authorise the account". Reading only `error` would swap a specific
 * upstream error for a vaguer one of ours and drop the compensation, which is a
 * strictly worse wizard.
 */
function failureText(
  body: { error?: string; hint?: string } | null | undefined,
  fallback: string,
): string {
  const head = body?.error ?? fallback;
  if (!body?.hint) return head;
  // Our redacted messages are written without a full stop; a passed-through
  // message of ours may have one. Joining blindly gives "valid.. Reconnect".
  return `${head.replace(/\.$/, "")}. ${body.hint}`;
}

interface StageRow {
  id: string;
  name: string | null;
  pipelineName: string | null;
  canonicalStage: CanonicalStage | null;
  discoveredFromWebhook: boolean;
}

interface Props {
  clientId: string;
  slug: string;
  webhookUrl: string;
  /** True when GHL_CLIENT_ID/SECRET are set, enabling the one-click install. */
  oauthAvailable: boolean;
  installation: {
    locationName: string | null;
    locationId: string;
    installedAt: string;
    uninstalledAt: string | null;
  } | null;
  initial: {
    ghlLocationId: string;
    ghlLocationName: string | null;
    ghlAuthMethod: "pit" | "oauth";
    hasGhlToken: boolean;
    clientTimezone: string;
    firstWebhookAt: string | null;
  };
  metaAccounts: MetaAccountRow[];
  /** META_APP_ID + META_APP_SECRET are set, so "Continue with Facebook" works. */
  metaConnectConfigured: boolean;
  /** Set when the browser has just come back from Facebook's consent screen. */
  metaStash: string | null;
  googleAccounts: GoogleAccountRow[];
  /** True when the agency Google Ads env vars are all set. */
  googleConfigured: boolean;
  /** Set when the browser has just come back from Google's consent screen. */
  googleStash: string | null;
  tiktokAccounts: TiktokAccountRow[];
  /** TIKTOK_APP_ID + TIKTOK_APP_SECRET are set, so "Continue with TikTok" works. */
  tiktokConfigured: boolean;
  /** Set when the browser has just come back from TikTok's authorization screen. */
  tiktokStash: string | null;
  stages: StageRow[];
}

export interface MetaAccountRow {
  id: string;
  adAccountId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  isPrimary: boolean;
  status: "active" | "paused" | "removed";
}

export interface GoogleAccountRow {
  id: string;
  customerId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  isPrimary: boolean;
  status: "active" | "paused" | "removed";
}

/**
 * No `isPrimary`, unlike its two siblings — `tiktok_ad_accounts` has no such
 * column. Meta's primary account defines the client's display currency and
 * bucketing timezone; TikTok deliberately never overwrites those, so there is
 * nothing for a primary to mean here.
 */
export interface TiktokAccountRow {
  id: string;
  advertiserId: string;
  advertiserName: string | null;
  currency: string | null;
  timezone: string | null;
  status: "active" | "paused" | "removed";
}

export function SetupWizard({
  clientId,
  slug,
  webhookUrl,
  oauthAvailable,
  installation,
  initial,
  metaAccounts,
  metaConnectConfigured,
  metaStash,
  googleAccounts,
  googleConfigured,
  googleStash,
  tiktokAccounts,
  tiktokConfigured,
  tiktokStash,
  stages: initialStages,
}: Props) {
  const router = useRouter();
  const usingOauth = initial.ghlAuthMethod === "oauth" || oauthAvailable;

  return (
    <div className="flex flex-col gap-5">
      {usingOauth ? (
        <InstallStep
          clientId={clientId}
          installation={installation}
          oauthAvailable={oauthAvailable}
          connectedLocationName={initial.ghlLocationName}
          webhookAlive={Boolean(initial.firstWebhookAt)}
        />
      ) : (
        <GhlStep
          clientId={clientId}
          initial={initial}
          onDone={() => router.refresh()}
        />
      )}
      <StageStep
        clientId={clientId}
        stages={initialStages}
        onDone={() => router.refresh()}
      />
      <MetaAccountsStep
        clientId={clientId}
        accounts={metaAccounts}
        connectConfigured={metaConnectConfigured}
        stash={metaStash}
        onDone={() => router.refresh()}
      />
      <GoogleAccountsStep
        clientId={clientId}
        accounts={googleAccounts}
        configured={googleConfigured}
        stash={googleStash}
        onDone={() => router.refresh()}
      />
      <TiktokAccountsStep
        clientId={clientId}
        accounts={tiktokAccounts}
        connectConfigured={tiktokConfigured}
        stash={tiktokStash}
        onDone={() => router.refresh()}
      />
      {!usingOauth && (
        <WebhookStep
          clientId={clientId}
          webhookUrl={webhookUrl}
          firstWebhookAt={initial.firstWebhookAt}
        />
      )}
      {/* On the OAuth path WebhookStep (step 6) isn't rendered, so backfill takes
          its number — otherwise the wizard reads 1,2,3,4,5,7 with a missing "6". */}
      <BackfillStep clientId={clientId} slug={slug} step={usingOauth ? 6 : 7} />
    </div>
  );
}

/**
 * One-click install via the marketplace app.
 *
 * This replaces both the token-entry step AND the webhook-installation step:
 * app-level webhooks are configured once in the app's own settings, so an
 * installed sub-account starts streaming `OpportunityStageUpdate` events with
 * no per-client workflow building at all. That is the entire reason for
 * preferring OAuth over a Private Integration Token, which has no webhook
 * capability.
 */
function InstallStep({
  clientId,
  installation,
  oauthAvailable,
  connectedLocationName,
  webhookAlive,
}: {
  clientId: string;
  installation: Props["installation"];
  oauthAvailable: boolean;
  connectedLocationName: string | null;
  webhookAlive: boolean;
}) {
  const active = installation && !installation.uninstalledAt;
  // Connected the original way — bound to a location and already streaming
  // events — but with no captured OAuth install row. Events are flowing, so the
  // step is genuinely done; the marketplace install is then only an optional
  // upgrade, not a "you are not connected" prompt.
  const connectedViaWebhook =
    !active && webhookAlive && Boolean(connectedLocationName);

  return (
    <Card
      step={1}
      title="Connect GoHighLevel"
      description="Installs the marketplace app on the client's sub-account. No workflow building required — stage changes stream automatically."
      done={Boolean(active) || connectedViaWebhook}
    >
      {!oauthAvailable ? (
        <p className="text-xs" style={{ color: "var(--status-warning)" }}>
          OAuth is not configured on this deployment. Set{" "}
          <code>GHL_CLIENT_ID</code> and <code>GHL_CLIENT_SECRET</code>, or use
          a Private Integration Token instead.
        </p>
      ) : active ? (
        <>
          <Result ok>
            Installed on{" "}
            {installation!.locationName ?? installation!.locationId}
          </Result>
          <a
            href={`/api/oauth/authorize?clientId=${clientId}`}
            className="mt-3 inline-block rounded-[8px] border px-3 py-2 text-[13px] font-medium"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            Reconnect
          </a>
        </>
      ) : connectedViaWebhook ? (
        <>
          <Result ok>
            Connected to {connectedLocationName} — receiving events
          </Result>
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Events are already streaming from this sub-account. Re-installing
            through the marketplace app is optional — it captures an OAuth token
            for one-click reconnects.
          </p>
          <a
            href={`/api/oauth/authorize?clientId=${clientId}`}
            className="mt-3 inline-block rounded-[8px] border px-3 py-2 text-[13px] font-medium"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            Install via marketplace app
          </a>
        </>
      ) : (
        <>
          {installation?.uninstalledAt && (
            <p
              className="mb-3 text-xs"
              style={{ color: "var(--status-critical)" }}
            >
              The app was uninstalled on{" "}
              {new Date(installation.uninstalledAt).toLocaleDateString(
                "en-US",
                {
                  timeZone: "UTC",
                },
              )}
              . Stage changes are not being recorded.
            </p>
          )}
          <a
            href={`/api/oauth/authorize?clientId=${clientId}`}
            className="inline-block rounded-[8px] px-3 py-2 text-[13px] font-medium btn-accent"
          >
            Install on a sub-account
          </a>
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            You&rsquo;ll be sent to GoHighLevel to pick the sub-account, then
            returned here. Pipeline stages import automatically.
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

interface DiscoveredMetaAccount {
  adAccountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  active: boolean;
}

/**
 * Pick which of the authorising Facebook user's ad accounts belong to a client.
 *
 * 🔴 Selection is a separate step from consent, and it is not a formality: a
 * media buyer's login can reach every account the agency runs, so attaching
 * everything the token can see would put another client's spend on this
 * dashboard. Nothing is pre-ticked for the same reason.
 *
 * Inactive accounts are shown and disabled rather than hidden — an operator
 * hunting for an account they know exists needs to see it greyed out with a
 * reason, or they conclude the sign-in failed and go round again.
 */
function MetaAccountPicker({
  clientId,
  stash,
  onDone,
}: {
  clientId: string;
  stash: string;
  onDone: () => void;
}) {
  const [accounts, setAccounts] = useState<DiscoveredMetaAccount[] | null>(
    null,
  );
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/clients/${clientId}/meta-connect?stash=${encodeURIComponent(stash)}`,
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(failureText(body, "Could not read that Facebook sign-in."));
          return;
        }
        setAccounts(body.accounts ?? []);
        setExpiresAt(body.tokenExpiresAt ?? null);
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, stash]);

  async function attach() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/meta-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stash, adAccountIds: [...picked] }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(failureText(body, "Could not attach those accounts."));
        return;
      }
      if (body.failed?.length) {
        setError(
          body.failed
            .map(
              (f: { adAccountId: string; error: string }) =>
                `act_${f.adAccountId}: ${f.error}`,
            )
            .join(" · "),
        );
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (error && !accounts) {
    return (
      <p
        className="mb-4 text-[12.5px]"
        style={{ color: "var(--status-critical)" }}
      >
        {error}
      </p>
    );
  }
  if (!accounts) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        Reading the ad accounts on that Facebook login…
      </p>
    );
  }
  if (accounts.length === 0) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        That Facebook account cannot reach any ad accounts. Sign in with the
        account that manages these ads, or add the ad account ID below.
      </p>
    );
  }

  return (
    <div
      className="mb-4 rounded-[10px] border p-3"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface-2)",
      }}
    >
      <p
        className="text-[13px] font-medium"
        style={{ color: "var(--text-primary)" }}
      >
        Which of these belong to this client?
      </p>
      <p
        className="mt-0.5 text-[11.5px]"
        style={{ color: "var(--text-muted)" }}
      >
        {accounts.length} ad account{accounts.length === 1 ? "" : "s"} on this
        Facebook login.
      </p>

      {/*
        A search box only once the list stops being scannable. An agency login
        with partner access to thirty client accounts cannot be picked from by
        eye, and ticking the wrong row here puts another client's spend on this
        dashboard.

        Grouping by Business Manager would be the better answer, but that field
        needs `business_management` — see `meta/client.ts:listAdAccounts`.
      */}
      {accounts.length > 8 && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by account name or ID…"
          className="mt-2 w-full rounded-[8px] border px-2.5 py-1.5 text-[13px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
      )}

      {(() => {
        const q = filter.trim().toLowerCase();
        const shown = q
          ? accounts.filter((a) =>
              [a.name, a.adAccountId]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(q)),
            )
          : accounts;

        if (shown.length === 0) {
          return (
            <p
              className="mt-2 text-[12.5px]"
              style={{ color: "var(--text-muted)" }}
            >
              No ad account on this login matches “{filter.trim()}”.
            </p>
          );
        }

        return (
          <ul className="mt-1 flex flex-col">
            {shown.map((a) => (
              <li
                key={a.adAccountId}
                className="flex items-start gap-2.5 py-1.5"
              >
                <input
                  id={`fb-${a.adAccountId}`}
                  type="checkbox"
                  className="mt-1"
                  disabled={!a.active || busy}
                  checked={picked.has(a.adAccountId)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(a.adAccountId);
                    else next.delete(a.adAccountId);
                    setPicked(next);
                  }}
                />
                <label
                  htmlFor={`fb-${a.adAccountId}`}
                  className="min-w-0 flex-1 cursor-pointer"
                  style={{ opacity: a.active ? 1 : 0.55 }}
                >
                  <span
                    className="block text-[13px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {a.name ?? `act_${a.adAccountId}`}
                    {!a.active && (
                      <span
                        className="ml-1.5 text-[11px] font-normal"
                        style={{ color: "var(--text-muted)" }}
                      >
                        · not active on Facebook
                      </span>
                    )}
                  </span>
                  <span
                    className="block text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    act_{a.adAccountId} · {a.currency ?? "?"} ·{" "}
                    {a.timezone ?? "?"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        );
      })()}

      {/*
        Counted across the whole list, not the filtered view — a selection made
        before typing a filter is still going to be attached, and hiding it
        behind a search term is how the wrong account gets connected.
      */}
      {picked.size > 0 && filter.trim() !== "" && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          {picked.size} selected in total, including accounts hidden by the
          filter.
        </p>
      )}

      {/*
        🔴 Stated at the moment of connecting, not left to be discovered.
        A Facebook user token lasts ~60 days; the system user token behind the
        manual path does not expire at all. Someone choosing between the two
        deserves to know which one lapses.
      */}
      {expiresAt && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          This Facebook sign-in expires on{" "}
          {new Date(expiresAt).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
          . You will be warned two weeks before it does.
        </p>
      )}

      {error && (
        <p
          className="mt-2 text-[12px]"
          style={{ color: "var(--status-critical)" }}
        >
          {error}
        </p>
      )}

      <button
        onClick={attach}
        disabled={busy || picked.size === 0}
        className="mt-3 rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        style={{ background: "var(--accent)" }}
      >
        {busy
          ? "Attaching…"
          : `Attach ${picked.size || ""} ${picked.size === 1 ? "account" : "accounts"}`.trim()}
      </button>
    </div>
  );
}

function Card({
  step,
  title,
  description,
  done,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-5">
      <div className="mb-3 flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
          style={{
            background: done ? "var(--status-good)" : "var(--surface-2)",
            color: done ? "#fff" : "var(--text-secondary)",
          }}
          aria-hidden="true"
        >
          {done ? "✓" : step}
        </span>
        <div className="min-w-0 flex-1">
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h2>
          {description && (
            <p
              className="mt-0.5 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span
        className="text-[11px] font-medium tracking-wider uppercase"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
      <input
        {...props}
        className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
        style={inputStyle}
      />
    </label>
  );
}

function Result({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <p
      className="mt-3 flex items-start gap-2 text-xs"
      style={{ color: ok ? "var(--delta-good)" : "var(--status-critical)" }}
    >
      <span aria-hidden="true">{ok ? "✓" : "✕"}</span>
      <span>{children}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ */

function GhlStep({
  clientId,
  initial,
  onDone,
}: {
  clientId: string;
  initial: Props["initial"];
  onDone: () => void;
}) {
  const [locationId, setLocationId] = useState(initial.ghlLocationId);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(
    initial.ghlLocationName
      ? { ok: true, msg: `Connected to ${initial.ghlLocationName}` }
      : null,
  );

  async function verify() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "ghl",
          locationId,
          token: token || undefined,
        }),
      });
      const body = await res.json();
      setResult(
        res.ok
          ? { ok: true, msg: `Connected to ${body.locationName ?? locationId}` }
          : { ok: false, msg: failureText(body, "Verification failed") },
      );
      if (res.ok) {
        setToken("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={1}
      title="Connect GoHighLevel"
      description="A Private Integration Token for this sub-account, plus its location ID."
      done={Boolean(initial.ghlLocationName)}
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Location ID"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          placeholder="ve9EPM428h8vShlRW1KT"
        />
        <Field
          label={
            initial.hasGhlToken
              ? "Private Integration Token (leave blank to keep existing)"
              : "Private Integration Token"
          }
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="pit-..."
        />
        <button
          onClick={verify}
          disabled={busy || !locationId}
          className="self-start rounded-[8px] px-3 py-2 text-[13px] font-medium btn-accent disabled:opacity-50"
        >
          {busy ? "Verifying…" : "Verify & save"}
        </button>
      </div>
      {result && <Result ok={result.ok}>{result.msg}</Result>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function groupStagesByPipeline(rows: StageRow[]) {
  const map = new Map<string, StageRow[]>();
  for (const r of rows) {
    const key = r.pipelineName?.trim() || "Ungrouped";
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }
  return Array.from(map, ([pipeline, stages]) => ({ pipeline, stages }));
}

function StageStep({
  clientId,
  stages,
  onDone,
}: {
  clientId: string;
  stages: StageRow[];
  onDone: () => void;
}) {
  const [rows, setRows] = useState(stages);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  /*
   * Reset local edits when the server sends a new stage list (after a
   * re-import, or a router.refresh()). This is React's documented
   * adjust-state-during-render pattern — an effect would render once with the
   * stale list and then correct itself, briefly showing the old mapping.
   */
  const [seenStages, setSeenStages] = useState(stages);
  if (stages !== seenStages) {
    setSeenStages(stages);
    setRows(stages);
  }

  const mapped = new Set(rows.map((r) => r.canonicalStage).filter(Boolean));
  // Gate on the REQUIRED stages only. `disqualified` is offered in the dropdown
  // below but never blocks setup — a pipeline with no junk stage is a normal
  // pipeline, and demanding one would strand every client who does not run that
  // way at a step they cannot complete.
  const missing = REQUIRED_CANONICAL_STAGES.filter((s) => !mapped.has(s));
  const groups = groupStagesByPipeline(rows);
  const totalMapped = rows.filter((r) => r.canonicalStage).length;

  async function importStages() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/stages?refresh=1`);
      const body = await res.json();
      if (res.ok) {
        setRows(body.stages);
        setMsg({ ok: true, msg: `Imported ${body.stages.length} stages` });
        onDone();
      } else {
        setMsg({ ok: false, msg: failureText(body, "Import failed") });
      }
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/stages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mappings: rows.map((r) => ({
            stageId: r.id,
            canonicalStage: r.canonicalStage,
          })),
        }),
      });
      const body = await res.json();
      setMsg(
        res.ok
          ? {
              ok: true,
              msg: `Saved.${
                body.reclassifiedTransitions
                  ? ` ${body.reclassifiedTransitions} existing transitions reclassified.`
                  : ""
              }`,
            }
          : { ok: false, msg: failureText(body, "Save failed") },
      );
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  // Which pipeline sections are open. Default: only partially-mapped pipelines
  // (the ones needing a decision). Fully-mapped and untouched pipelines collapse,
  // turning a wall of 47 rows into a scannable list of 7.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const g of groupStagesByPipeline(stages)) {
      const m = g.stages.filter((x) => x.canonicalStage).length;
      if (m > 0 && m < g.stages.length) s.add(g.pipeline);
    }
    return s;
  });
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const setCanonical = (id: string, canonical: CanonicalStage | null) =>
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, canonicalStage: canonical } : r)),
    );

  const pipelineOf = (r: StageRow) => r.pipelineName?.trim() || "Ungrouped";

  // Fill every still-unmapped stage in scope with its name-based suggestion.
  // Never overwrites an existing mapping — it is a first pass, not an authority.
  const autoMap = (pipeline?: string) =>
    setRows((prev) =>
      prev.map((r) => {
        if (r.canonicalStage) return r;
        if (pipeline && pipelineOf(r) !== pipeline) return r;
        const s = suggestCanonicalStage(r.name);
        return s ? { ...r, canonicalStage: s } : r;
      }),
    );

  // Mark a whole pipeline unused in one click — the pipeline-level control most
  // sub-accounts need, since they carry several pipelines unrelated to the ad
  // funnel that would otherwise be 12 "not used" dropdowns each.
  const ignorePipeline = (pipeline: string) => {
    setRows((prev) =>
      prev.map((r) =>
        pipelineOf(r) === pipeline ? { ...r, canonicalStage: null } : r,
      ),
    );
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(pipeline);
      return next;
    });
  };

  const autoMappable = rows.filter(
    (r) => !r.canonicalStage && suggestCanonicalStage(r.name),
  ).length;

  return (
    <Card
      step={2}
      title="Map pipeline stages"
      description="Your GHL stage names, mapped onto the seven canonical funnel stages."
      done={rows.length > 0 && missing.length === 0}
    >
      <button
        onClick={importStages}
        disabled={busy}
        className="rounded-[8px] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
        style={{
          borderColor: "var(--border-strong)",
          color: "var(--text-secondary)",
        }}
      >
        {busy
          ? "Working…"
          : rows.length
            ? "Re-import from GHL"
            : "Import from GHL"}
      </button>

      {rows.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {rows.length} stages across {groups.length} pipeline
              {groups.length === 1 ? "" : "s"} · {totalMapped} mapped
            </p>
            {autoMappable > 0 && (
              <button
                onClick={() => autoMap()}
                className="rounded-[8px] border px-2.5 py-1 text-[12px] font-medium"
                style={{
                  borderColor: "var(--border-strong)",
                  color: "var(--text-secondary)",
                }}
              >
                ✨ Auto-map {autoMappable} by name
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-col gap-2.5">
            {groups.map((group) => {
              const gMapped = group.stages.filter(
                (s) => s.canonicalStage,
              ).length;
              const total = group.stages.length;
              const full = gMapped === total;
              const none = gMapped === 0;
              const open = expanded.has(group.pipeline);
              const gAutoMappable = group.stages.filter(
                (s) => !s.canonicalStage && suggestCanonicalStage(s.name),
              ).length;
              return (
                <div
                  key={group.pipeline}
                  className="rounded-[10px] border"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      onClick={() => toggle(group.pipeline)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className="text-[10px] transition-transform"
                        style={{
                          color: "var(--text-muted)",
                          transform: open ? "rotate(90deg)" : "none",
                        }}
                        aria-hidden="true"
                      >
                        ▶
                      </span>
                      <span
                        className="truncate text-[12px] font-semibold uppercase tracking-wide"
                        style={{ color: "var(--text-secondary)" }}
                        title={group.pipeline}
                      >
                        {group.pipeline}
                      </span>
                      <StageBadge
                        full={full}
                        none={none}
                        mapped={gMapped}
                        total={total}
                      />
                    </button>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {gAutoMappable > 0 && (
                        <button
                          onClick={() => autoMap(group.pipeline)}
                          className="rounded-[6px] px-2 py-1 text-[11px] font-medium"
                          style={{
                            color: "var(--accent)",
                            background:
                              "color-mix(in srgb, var(--accent) 12%, transparent)",
                          }}
                        >
                          Auto-map
                        </button>
                      )}
                      {!none && (
                        <button
                          onClick={() => ignorePipeline(group.pipeline)}
                          className="rounded-[6px] px-2 py-1 text-[11px] font-medium"
                          style={{
                            color: "var(--text-muted)",
                            background: "var(--surface-2)",
                          }}
                        >
                          Ignore
                        </button>
                      )}
                    </div>
                  </div>

                  {open && (
                    <div
                      className="flex flex-col gap-1 border-t px-3 py-2"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {group.stages.map((row) => (
                        <div
                          key={row.id}
                          className="flex flex-wrap items-center gap-2 rounded-[8px] px-2 py-1.5"
                          style={{
                            background: row.canonicalStage
                              ? "transparent"
                              : "color-mix(in srgb, var(--status-warning) 7%, transparent)",
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <div
                              className="truncate text-[13px]"
                              style={{ color: "var(--text-primary)" }}
                            >
                              {row.name ?? (
                                <em style={{ color: "var(--text-muted)" }}>
                                  Unnamed stage
                                </em>
                              )}
                              {row.discoveredFromWebhook && (
                                <span
                                  className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium"
                                  style={{
                                    background:
                                      "color-mix(in srgb, var(--status-warning) 22%, transparent)",
                                    color: "var(--text-secondary)",
                                  }}
                                >
                                  seen in webhook
                                </span>
                              )}
                            </div>
                          </div>
                          <select
                            value={row.canonicalStage ?? ""}
                            onChange={(e) =>
                              setCanonical(
                                row.id,
                                (e.target.value ||
                                  null) as CanonicalStage | null,
                              )
                            }
                            className="min-w-[150px] rounded-[8px] border px-2 py-1.5 text-[13px]"
                            style={inputStyle}
                          >
                            <option value="">— not used —</option>
                            {CANONICAL_STAGES.map((s) => (
                              <option key={s} value={s}>
                                {STAGE_LABELS[s]}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {missing.length > 0 && (
            <p
              className="mt-3 text-xs"
              style={{ color: "var(--status-warning)" }}
            >
              Unmapped: {missing.map((s) => STAGE_LABELS[s]).join(", ")} — these
              will read as zero in the funnel.
            </p>
          )}

          <button
            onClick={save}
            disabled={busy}
            className="mt-3 rounded-[8px] px-3 py-2 text-[13px] font-medium btn-accent disabled:opacity-50"
          >
            Save mapping
          </button>
        </>
      )}

      {msg && <Result ok={msg.ok}>{msg.msg}</Result>}
    </Card>
  );
}

/** Per-pipeline status pill: fully mapped ✓ / partial N∕T / not used. */
function StageBadge({
  full,
  none,
  mapped,
  total,
}: {
  full: boolean;
  none: boolean;
  mapped: number;
  total: number;
}) {
  const { text, color } = full
    ? { text: "✓ mapped", color: "var(--status-good)" }
    : none
      ? { text: "not used", color: "var(--text-muted)" }
      : { text: `${mapped}/${total}`, color: "var(--status-warning)" };
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
    >
      {text}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Meta ad accounts — add as many as the client runs.
 *
 * A client can hold several accounts (e.g. one per location); the dashboard
 * sums spend and metrics across all of them. Each is verified against the Meta
 * API before it is stored, echoing back the real name/currency/timezone so a
 * mistyped id is caught immediately. The first account added sets the client's
 * display currency and bucketing timezone; a later account that disagrees on
 * either is flagged, because mixed currencies cannot be summed.
 */
function MetaAccountsStep({
  clientId,
  accounts,
  onDone,
  connectConfigured,
  stash,
}: {
  clientId: string;
  accounts: MetaAccountRow[];
  onDone: () => void;
  /** META_APP_ID + META_APP_SECRET are set, so the consent flow can run. */
  connectConfigured: boolean;
  /** Present when we have just returned from Facebook — opens the picker. */
  stash: string | null;
}) {
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{
    ok: boolean;
    text: string;
    warn?: string;
  } | null>(null);

  const live = accounts.filter((a) => a.status !== "removed");

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/meta-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adAccountId: accountId,
          token: token || undefined,
        }),
      });
      const body = await res.json();
      if (res.ok) {
        const warnings: string[] = [];
        if (body.currencyMismatch) {
          warnings.push(
            `Currency ${body.currencyMismatch.thisAccount} differs from the primary account's ${body.currencyMismatch.primary} — spend across different currencies cannot be summed correctly.`,
          );
        }
        if (body.timezoneMismatch) {
          warnings.push(
            `Timezone ${body.timezoneMismatch.thisAccount} differs from the primary ${body.timezoneMismatch.primary} — daily buckets may not line up.`,
          );
        }
        setMsg({
          ok: true,
          text: `Added ${body.account.accountName ?? body.account.adAccountId} · ${body.account.currency ?? "?"} · ${body.account.timezone ?? "?"}`,
          warn: warnings.join(" "),
        });
        setAccountId("");
        setToken("");
        setShowToken(false);
        onDone();
      } else {
        setMsg({ ok: false, text: failureText(body, "Failed to add account") });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this ad account? Metrics already pulled are kept."))
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/meta-accounts/${id}`, {
        method: "DELETE",
      });
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={3}
      title="Connect Meta ad accounts"
      description="Add every ad account this client runs. Spend and metrics are summed across all of them."
      done={live.length > 0}
    >
      {live.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {live.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-2 rounded-[8px] border p-2.5"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="truncate text-[13px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {a.accountName ?? a.adAccountId}
                  </span>
                  {a.isPrimary && (
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                      style={{
                        background: "var(--surface-2)",
                        color: "var(--text-muted)",
                      }}
                    >
                      primary
                    </span>
                  )}
                </div>
                <div
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  act_{a.adAccountId} · {a.currency ?? "?"} ·{" "}
                  {a.timezone ?? "?"}
                </div>
              </div>
              <button
                onClick={() => remove(a.id)}
                disabled={busy}
                className="shrink-0 text-xs hover:underline disabled:opacity-50"
                style={{ color: "var(--status-critical)" }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        The self-serve path, first, because it is the one that should be taken.
        The ad-account-ID form below stays as the fallback: it is the only route
        that works before Meta App Review passes for anyone without a role on
        the app, and the only one that uses the never-expiring system user token.
      */}
      {connectConfigured && !stash && (
        <div className="mb-4">
          <a
            href={`/api/oauth/meta/authorize?clientId=${encodeURIComponent(clientId)}`}
            className="inline-flex items-center gap-2 rounded-[9px] px-3.5 py-2.5 text-[13.5px] font-semibold text-white transition-opacity hover:opacity-90"
            style={{ background: "#1877F2" }}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
            </svg>
            Continue with Facebook
          </a>
          <p
            className="mt-1.5 text-[11.5px]"
            style={{ color: "var(--text-muted)" }}
          >
            Sign in with the Facebook account that holds these ads, then pick
            which ad accounts belong to this client.
          </p>
        </div>
      )}

      {stash && (
        <MetaAccountPicker clientId={clientId} stash={stash} onDone={onDone} />
      )}

      <div className="flex flex-col gap-3">
        <Field
          label={live.length ? "Add another ad account ID" : "Ad account ID"}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder="1234567890 (or act_1234567890)"
        />
        {showToken ? (
          <Field
            label="Access token override (different Business Manager)"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Leave blank to use the system user token"
          />
        ) : (
          <button
            onClick={() => setShowToken(true)}
            className="self-start text-xs hover:underline"
            style={{ color: "var(--text-muted)" }}
          >
            + Add a token override (only if this account is in another Business
            Manager)
          </button>
        )}
        <button
          onClick={add}
          disabled={busy || !accountId}
          className="self-start rounded-[8px] px-3 py-2 text-[13px] font-medium btn-accent disabled:opacity-50"
        >
          {busy ? "Verifying…" : "Verify & add"}
        </button>
      </div>

      {msg && (
        <>
          <Result ok={msg.ok}>{msg.text}</Result>
          {msg.warn && (
            <p
              className="mt-2 text-xs"
              style={{ color: "var(--status-warning)" }}
            >
              ⚠ {msg.warn}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Google Ads accounts — the direct sibling of the Meta step.
 *
 * Unlike Meta (one system-user token in env), Google authorizes every account
 * through the agency MCC, so the only per-client input is the Customer ID. It is
 * verified against the Google Ads API before storing, echoing back the real
 * name/currency/timezone so a wrong id or an account that was never linked to
 * our MCC is caught in the moment rather than surfacing as silently missing
 * spend. When the agency Google env vars aren't set, the step explains that and
 * stays inert — Google is optional, a client can run Meta only.
 */
interface DiscoveredGoogleAccount {
  customerId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  isManager: boolean;
  level: number;
}

/**
 * Pick which of the authorizing Google account's customers belong to a client.
 *
 * Two differences from the Meta picker, both forced by how Google Ads is shaped:
 *
 * 🔴 **Manager (MCC) accounts are shown but not selectable.** A manager holds no
 * campaigns of its own, so attaching one produces an account that reports zero
 * spend forever — which on the dashboard is indistinguishable from a paused
 * account. It is listed rather than hidden because it is the thing an operator
 * recognises by name, and seeing it is how they find the child underneath it.
 *
 * The tree is flattened with indentation rather than collapsed, because a media
 * buyer identifies a client's account by where it sits under the manager at
 * least as often as by its own name.
 */
function GoogleAccountPicker({
  clientId,
  stash,
  onDone,
}: {
  clientId: string;
  stash: string;
  onDone: () => void;
}) {
  const [accounts, setAccounts] = useState<DiscoveredGoogleAccount[] | null>(
    null,
  );
  const [partial, setPartial] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/clients/${clientId}/google-connect?stash=${encodeURIComponent(stash)}`,
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(failureText(body, "Could not read that Google sign-in."));
          return;
        }
        setAccounts(body.accounts ?? []);
        setPartial(Boolean(body.partial));
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, stash]);

  async function attach() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/google-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stash, customerIds: [...picked] }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(failureText(body, "Could not attach those accounts."));
        return;
      }
      if (body.failed?.length) {
        setError(
          body.failed
            .map(
              (f: { customerId: string; error: string }) =>
                `${f.customerId}: ${f.error}`,
            )
            .join(" · "),
        );
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (error && !accounts) {
    return (
      <p
        className="mb-4 text-[12.5px]"
        style={{ color: "var(--status-critical)" }}
      >
        {error}
      </p>
    );
  }
  if (!accounts) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        Reading the accounts on that Google login…
      </p>
    );
  }
  if (accounts.length === 0) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        That Google account cannot reach any Ads accounts. Sign in with the
        account that manages these ads, or add the Customer ID below.
      </p>
    );
  }

  const q = filter.trim().toLowerCase();
  const shown = q
    ? accounts.filter((a) =>
        [a.name, a.customerId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
    : accounts;
  const selectable = accounts.filter((a) => !a.isManager).length;

  return (
    <div
      className="mb-4 rounded-[10px] border p-3"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface-2)",
      }}
    >
      <p
        className="text-[13px] font-medium"
        style={{ color: "var(--text-primary)" }}
      >
        Which of these belong to this client?
      </p>
      <p
        className="mt-0.5 text-[11.5px]"
        style={{ color: "var(--text-muted)" }}
      >
        {selectable} account{selectable === 1 ? "" : "s"} you can attach
        {accounts.length !== selectable &&
          `, plus ${accounts.length - selectable} manager account${
            accounts.length - selectable === 1 ? "" : "s"
          } shown for context`}
        .
      </p>

      {/*
        Surfaced rather than swallowed. Discovery walks each manager separately
        and skips branches it cannot read, so a short list looks identical to a
        complete one — which is how someone concludes an account "isn't there"
        and goes hunting in the wrong place.
      */}
      {partial && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--status-warning)" }}
        >
          Some parts of this account tree could not be read, so this list may be
          incomplete. If an account you expect is missing, add its Customer ID
          below.
        </p>
      )}

      {accounts.length > 8 && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or Customer ID…"
          className="mt-2 w-full rounded-[8px] border px-2.5 py-1.5 text-[13px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
      )}

      {shown.length === 0 ? (
        <p
          className="mt-2 text-[12.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          No account on this login matches “{filter.trim()}”.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col">
          {shown.map((a) => (
            <li
              key={a.customerId}
              className="flex items-start gap-2.5 py-1.5"
              // Indent by depth so a client's account reads as sitting under
              // the manager the operator recognises.
              style={{ paddingLeft: `${Math.min(a.level, 4) * 14}px` }}
            >
              <input
                id={`g-${a.customerId}`}
                type="checkbox"
                className="mt-1"
                disabled={a.isManager || busy}
                checked={picked.has(a.customerId)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(a.customerId);
                  else next.delete(a.customerId);
                  setPicked(next);
                }}
              />
              <label
                htmlFor={`g-${a.customerId}`}
                className="min-w-0 flex-1 cursor-pointer"
                style={{ opacity: a.isManager ? 0.55 : 1 }}
              >
                <span
                  className="block text-[13px] font-medium"
                  style={{ color: "var(--text-primary)" }}
                >
                  {a.name ?? a.customerId}
                  {a.isManager && (
                    <span
                      className="ml-1.5 text-[11px] font-normal"
                      style={{ color: "var(--text-muted)" }}
                    >
                      · manager account — holds no campaigns
                    </span>
                  )}
                </span>
                <span
                  className="block text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {a.customerId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {picked.size > 0 && filter.trim() !== "" && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          {picked.size} selected in total, including accounts hidden by the
          filter.
        </p>
      )}

      {error && (
        <p
          className="mt-2 text-[12px]"
          style={{ color: "var(--status-critical)" }}
        >
          {error}
        </p>
      )}

      <button
        onClick={attach}
        disabled={busy || picked.size === 0}
        className="mt-3 rounded-[8px] px-3 py-2 text-[13px] font-medium btn-accent disabled:opacity-60"
      >
        {busy
          ? "Attaching…"
          : `Attach ${picked.size || ""} ${picked.size === 1 ? "account" : "accounts"}`.trim()}
      </button>
    </div>
  );
}

function GoogleAccountsStep({
  clientId,
  accounts,
  configured,
  stash,
  onDone,
}: {
  clientId: string;
  accounts: GoogleAccountRow[];
  configured: boolean;
  stash: string | null;
  onDone: () => void;
}) {
  const [customerId, setCustomerId] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{
    ok: boolean;
    text: string;
    warn?: string;
  } | null>(null);

  const live = accounts.filter((a) => a.status !== "removed");

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/google-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, refreshToken: token || undefined }),
      });
      const body = await res.json();
      if (res.ok) {
        const warnings: string[] = [];
        if (body.currencyMismatch) {
          warnings.push(
            `Currency ${body.currencyMismatch.thisAccount} differs from the primary account's ${body.currencyMismatch.primary} — spend across different currencies cannot be summed correctly.`,
          );
        }
        if (body.timezoneMismatch) {
          warnings.push(
            `Timezone ${body.timezoneMismatch.thisAccount} differs from the primary ${body.timezoneMismatch.primary} — daily buckets may not line up.`,
          );
        }
        setMsg({
          ok: true,
          text: `Added ${body.account.accountName ?? body.account.customerId} · ${body.account.currency ?? "?"} · ${body.account.timezone ?? "?"}`,
          warn: warnings.join(" "),
        });
        setCustomerId("");
        setToken("");
        setShowToken(false);
        onDone();
      } else {
        setMsg({ ok: false, text: failureText(body, "Failed to add account") });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (
      !confirm(
        "Remove this Google Ads account? Metrics already pulled are kept.",
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/clients/${clientId}/google-accounts/${id}`,
        {
          method: "DELETE",
        },
      );
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={4}
      title="Connect Google Ads (optional)"
      description="Add the client's Customer ID. Spend, impressions and clicks are summed in alongside Meta."
      done={live.length > 0}
    >
      {!configured && live.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--status-warning)" }}>
          Google Ads isn&rsquo;t configured on this deployment yet. Add the
          agency developer token, OAuth client, refresh token and MCC id to the
          environment (see <code>SETUP.md</code> §2b), then reload. A client can
          run Meta-only until then.
        </p>
      ) : (
        <>
          {live.length > 0 && (
            <ul className="mb-4 flex flex-col gap-2">
              {live.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-2 rounded-[8px] border p-2.5"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="truncate text-[13px] font-medium"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {a.accountName ?? a.customerId}
                      </span>
                      {a.isPrimary && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: "var(--surface-2)",
                            color: "var(--text-muted)",
                          }}
                        >
                          primary
                        </span>
                      )}
                    </div>
                    <div
                      className="text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {a.customerId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                    </div>
                  </div>
                  <button
                    onClick={() => remove(a.id)}
                    disabled={busy}
                    className="shrink-0 text-xs hover:underline disabled:opacity-50"
                    style={{ color: "var(--status-critical)" }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/*
            The self-serve path, first, because it is the one that should be
            taken. This route already existed and worked — it was simply linked
            from nowhere, so the only visible option was pasting a raw refresh
            token, which is the agency-MCC path and the worst first-run moment
            in the product. Mirrors the Meta step above.
          */}
          {!stash && (
            <div className="mb-4">
              <a
                href={`/api/oauth/google/authorize?clientId=${encodeURIComponent(clientId)}`}
                className="inline-flex items-center gap-2 rounded-[9px] border px-3.5 py-2.5 text-[13.5px] font-semibold transition-opacity hover:opacity-90"
                style={{
                  background: "#ffffff",
                  color: "#1f1f1f",
                  borderColor: "#dadce0",
                }}
              >
                <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                Continue with Google
              </a>
              <p
                className="mt-1.5 text-[11.5px]"
                style={{ color: "var(--text-muted)" }}
              >
                Sign in with the Google account that manages these ads, then
                pick which accounts belong to this client.
              </p>
            </div>
          )}

          {stash && (
            <GoogleAccountPicker
              clientId={clientId}
              stash={stash}
              onDone={onDone}
            />
          )}

          <div className="flex flex-col gap-3">
            <Field
              label={live.length ? "Add another Customer ID" : "Customer ID"}
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="123-456-7890"
            />
            {showToken ? (
              <Field
                label="Refresh token override (account not under the agency MCC)"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Leave blank to use the agency MCC token"
              />
            ) : (
              <button
                onClick={() => setShowToken(true)}
                className="self-start text-xs hover:underline"
                style={{ color: "var(--text-muted)" }}
              >
                + Add a token override (only if this account is not linked to
                our MCC)
              </button>
            )}
            <button
              onClick={add}
              disabled={busy || !customerId}
              className="self-start rounded-[8px] px-3 py-2 text-[13px] font-medium btn-accent disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify & add"}
            </button>
          </div>

          {msg && (
            <>
              <Result ok={msg.ok}>{msg.text}</Result>
              {msg.warn && (
                <p
                  className="mt-2 text-xs"
                  style={{ color: "var(--status-warning)" }}
                >
                  ⚠ {msg.warn}
                </p>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

interface DiscoveredTiktokAdvertiser {
  advertiserId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

/**
 * Pick which of the authorizing TikTok grant's advertisers belong to a client.
 *
 * 🔴 Selection is separate from authorization for the same reason as Meta and
 * Google, and here the risk is at its most literal: TikTok's token exchange
 * hands back an `advertiser_ids` **array**. One approval can cover every
 * advertiser an agency manages, so attaching what the grant can see would put
 * another client's spend on this dashboard. Nothing is pre-ticked.
 *
 * Simpler than the Google picker in one respect — TikTok has no manager
 * hierarchy, so there is no shown-but-disabled row. Every advertiser listed
 * holds campaigns.
 */
function TiktokAccountPicker({
  clientId,
  stash,
  onDone,
}: {
  clientId: string;
  stash: string;
  onDone: () => void;
}) {
  const [advertisers, setAdvertisers] = useState<
    DiscoveredTiktokAdvertiser[] | null
  >(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  /*
   * 🔴 Currency and timezone are unknown, not absent.
   *
   * Each row renders `{currency ?? "?"} · {timezone ?? "?"}`, so a failed
   * `/advertiser/info/` call turns the whole column into `?` and looks
   * identical to TikTok simply not reporting one — which, for an ad account,
   * does not happen. This product sums spend across accounts and currencies
   * cannot be summed, so picking blind here is how a EUR advertiser lands in a
   * USD total. The attach step still catches it, but by then the choice is
   * made and the warning is a surprise instead of information.
   */
  const [detailUnavailable, setDetailUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/clients/${clientId}/tiktok-connect?stash=${encodeURIComponent(stash)}`,
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(
            failureText(body, "Could not read that TikTok authorization."),
          );
          return;
        }
        setAdvertisers(body.advertisers ?? []);
        setDetailUnavailable(Boolean(body.detailUnavailable));
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, stash]);

  async function attach() {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await fetch(`/api/clients/${clientId}/tiktok-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stash, advertiserIds: [...picked] }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(failureText(body, "Could not attach those advertisers."));
        return;
      }
      if (body.failed?.length) {
        setError(
          body.failed
            .map(
              (f: { advertiserId: string; error: string }) =>
                `${f.advertiserId}: ${f.error}`,
            )
            .join(" · "),
        );
      }
      /*
       * Mixed currencies cannot be summed and mismatched timezones make "a day"
       * mean two things across platforms. Neither blocks the attach — the
       * operator may know exactly why — but neither may be silent.
       */
      if (body.warnings?.length) {
        setWarnings(
          body.warnings.map(
            (w: { advertiserId: string; message: string }) =>
              `${w.advertiserId}: ${w.message}`,
          ),
        );
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (error && !advertisers) {
    return (
      <p
        className="mb-4 text-[12.5px]"
        style={{ color: "var(--status-critical)" }}
      >
        {error}
      </p>
    );
  }
  if (!advertisers) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        Reading the advertisers on that TikTok authorization…
      </p>
    );
  }
  if (advertisers.length === 0) {
    return (
      <p className="mb-4 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
        That TikTok authorization cannot reach any advertiser accounts.
        Authorize again with an account that has access to them in Business
        Center.
      </p>
    );
  }

  const q = filter.trim().toLowerCase();
  const shown = q
    ? advertisers.filter((a) =>
        [a.name, a.advertiserId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
    : advertisers;

  return (
    <div
      className="mb-4 rounded-[10px] border p-3"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface-2)",
      }}
    >
      <p
        className="text-[13px] font-medium"
        style={{ color: "var(--text-primary)" }}
      >
        Which of these belong to this client?
      </p>
      <p
        className="mt-0.5 text-[11.5px]"
        style={{ color: "var(--text-muted)" }}
      >
        {advertisers.length} advertiser{advertisers.length === 1 ? "" : "s"} on
        this TikTok authorization.
      </p>

      {detailUnavailable && (
        <p
          role="status"
          className="mt-1.5 text-[11.5px]"
          style={{ color: "var(--status-warning)" }}
        >
          Currency and timezone could not be read for these advertisers, so both
          show as “?” below — TikTok answered the list but not the detail. You
          can still pick, and each account is re-checked on attach; if a currency
          differs from this client&rsquo;s, you will be told then.
        </p>
      )}

      {advertisers.length > 8 && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by advertiser name or ID…"
          className="mt-2 w-full rounded-[8px] border px-2.5 py-1.5 text-[13px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
      )}

      {shown.length === 0 ? (
        <p
          className="mt-2 text-[12.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          No advertiser on this authorization matches “{filter.trim()}”.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col">
          {shown.map((a) => (
            <li
              key={a.advertiserId}
              className="flex items-start gap-2.5 py-1.5"
            >
              <input
                id={`tt-${a.advertiserId}`}
                type="checkbox"
                className="mt-1"
                disabled={busy}
                checked={picked.has(a.advertiserId)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(a.advertiserId);
                  else next.delete(a.advertiserId);
                  setPicked(next);
                }}
              />
              <label
                htmlFor={`tt-${a.advertiserId}`}
                className="min-w-0 flex-1 cursor-pointer"
              >
                <span
                  className="block text-[13px] font-medium"
                  style={{ color: "var(--text-primary)" }}
                >
                  {a.name ?? a.advertiserId}
                </span>
                <span
                  className="block text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {a.advertiserId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {picked.size > 0 && filter.trim() !== "" && (
        <p
          className="mt-2 text-[11.5px]"
          style={{ color: "var(--text-muted)" }}
        >
          {picked.size} selected in total, including advertisers hidden by the
          filter.
        </p>
      )}

      {/*
        🔴 The opposite of the Facebook picker's expiry line, and stated for the
        same reason: someone comparing platforms deserves to know which
        connection lapses. TikTok access tokens do not expire and there is no
        refresh token — a real "never", not an unknown we are hiding.
      */}
      <p className="mt-2 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
        This authorization does not expire. It ends only if the TikTok account
        that granted it loses access to the advertiser.
      </p>

      {error && (
        <p
          className="mt-2 text-[12px]"
          style={{ color: "var(--status-critical)" }}
        >
          {error}
        </p>
      )}
      {warnings.map((w) => (
        <p
          key={w}
          className="mt-2 text-[12px]"
          style={{ color: "var(--status-warning)" }}
        >
          ⚠ {w}
        </p>
      ))}

      <button
        onClick={attach}
        disabled={busy || picked.size === 0}
        className="mt-3 rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        style={{ background: "var(--accent)" }}
      >
        {busy
          ? "Attaching…"
          : `Attach ${picked.size || ""} ${picked.size === 1 ? "advertiser" : "advertisers"}`.trim()}
      </button>
    </div>
  );
}

/**
 * TikTok advertisers — the third platform, and the only one with no manual
 * fallback.
 *
 * Meta has the system-user token and Google has the agency MCC refresh token,
 * so both keep an id-entry form for the case where consent is unavailable.
 * TikTok has no shared-credential equivalent: a token exists only as the output
 * of an authorization. So when the app is not configured this step says so and
 * stays inert rather than offering a form that could never work.
 */
function TiktokAccountsStep({
  clientId,
  accounts,
  onDone,
  connectConfigured,
  stash,
}: {
  clientId: string;
  accounts: TiktokAccountRow[];
  onDone: () => void;
  /** TIKTOK_APP_ID + TIKTOK_APP_SECRET are set, so the flow can run. */
  connectConfigured: boolean;
  /** Present when we have just returned from TikTok — opens the picker. */
  stash: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const live = accounts.filter((a) => a.status !== "removed");

  async function remove(id: string) {
    if (!confirm("Remove this advertiser? Metrics already pulled are kept."))
      return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/clients/${clientId}/tiktok-accounts/${id}`,
        {
          method: "DELETE",
        },
      );
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={5}
      title="Connect TikTok advertisers"
      description="Optional. Adds TikTok spend alongside Meta and Google so the blended totals are complete."
      done={live.length > 0}
    >
      {live.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {live.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-2 rounded-[8px] border p-2.5"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0 flex-1">
                <span
                  className="block truncate text-[13px] font-medium"
                  style={{ color: "var(--text-primary)" }}
                >
                  {a.advertiserName ?? a.advertiserId}
                </span>
                <span
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {a.advertiserId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                </span>
              </div>
              <button
                onClick={() => remove(a.id)}
                disabled={busy}
                className="shrink-0 text-xs hover:underline disabled:opacity-50"
                style={{ color: "var(--status-critical)" }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {!connectConfigured ? (
        <p className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
          TikTok isn’t configured on this installation. Set{" "}
          <code>TIKTOK_APP_ID</code> and <code>TIKTOK_APP_SECRET</code> from the
          app at business-api.tiktok.com. Everything else works without it — a
          client can run Meta and Google only.
        </p>
      ) : (
        !stash && (
          <div>
            <a
              href={`/api/oauth/tiktok/authorize?clientId=${encodeURIComponent(clientId)}`}
              className="inline-flex items-center gap-2 rounded-[9px] px-3.5 py-2.5 text-[13.5px] font-semibold text-white transition-opacity hover:opacity-90"
              style={{ background: "#000000" }}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5 2.59 2.59 0 0 1 0-5.18c.27 0 .52.04.76.12v-3.2a5.72 5.72 0 0 0-.76-.05A5.79 5.79 0 0 0 4.07 15.4a5.79 5.79 0 0 0 11.58 0V9.01a7.35 7.35 0 0 0 4.29 1.37V7.29a4.29 4.29 0 0 1-3.34-1.47z" />
              </svg>
              Continue with TikTok
            </a>

            {/*
              🔴 Said BEFORE the click, not discovered mid-flow.

              TikTok emails the advertiser a verification code partway through
              authorization and will not proceed without it. Someone who does
              not expect that reads the pause as a broken flow and abandons —
              which is the single most likely way this connection fails for a
              reason that is not a fault.
            */}
            <p
              className="mt-2 text-[11.5px]"
              style={{ color: "var(--status-warning)" }}
            >
              TikTok will email a verification code partway through and won’t
              continue until it’s entered. Have that inbox open before you
              start.
            </p>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--text-muted)" }}
            >
              Then pick which advertisers belong to this client. The
              authorization does not expire.
            </p>
          </div>
        )
      )}

      {stash && (
        <TiktokAccountPicker
          clientId={clientId}
          stash={stash}
          onDone={onDone}
        />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Waits for a real event rather than trusting that the URL was pasted.
 * Polls the health endpoint until `firstWebhookAt` is populated.
 */
function WebhookStep({
  clientId,
  webhookUrl,
  firstWebhookAt,
}: {
  clientId: string;
  webhookUrl: string;
  firstWebhookAt: string | null;
}) {
  const [received, setReceived] = useState(Boolean(firstWebhookAt));
  const [listening, setListening] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!listening || received) return;
    timer.current = setInterval(async () => {
      const res = await fetch(`/api/clients/${clientId}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const body = await res.json();
        if (body.client?.firstWebhookAt) {
          setReceived(true);
          setListening(false);
        }
      }
    }, 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [listening, received, clientId]);

  return (
    <Card
      step={6}
      title="Install the GHL webhook"
      description="In GHL: Automation → Workflows → new workflow → trigger 'Pipeline Stage Changed' → action 'Webhook'."
      done={received}
    >
      <div
        className="flex items-center gap-2 rounded-[8px] border p-2"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--surface-2)",
        }}
      >
        <code
          className="min-w-0 flex-1 truncate text-[12px]"
          style={{ color: "var(--text-primary)" }}
        >
          {webhookUrl}
        </code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(webhookUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="shrink-0 rounded-[6px] border px-2 py-1 text-[12px]"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {received ? (
        <Result ok>
          Webhook events are arriving — funnel history is recording.
        </Result>
      ) : (
        <>
          <button
            onClick={() => setListening(true)}
            disabled={listening}
            className="mt-3 rounded-[8px] px-3 py-2 text-[13px] font-medium btn-accent disabled:opacity-60"
          >
            {listening ? "Waiting for first event…" : "Test connection"}
          </button>
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Move any opportunity between stages in GHL. This will turn green the
            moment a real event lands — until then, no pipeline history is being
            recorded, and it cannot be backfilled later.
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function BackfillStep({
  clientId,
  slug,
  step,
}: {
  clientId: string;
  slug: string;
  step: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  async function run(action: "meta_backfill" | "ghl_backfill") {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, days: 90 }),
      });
      const body = await res.json();
      setMsg(
        res.ok
          ? {
              ok: true,
              msg:
                action === "meta_backfill"
                  ? `Imported ${body.rowsWritten} daily metric rows.`
                  : `Snapshotted ${body.opportunities} opportunities (${body.transitions} arrivals). ${body.note}`,
            }
          : { ok: false, msg: failureText(body, "Failed") },
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      step={step}
      title="Import historical data"
      description="Optional, run once. Meta history imports fully; GHL history does not."
    >
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => run("meta_backfill")}
          disabled={busy !== null}
          className="rounded-[8px] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {busy === "meta_backfill"
            ? "Importing…"
            : "Import 90 days of Meta data"}
        </button>
        <button
          onClick={() => run("ghl_backfill")}
          disabled={busy !== null}
          className="rounded-[8px] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {busy === "ghl_backfill"
            ? "Importing…"
            : "Snapshot GHL opportunities"}
        </button>
      </div>

      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        GoHighLevel exposes no stage-transition history, so the snapshot records
        only where each opportunity sits now and when it last moved. The path
        each lead took to get there is not recoverable — true funnel flow begins
        from when the webhook went live.
      </p>

      {msg && <Result ok={msg.ok}>{msg.msg}</Result>}

      <a
        href={`/c/${slug}`}
        className="mt-4 inline-block text-[13px] font-medium hover:underline"
        style={{ color: "var(--series-1)" }}
      >
        Go to dashboard →
      </a>
    </Card>
  );
}
