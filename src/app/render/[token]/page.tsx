import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getClientUnscoped } from "@/lib/clients";
import { loadDashboard } from "@/lib/metrics/dashboard";
import { getClientBranding, getAgencySettings } from "@/lib/branding-store";
import type { AdPlatform } from "@/lib/metrics/queries";
import { isValidDateKey } from "@/lib/dates";
import { ReportDocument } from "@/components/report/ReportDocument";
import { verifyRenderToken } from "@/lib/report/render-token";
import { parseAdPlatform } from "@/lib/platforms";

export const dynamic = "force-dynamic";

/**
 * The report, for the headless browser that is turning it into a PDF.
 *
 * ── Why this page exists at all ───────────────────────────────────────
 *
 * A hosted renderer fetches a URL of ours with no session cookie, so every
 * other page answers it 401. The signed, 90-second token in the path is what
 * authorises this one fetch — see `lib/report/render-token.ts` for why it is
 * stateless and why that is safe at this TTL.
 *
 * ── It is the same document, minus the toolbar ────────────────────────
 *
 * `ReportDocument` is shared with `/c/[slug]/report` and `/r/[token]`, so the
 * PDF is what staff previewed and what a share-link recipient sees. What
 * differs is the absence of a `toolbar`: a Print button rendered into a PDF is
 * a picture of a button, and the whole reason this path exists is that browser
 * chrome must not appear in the output.
 *
 * ── 🔴 Never indexable, and not only via robots.txt ───────────────────
 *
 * A crawler could not fetch this anyway — it would need a live signed token —
 * but the metadata is declared regardless, because the cost is nothing and the
 * failure mode of getting it wrong is a client's spend in a search index.
 */

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function RenderReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const verified = verifyRenderToken(token);

  /*
   * 🔴 One response for every failure: 404, with no body distinguishing them.
   *
   * The three reasons — malformed, wrong signature, expired — are useful to the
   * caller only if the caller is trying to forge a token, and the API route
   * that mints these never sees a failure because it just signed the thing.
   * `verifyRenderToken` still returns the reason, for tests and for logs.
   */
  if (!verified.ok) notFound();

  const { clientId, start, end, platform: rawPlatform } = verified.claims;

  /*
   * Re-validate the dates even though they arrived inside a signature we
   * trust. The signature proves WE issued them; it does not prove they were
   * well-formed when we did, and these values reach date arithmetic and SQL.
   * A guard that is only correct because of what another file does today is a
   * guard that breaks silently when that file changes.
   */
  if (!isValidDateKey(start) || !isValidDateKey(end) || start > end) notFound();
  // Same as the share page: this renderer is reached only through a verified
  // render token, and runs headless for the PDF pipeline with no session.
  const client = await getClientUnscoped(clientId, "share_token");
  if (!client) notFound();

  const platform: AdPlatform = parseAdPlatform(rawPlatform);
  const [data, branding, agency] = await Promise.all([
    loadDashboard(client, { startKey: start, endKey: end }, platform),
    getClientBranding(client.id),
    // Branding follows the client's OWNER, not the viewer: a report is signed
    // by the agency whose client it is, wherever it is being read from.
    getAgencySettings(client.agencyId),
  ]);

  return (
    <ReportDocument
      client={client}
      branding={branding}
      agency={agency}
      data={data}
      platform={platform}
      rangeStart={start}
      rangeEnd={end}
    />
  );
}
