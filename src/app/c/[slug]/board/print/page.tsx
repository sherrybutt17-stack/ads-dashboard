import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getClientForSession } from "@/lib/clients";
import { getSessionUser, canAccessSlug } from "@/lib/auth";
import { carriedRange, parseRangeParams, withRange } from "@/lib/dashboard/range";
import { loadBoardDocument } from "@/lib/board/document";
import { isPdfConfigured } from "@/lib/report/pdf";
import { BoardDocument, PAGE_W } from "@/components/board/BoardDocument";
import { PrintButton } from "@/components/report/PrintButton";
import { DownloadPdfButton } from "@/components/report/DownloadPdfButton";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";

/**
 * The board as it prints: landscape sheets, the board's current layout, the
 * range from the URL.
 *
 * The same document the PDF renderer captures and a share link opens, so what
 * is previewed here is what is sent. Reach is left to load on the page (the
 * widget asks for it) rather than holding the render; the PDF route warms it
 * before the renderer arrives, and a share link reads only what is cached.
 *
 * The PDF button appears only where a renderer is configured. Without one,
 * Print → Save as PDF from this page produces the same sheets.
 */
export default async function BoardPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const session = await getSessionUser();
  const client = await getClientForSession(session, slug);
  if (!client) notFound();
  if (!canAccessSlug(session, slug)) redirect("/");

  const window = parseRangeParams(sp, client.timezone, { clampExplicit: true });
  const doc = await loadBoardDocument(client, window, "page", "stored");

  return (
    <BoardDocument
      client={client}
      branding={doc.branding}
      agency={doc.agency}
      logo={doc.logo}
      widgets={doc.widgets}
      data={doc.data}
        metrics={doc.metrics}
      rangeStart={window.startKey}
      rangeEnd={window.endKey}
      toolbar={
        <div
          className="no-print mx-auto flex flex-wrap items-center justify-between gap-3 px-4 pt-6"
          style={{ maxWidth: PAGE_W + 32 }}
        >
          <Link
            href={withRange(`/c/${slug}/board`, carriedRange(sp))}
            className="inline-flex items-center gap-1 text-[12px] hover:underline"
            style={{ color: "var(--text-muted)" }}
          >
            <Icon name="arrowLeft" size={12} /> Back to the board
          </Link>
          <span className="flex flex-wrap items-center gap-2">
            {isPdfConfigured() && (
              <DownloadPdfButton slug={slug} start={window.startKey} end={window.endKey} kind="board" />
            )}
            <PrintButton />
          </span>
        </div>
      }
    />
  );
}
