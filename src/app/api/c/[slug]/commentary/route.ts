import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, agencyGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  isValidMonthKey,
  MAX_COMMITMENTS,
  MAX_COMMITMENT_CHARS,
  MAX_DID_CHARS,
  MAX_NOTE_CHARS,
  TARGET_METRICS,
  VERDICTS,
} from "@/lib/commentary/model";
import { saveCommentary } from "@/lib/commentary/store";
import { loadCommentaryForEditor } from "@/lib/commentary/report";

/**
 * Monthly commentary — §6.16.
 *
 * Staff only at every layer. It is not in `CLIENT_RESOURCES` in
 * `proxy-rules.ts`, so a client-role session is refused at the edge before this
 * file runs, and `agencyGuard` refuses again with the role re-read from the
 * database rather than trusted from the session token.
 *
 * 🔴 **This file cannot publish.** `PUT` writes the working copy only, because
 * `saveCommentary` has no access to the published columns. Publishing is
 * `commentary/publish/route.ts` — a separate URL, a separate handler, its own
 * audit entry. The separation is the safety property, so it is worth its being
 * visible in the route tree.
 */

const SAVE_LIMIT = 60;
const SAVE_WINDOW_MS = 10 * 60_000;

const MonthSchema = z.object({
  month: z.string().refine(isValidMonthKey, "Invalid month"),
  platform: z.enum(["meta", "google"]).default("meta"),
});

const TargetSchema = z
  .object({
    metric: z.enum(TARGET_METRICS),
    direction: z.enum(["at_most", "at_least"]),
    /*
     * Finite and non-negative. `Infinity` arrives as `null` through JSON, but a
     * target of `-1` on cost per lead would be an unmeetable promise that reads
     * as a real one, and `NaN` would judge every month as missed.
     */
    value: z.number().finite().min(0),
  })
  .strict();

const CommitmentSchema = z
  .object({
    id: z.string().min(1).max(64),
    text: z.string().trim().min(1).max(MAX_COMMITMENT_CHARS),
    target: TargetSchema.nullable().default(null),
  })
  .strict();

const OutcomeSchema = z
  .object({
    commitmentId: z.string().min(1).max(64),
    verdict: z.enum(VERDICTS),
    note: z.string().trim().max(MAX_NOTE_CHARS).default(""),
  })
  .strict();

const SaveSchema = MonthSchema.extend({
  did: z.string().max(MAX_DID_CHARS).default(""),
  commitments: z.array(CommitmentSchema).max(MAX_COMMITMENTS).default([]),
  outcomes: z.array(OutcomeSchema).max(MAX_COMMITMENTS * 2).default([]),
}).strict();

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = await agencyGuard();
  if (denied) return denied;

  const { slug } = await ctx.params;
  /*
   * Tenant-scoped, ON TOP OF the guard above rather than instead of it. The
   * guard says who the caller is; this says the client is theirs. `slug` is
   * derived from a business name and therefore guessable, so an unscoped
   * read here was reachable by typing one.
   */
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = MonthSchema.safeParse({
    month: req.nextUrl.searchParams.get("month"),
    platform: req.nextUrl.searchParams.get("platform") ?? "meta",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid month" }, { status: 400 });
  }

  const loaded = await loadCommentaryForEditor(
    client,
    parsed.data.platform,
    parsed.data.month,
  );
  return NextResponse.json(loaded);
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = await agencyGuard();
  if (denied) return denied;

  const { slug } = await ctx.params;
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = SaveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { month, platform, did, commitments, outcomes } = parsed.data;

  /*
   * 🔴 Duplicate commitment ids are refused rather than deduplicated. The
   * following month's answers are keyed by id: two commitments sharing one
   * would attach a single answer to both, and the reader would see a verdict
   * against a promise nobody judged. The read path drops duplicates defensively
   * too, but a request carrying them is a bug in the caller and should say so.
   */
  const ids = new Set(commitments.map((c) => c.id));
  if (ids.size !== commitments.length) {
    return NextResponse.json(
      { error: "Two commitments share an id." },
      { status: 400 },
    );
  }
  const answered = new Set(outcomes.map((o) => o.commitmentId));
  if (answered.size !== outcomes.length) {
    return NextResponse.json(
      { error: "Two answers point at the same commitment." },
      { status: 400 },
    );
  }

  const session = await getSessionUser();
  const actor = session?.userId ?? "unknown";

  /*
   * `.ok` — `rateLimit` returns a result object, and an object is always
   * truthy. Written as `if (!rateLimit(...))` this guard could never fire.
   */
  const gate = rateLimit(`commentary:${client.id}`, SAVE_LIMIT, SAVE_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many edits. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  let stored;
  try {
    stored = await saveCommentary(
      { clientId: client.id, platform, month },
      { did, commitments, outcomes },
      actor,
    );
  } catch (err) {
    console.error("[commentary] save failed:", err);
    return NextResponse.json(
      {
        error:
          "Could not save. If this deploy is ahead of its migration, run the database push first.",
      },
      { status: 503 },
    );
  }

  await record({
    action: "commentary.saved",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: {
      month,
      platform,
      commitments: commitments.length,
      /*
       * How many of the plan's items carry a number, recorded because it is the
       * one thing that decides whether next month's verdicts are arithmetic or
       * opinion — and it is worth being able to see that trend over time.
       */
      withTargets: commitments.filter((c) => c.target !== null).length,
      outcomes: outcomes.length,
    },
  });

  return NextResponse.json({ commentary: stored });
}
