import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, agencyGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { loadDashboard } from "@/lib/metrics/dashboard";
import { buildInsights } from "@/lib/metrics/insights";
import { isValidDateKey } from "@/lib/dates";
import { buildBrief } from "@/lib/ai/brief";
import { verifyFigures } from "@/lib/ai/verify";
import {
  generateSummary,
  summariesConfigured,
  SummaryUnavailable,
  FRAMINGS,
} from "@/lib/ai/summary";
import { saveDraft, saveEdits, listSummaries } from "@/lib/ai/store";

/**
 * The written weekly summary — §6.2.
 *
 * Staff only, at every layer. It is not in `CLIENT_RESOURCES` in
 * `proxy-rules.ts`, so a client-role session is refused at the edge before a
 * handler runs, and `agencyGuard` refuses again here with the role re-read from
 * the database rather than trusted from the session token.
 *
 * 🔴 **Neither verb in this file can publish.** `POST` generates and `PUT`
 * saves edits; both write only the working copy, because `saveDraft` and
 * `saveEdits` have no access to the published columns. Publishing is
 * `summary/publish/route.ts`, a separate endpoint with its own audit entry.
 * That separation is the whole safety property, so it is worth it being
 * visible in the file listing.
 */

/**
 * Generation is a paid model call, so it is rate limited harder than a write.
 * Four framings over two platforms is eight legitimate calls for one period;
 * twelve leaves room to regenerate a couple without ever being in the way.
 */
const GENERATE_LIMIT = 12;
const GENERATE_WINDOW_MS = 10 * 60_000;
const EDIT_LIMIT = 60;
const EDIT_WINDOW_MS = 10 * 60_000;

const PlatformSchema = z.enum(["meta", "google"]);
const RangeSchema = z.object({
  start: z.string().refine(isValidDateKey, "Invalid start date"),
  end: z.string().refine(isValidDateKey, "Invalid end date"),
  platform: PlatformSchema.default("meta"),
});

const GenerateSchema = RangeSchema.extend({
  framing: z.enum(FRAMINGS),
}).strict();

const EditSchema = RangeSchema.extend({
  framing: z.enum(FRAMINGS),
  headline: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
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

  const parsed = RangeSchema.safeParse({
    start: req.nextUrl.searchParams.get("start"),
    end: req.nextUrl.searchParams.get("end"),
    platform: req.nextUrl.searchParams.get("platform") ?? "meta",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }

  const { summaries, error } = await listSummaries({
    clientId: client.id,
    platform: parsed.data.platform,
    rangeStart: parsed.data.start,
    rangeEnd: parsed.data.end,
  });

  return NextResponse.json({ summaries, error, configured: summariesConfigured() });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const denied = await agencyGuard();
  if (denied) return denied;

  const { slug } = await ctx.params;
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = GenerateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { start, end, platform, framing } = parsed.data;

  const session = await getSessionUser();
  const actor = session?.userId ?? "unknown";

  /*
   * `.ok` — `rateLimit` returns a result object, which is always truthy.
   * `if (!rateLimit(...))` reads correctly and never fires, and on THIS route
   * that guard is the only thing bounding paid model calls.
   */
  const gate = rateLimit(`summary:gen:${client.id}`, GENERATE_LIMIT, GENERATE_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many summaries generated for this client. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  try {
    /*
     * The dashboard is re-loaded rather than taking figures from the request.
     * A brief assembled from numbers the browser sent would let the prose be
     * built on anything at all, and the allow-list that validates the prose
     * would be built from the same anything.
     */
    const data = await loadDashboard(client, { startKey: start, endKey: end }, platform);
    const brief = buildBrief(data, buildInsights(data));
    const draft = await generateSummary(brief, framing);

    const stored = await saveDraft(
      { clientId: client.id, platform, rangeStart: start, rangeEnd: end },
      draft,
      actor,
    );

    await record({
      action: "summary.generated",
      targetType: "client",
      targetId: client.id,
      clientId: client.id,
      ...requestContext(req),
      metadata: {
        framing,
        platform,
        period: `${start}..${end}`,
        model: draft.model,
        retried: draft.retried,
        // Recorded so "did anything go out with an unverified figure?" is
        // answerable later without re-running the check.
        unverifiedFigures: draft.verification.issues.length,
      },
    });

    return NextResponse.json({ summary: stored, warning: draft.warning });
  } catch (err) {
    if (err instanceof SummaryUnavailable) {
      // 503, not 500: the dashboard is fine, the writing is not available.
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    console.error("[summary] generate failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not generate a summary." },
      { status: 500 },
    );
  }
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

  const parsed = EditSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { start, end, platform, framing, headline, body } = parsed.data;

  const session = await getSessionUser();
  const actor = session?.userId ?? "unknown";

  const editGate = rateLimit(`summary:edit:${client.id}`, EDIT_LIMIT, EDIT_WINDOW_MS);
  if (!editGate.ok) {
    return NextResponse.json(
      { error: "Too many edits. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(editGate.retryAfterMs / 1000)) },
      },
    );
  }

  /*
   * The edited text is re-checked against freshly loaded figures.
   *
   * Keeping the stored verification would be worse than keeping none: it would
   * carry a green flag from the generated draft onto prose a person has since
   * rewritten, which is a claim of having checked something nobody checked.
   */
  let verification = null;
  try {
    const data = await loadDashboard(client, { startKey: start, endKey: end }, platform);
    const brief = buildBrief(data, buildInsights(data));
    verification = verifyFigures(`${headline}\n${body}`, brief.allowed);
  } catch (err) {
    console.error("[summary] could not re-verify edits:", err);
  }

  const stored = await saveEdits(
    { clientId: client.id, platform, rangeStart: start, rangeEnd: end },
    framing,
    { headline, body, verification },
    actor,
  );
  if (!stored) {
    return NextResponse.json(
      { error: "There is no summary for that period to edit." },
      { status: 404 },
    );
  }

  await record({
    action: "summary.edited",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: { framing, platform, period: `${start}..${end}` },
  });

  return NextResponse.json({ summary: stored });
}
