import { notFound, redirect } from "next/navigation";
import { getClientForSession } from "@/lib/clients";
import { getSessionUser, canAccessSlug, isAgencyOperator } from "@/lib/auth";
import { loadDashboard } from "@/lib/metrics/dashboard";
import { getClientBranding } from "@/lib/branding-store";
import { loadCommentaryForReport } from "@/lib/commentary/report";
import { monthKeyForDateKey } from "@/lib/commentary/model";
import type { AdPlatform } from "@/lib/metrics/queries";
import { parseAdPlatform } from "@/lib/platforms";
import {
  trailingWindowInclusive,
  isValidDateKey,
  MAX_RANGE_DAYS,
} from "@/lib/dates";
import { buildDeck, clampSlide } from "@/lib/present/slides";
import { DeckView } from "@/components/present/Deck";

export const dynamic = "force-dynamic";

/**
 * Meeting mode — §6.17.
 *
 * The monthly review call is presented by scrolling this dashboard in a browser
 * tab. That means the client reads twenty numbers while the presenter talks
 * about one, and the presenter loses their place on every scroll. This is the
 * same data, one point at a time.
 *
 * ── Why a client-role user may open it ─────────────────────────────────
 *
 * It shows strictly less than `/c/<slug>` already shows them, and there is no
 * lead PII on any slide. `canAccessSlug` is re-checked here against the
 * database rather than trusted from the session token, exactly as the report
 * route does. Only the pre-flight card — which names the slides that were
 * dropped and why — is staff-only, because it is a note to the presenter and
 * not part of the presentation.
 *
 * ── Why the deck is assembled here and not in the client component ─────
 *
 * Nothing may load mid-presentation. A slide that arrives late, spins, or fails
 * in front of a paying client is the one failure mode this feature cannot have,
 * so the whole deck is built on the server and handed over complete.
 */
export default async function PresentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;

  /*
   * Scoped read, then the grant check. `getClientForSession` already applies
   * both the tenant and — for a client-role login — the slug grant, so a
   * client belonging to another agency is `null` here and renders the same
   * 404 as one that does not exist. `canAccessSlug` below is kept as the
   * redirect-to-home behaviour for a signed-in user hitting a slug they do
   * not hold, which is a nicer landing than a bare not-found.
   */
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) notFound();
  const session = await getSessionUser();
  if (!canAccessSlug(session, slug)) redirect("/");

  const platform: AdPlatform = parseAdPlatform(sp.platform);

  // Same validation as the dashboard and the report: the range arrives from a
  // URL, so junk must be rejected before it reaches date maths or SQL.
  const days = sp.days ? Number(sp.days) : 30;
  const safeDays =
    Number.isFinite(days) && days > 0
      ? Math.min(Math.floor(days), MAX_RANGE_DAYS)
      : 30;
  const valid =
    isValidDateKey(sp.start) &&
    isValidDateKey(sp.end) &&
    (sp.start as string) <= (sp.end as string);
  const range = valid
    ? { startKey: sp.start as string, endKey: sp.end as string }
    : (() => {
        const w = trailingWindowInclusive(safeDays, client.timezone);
        return { startKey: w.startKey, endKey: w.endKey };
      })();

  const [data, branding, commentary] = await Promise.all([
    loadDashboard(client, range, platform),
    getClientBranding(client.id),
    /*
     * PUBLISHED commentary only, as on the report. A draft appearing on a
     * screen share is the same failure as a draft appearing behind a share
     * link, with a larger audience.
     */
    loadCommentaryForReport(client, platform, monthKeyForDateKey(range.endKey)),
  ]);

  const deck = buildDeck(data, {
    brandName: branding.displayName ?? client.name,
    platformLabel: platform === "google" ? "Google" : "Meta",
    commentary,
  });

  const backHref = (() => {
    const qs = new URLSearchParams();
    if (valid) {
      qs.set("start", range.startKey);
      qs.set("end", range.endKey);
    } else if (sp.days) {
      qs.set("days", String(safeDays));
    }
    if (platform !== "meta") qs.set("platform", platform);
    const s = qs.toString();
    return s ? `/c/${slug}?${s}` : `/c/${slug}`;
  })();

  return (
    <DeckView
      deck={deck}
      slug={slug}
      backHref={backHref}
      initialSlide={clampSlide(Number(sp.slide ?? 0), deck.slides.length)}
      staff={isAgencyOperator(session)}
    />
  );
}
