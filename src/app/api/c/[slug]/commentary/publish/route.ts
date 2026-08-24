import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, agencyGuard } from "@/lib/auth";
import { getClientForSession } from "@/lib/clients";
import { record, requestContext } from "@/lib/audit";
import { isValidMonthKey } from "@/lib/commentary/model";
import { publishCommentary, unpublishCommentary } from "@/lib/commentary/store";

/**
 * The one endpoint that can put a month's commentary in front of a client.
 *
 * 🔴 Its own file, deliberately — the same shape as `summary/publish`. Writing
 * commentary lives at a different URL, calls a different store function, and
 * cannot reach these columns. Somebody reading the route tree can see which
 * single handler crosses the line.
 *
 * The request carries no prose. It names a month; what gets published is
 * whatever is stored, which is whatever was on screen when the person clicked.
 * There is no way to publish words that were never reviewed.
 *
 * ── What publishing a month actually commits to ─────────────────────────
 *
 * More than the text. A published plan is what NEXT month's report will hold
 * the agency to — `getCommentary` and `getPublishedMonths` both read the prior
 * month's *published* commitments and nothing else. Pressing this button is
 * what converts a private intention into a promise on the record.
 */

const Schema = z
  .object({
    month: z.string().refine(isValidMonthKey, "Invalid month"),
    platform: z.enum(["meta", "google"]).default("meta"),
    /** `false` withdraws, leaving the working copy alone. */
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
  const { month, platform, published } = parsed.data;

  const session = await getSessionUser();
  const actor = session?.userId ?? "unknown";
  const key = { clientId: client.id, platform, month };

  let stored;
  try {
    stored = published
      ? await publishCommentary(key, actor)
      : await unpublishCommentary(key);
  } catch (err) {
    console.error("[commentary] publish failed:", err);
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
      { error: "Nothing has been written for that month yet." },
      { status: 404 },
    );
  }

  await record({
    /*
     * A distinct action from `commentary.saved`, so the audit log answers "who
     * put this in front of the client" separately from "who wrote it". On a
     * feature whose whole purpose is accountability, that distinction should
     * itself be on the record.
     */
    action: published ? "commentary.published" : "commentary.withdrawn",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    ...requestContext(req),
    metadata: {
      month,
      platform,
      commitments: stored.published?.commitments.length ?? 0,
      withTargets:
        stored.published?.commitments.filter((c) => c.target !== null).length ?? 0,
    },
  });

  return NextResponse.json({ commentary: stored });
}
