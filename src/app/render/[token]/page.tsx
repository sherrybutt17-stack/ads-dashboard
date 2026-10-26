import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getClientUnscoped } from "@/lib/clients";
import { loadDashboard, loadDeferredTables } from "@/lib/metrics/dashboard";
import { getClientBranding, getAgencySettings } from "@/lib/branding-store";
import type { AdPlatform } from "@/lib/metrics/queries";
import { isValidDateKey, windowFromKeys } from "@/lib/dates";
import { ReportDocument } from "@/components/report/ReportDocument";
import { DatasetDocument } from "@/components/report/DatasetDocument";
import { BoardDocument } from "@/components/board/BoardDocument";
import { loadBoardDocument } from "@/lib/board/document";
import {
  DATASETS,
  DATASET_BUILDERS,
  DATASET_ROW_CAP,
  isDatasetId,
} from "@/lib/export/datasets";
import { verifyRenderToken } from "@/lib/report/render-token";
import { DEFAULT_VIEW, decodeView } from "@/lib/report/view";
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

  const {
    clientId,
    start,
    end,
    platform: rawPlatform,
    dataset,
    view: rawView,
  } = verified.claims;

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

  /*
   * The board, as stored when the renderer arrives. Checked before the dataset
   * branch: "board" is not a dataset, and `isDatasetId` would 404 it.
   *
   * "document" mode reads reach from the cache only — this page is reached by
   * a token, not a session, and must never make a Meta call. The PDF route
   * fetched reach for the range just before minting the token.
   */
  if (dataset === "board") {
    const doc = await loadBoardDocument(client, windowFromKeys(start, end, client.timezone), "document", "stored");
    return (
      <BoardDocument
        client={client}
        branding={doc.branding}
        agency={doc.agency}
        logo={doc.logo}
        widgets={doc.widgets}
        data={doc.data}
        metrics={doc.metrics}
        syncedAt={doc.syncedAt}
        rangeStart={start}
        rangeEnd={end}
      />
    );
  }

  /*
   * Two documents behind one route.
   *
   * `"report"` is the narrative document; anything else names a single
   * dataset. Kept on one path rather than adding `/render/d/[dataset]/[token]`
   * because a second public prefix buys nothing and would put the dataset
   * outside the signature — which is the whole point of it being a claim.
   *
   * `isDatasetId` guards it even though the value arrived inside a signature we
   * trust: the signature proves WE issued the claim, not that the string is
   * still a dataset this build knows how to render. A removed dataset would
   * otherwise reach `DATASET_BUILDERS[...]` as undefined.
   */
  if (dataset !== "report") {
    if (!isDatasetId(dataset)) notFound();
    const builder = DATASET_BUILDERS[dataset];
    const meta = DATASETS.find((d) => d.id === dataset);

    const [table, branding] = await Promise.all([
      builder.source === "deferred"
        ? /*
           * `monthly` ignores the range by design, so it loads the same way the
           * export route loads it. The token's start/end carry the derived
           * trailing-12 bounds, and the header prints those rather than
           * implying the picker drove them.
           */
          loadDeferredTables(client, platform).then((t) => builder.build(t))
        : loadDashboard(client, { startKey: start, endKey: end }, platform).then(
            (d) => builder.build(d),
          ),
      getClientBranding(client.id),
    ]);

    const cap = DATASET_ROW_CAP[dataset];
    return (
      <DatasetDocument
        client={client}
        branding={branding}
        table={table}
        datasetLabel={meta?.label ?? dataset}
        datasetDescription={meta?.description ?? ""}
        rangeStart={start}
        rangeEnd={end}
        truncatedAt={cap !== undefined && table.rows.length === cap ? cap : null}
      />
    );
  }

  // Signed into the token with everything else; empty is the standard report.
  const view = decodeView(rawView) ?? DEFAULT_VIEW;
  const [data, branding, agency] = await Promise.all([
    loadDashboard(
      client,
      { startKey: start, endKey: end, sections: new Set(view.sections) },
      platform,
    ),
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
      view={view}
    />
  );
}
