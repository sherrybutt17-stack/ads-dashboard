import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, agencyGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { isValidDateKey } from "@/lib/dates";
import { FRAMINGS } from "@/lib/ai/summary";
import { publishSummary, unpublishSummary } from "@/lib/ai/store";

/**
 * The one endpoint that can put a written summary in front of a client.
 *
 * 🔴 Its own file, deliberately. "Never auto-publish" is enforced three ways,
 * and this is the outermost: generation lives at a different URL, calls a
 * different store function, and cannot reach these columns. Somebody reading
 * the route tree can see which single handler crosses the line.
 *
 * The request carries no prose. It names a period and a framing; the text
 * published is whatever is stored, which is whatever was on screen when the
 * person clicked. There is no way to publish words that were never reviewed.
 */

const Schema = z
  .object({
    start: z.string().refine(isValidDateKey, "Invalid start date"),
    end: z.string().refine(isValidDateKey, "Invalid end date"),
    platform: z.enum(["meta", "google"]).default("meta"),
    framing: z.enum(FRAMINGS),
    /** `false` withdraws a published summary, leaving the working copy alone. */
    published: z.boolean().default(true),
  })
  .strict();

export async function POST(
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

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { start, end, platform, framing, published } = parsed.data;

  const session = await getSessionUser();
  const actor = session?.userId ?? "unknown";
  const period = { clientId: client.id, platform, rangeStart: start, rangeEnd: end };

  let stored;
  try {
    stored = published
      ? await publishSummary(period, framing, actor)
      : await unpublishSummary(period, framing);
  } catch (err) {
    console.error("[summary] publish failed:", err);
    return NextResponse.json(
      {
        error:
          "Could not publish. If this deploy is ahead of its migration, run the database push first.",
      },
      { status: 503 },
    );
  }

  if (!stored) {
    return NextResponse.json(
      { error: "There is no summary for that period to publish." },
      { status: 404 },
    );
  }

  await record({
    /*
     * A distinct action name from `summary.generated`, so the audit log answers
     * "who decided this could go to the client" separately from "who asked a
     * model to draft it". They are different responsibilities and are often
     * different people.
     */
    action: published ? "summary.published" : "summary.withdrawn",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: {
      framing,
      platform,
      period: `${start}..${end}`,
      // Whether the person publishing was looking at a flag when they did.
      unverifiedFigures: stored.verification?.issues.length ?? 0,
    },
  });

  return NextResponse.json({ summary: stored });
}
