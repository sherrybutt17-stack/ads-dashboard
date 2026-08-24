import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getClientForSession } from "@/lib/clients";
import { getSessionUser, canAccessSlug } from "@/lib/auth";
import { loadDashboard } from "@/lib/metrics/dashboard";
import { getClientBranding, getAgencySettings } from "@/lib/branding-store";
import type { AdPlatform } from "@/lib/metrics/queries";
import { parseAdPlatform } from "@/lib/platforms";
import {
  trailingWindowInclusive,
  isValidDateKey,
  MAX_RANGE_DAYS,
} from "@/lib/dates";
import { ReportDocument, REPORT_WIDTH } from "@/components/report/ReportDocument";
import { PrintButton } from "@/components/report/PrintButton";
import { DownloadPdfButton } from "@/components/report/DownloadPdfButton";
import { isPdfConfigured } from "@/lib/report/pdf";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";

/**
 * The report, for someone who IS logged in.
 *
 * Same component as the share link renders, deliberately — so what staff see
 * when they check a report before sending it is byte-for-byte what the
 * recipient will see. A preview that differs from the thing it previews is
 * worse than no preview: it manufactures confidence rather than checking it.
 *
 * Client-role users reach their own report through the proxy's existing
 * `/c/<slug>` rule; `canAccessSlug` re-checks it here against the database.
 */
export default async function ReportPage({
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
  if (!canAccessSlug(await getSessionUser(), slug)) redirect("/");

  const platform: AdPlatform = parseAdPlatform(sp.platform);

  // Same validation as the dashboard: the range arrives from a URL, so junk
  // must be rejected before it reaches date maths or SQL.
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

  const [data, branding, agency] = await Promise.all([
    loadDashboard(client, range, platform),
    getClientBranding(client.id),
    // Branding follows the client's OWNER, not the viewer: a report is signed
    // by the agency whose client it is, wherever it is being read from.
    getAgencySettings(client.agencyId),
  ]);

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
    <ReportDocument
      client={client}
      branding={branding}
      agency={agency}
      data={data}
      platform={platform}
      rangeStart={range.startKey}
      rangeEnd={range.endKey}
      toolbar={
        <div
          className="no-print mx-auto flex flex-wrap items-center justify-between gap-3 px-4 pt-6"
          style={{ maxWidth: REPORT_WIDTH }}
        >
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-[12px] hover:underline"
            style={{ color: "var(--text-muted)" }}
          >
            <Icon name="arrowLeft" size={12} /> Back to dashboard
          </Link>
          <span className="flex flex-wrap items-center gap-2">
            {/*
              Server-rendered PDF first, print second — the ordering IS the
              recommendation. Print stamps the source URL into every page
              margin unless the reader happens to have unticked a checkbox they
              have no reason to know about; this one has no browser chrome to
              stamp. Both stay, because a render service can be down or out of
              credits and a report you cannot get off the screen is worse than
              one with a footer.
            */}
            {isPdfConfigured() && (
              <DownloadPdfButton
                slug={slug}
                start={range.startKey}
                end={range.endKey}
                platform={platform}
              />
            )}
            <PrintButton />
          </span>
        </div>
      }
    />
  );
}
