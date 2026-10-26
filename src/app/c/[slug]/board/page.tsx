import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import type { CSSProperties } from "react";
import { getClientForSession } from "@/lib/clients";
import { getSessionUser, canAccessSlug, isAgencyOperator } from "@/lib/auth";
import { refreshIfStale } from "@/lib/meta/sync";
import { refreshGoogleIfStale } from "@/lib/google/sync";
import { refreshTiktokIfStale } from "@/lib/tiktok/sync";
import { rangeLabel, todayKey } from "@/lib/dates";
import {
  carriedRange,
  comparisonBasis,
  parseRangeParams,
  rangeQuery,
  withRange,
} from "@/lib/dashboard/range";
import { accentFor } from "@/lib/branding";
import { loadBoardContext } from "@/lib/board/context";
import { getBoard, type StoredBoard } from "@/lib/board/store";
import { loadBoardData } from "@/lib/board/aggregate";
import { leadPlatforms } from "@/lib/board/leads";
import { leadFilterDescription } from "@/lib/metrics/lead-filter-copy";
import { PLATFORM_LABEL } from "@/lib/platforms";
import { ClientSideNav } from "@/components/ClientSideNav";
import { SyncIndicator } from "@/components/SyncIndicator";
import { DateRangePicker } from "@/components/DateRangePicker";
import { ShareReport } from "@/components/ShareReport";
import { DataState, PipeNotice } from "@/components/DataState";
import { Icon } from "@/components/Icon";
import { BoardGrid } from "@/components/board/BoardGrid";
import { DownloadPdfButton } from "@/components/report/DownloadPdfButton";
import { isPdfConfigured } from "@/lib/report/pdf";
import { StatsProvider } from "@/components/board/StatsContext";

export const dynamic = "force-dynamic";

/**
 * The Board: one client's widget canvas, read-only.
 *
 * The Overview's prologue, in the same order and for the same reasons — a
 * scoped read that 404s another agency's slug, then the grant check, then the
 * background refresh — and then one board instead of thirty sections. Every
 * number comes from `loadBoardData`, which reuses the Overview's own queries,
 * so a tile here and the matching tile there agree.
 *
 * Editing is a separate page (`./edit`), so reading a board ships no drag code.
 */
export default async function ClientBoardPage({
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
  const staff = isAgencyOperator(session);

  // Same stale-while-revalidate as the Overview: never blocks this render.
  after(async () => {
    await Promise.allSettled([
      refreshIfStale(client),
      refreshGoogleIfStale(client),
      refreshTiktokIfStale(client),
    ]);
  });

  // Capped like a preset: the board runs a query per widget, and a hand-typed
  // ten-year range would fan every one of them out across a decade of rows.
  const window = parseRangeParams(sp, client.timezone, { clampExplicit: true });
  const basis = comparisonBasis(window, client.timezone);
  const range = { start: window.startKey, end: window.endKey };
  // Reports take the period as dates; the board's own pages keep the picker's.
  const carried = rangeQuery(window);
  const kept = carriedRange(sp);

  const context = await loadBoardContext(client);
  const board = await getBoard(client.id, context.starter);
  const data = await loadBoardData(
    {
      client,
      window,
      mode: "page",
      connections: context.connections,
      assets: {
        logoSrc: context.branding.hasLogo
          ? `/api/c/${slug}/branding/logo?v=${context.branding.logoVersion}`
          : null,
        brandName: context.brandName,
      },
      registry: context.registry,
    },
    board.widgets,
  );

  const { branding, brandName } = context;
  const accent = accentFor(client.id, branding);
  const accentVars = {
    "--accent": accent.color,
    "--accent-glow": accent.glow,
  } as CSSProperties;

  // The lock binds the client only; staff set it, so staff can always edit.
  const canEdit = staff || !board.locked;
  const editHref = withRange(`/c/${slug}/board/edit`, kept);
  const leads = leadPlatforms(board.widgets, context.registry);
  const leadFilter = { mode: client.paidLeadFilter, tag: client.paidLeadTag };

  return (
    <div
      className="flex min-h-full flex-1 flex-col gap-3 lg:flex-row lg:gap-5 lg:p-5"
      style={accentVars}
    >
      <ClientSideNav
        slug={slug}
        brandName={brandName}
        session={session}
        staff={staff}
        brandingEditable={branding.clientEditable}
        boardHref={withRange(`/c/${slug}/board`, kept)}
        reportHref={`/c/${slug}/report?${carried}`}
        presentHref={`/c/${slug}/present?${carried}`}
      />

      <div className="app-frame flex min-w-0 flex-1 flex-col">
        <header className="glass-bar sticky top-0 z-10">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3.5 sm:px-6">
            {/* `basis-[15rem]`, as on the Overview: the name keeps its line. */}
            <div className="flex min-w-0 flex-1 basis-[15rem] items-center gap-3">
              {branding.hasLogo ? (
                // A per-tenant, access-controlled route whose bytes change on
                // upload — the Overview header's reason for a plain <img>.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/c/${slug}/branding/logo?v=${branding.logoVersion}`}
                  alt={brandName}
                  className="h-9 w-auto max-w-[160px] shrink-0 object-contain"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] text-[15px] font-bold text-white"
                  style={{
                    background:
                      "linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 50%, #0d1b30) 100%)",
                    boxShadow:
                      "0 2px 10px -2px color-mix(in srgb, var(--accent) 55%, transparent), inset 0 1px 0 rgba(255,255,255,0.25)",
                  }}
                >
                  {brandName.trim().charAt(0).toUpperCase() || "•"}
                </div>
              )}
              <div className="min-w-0">
                <Link
                  href={withRange(`/c/${slug}`, kept)}
                  title="Back to the Overview"
                  className="mb-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80"
                  style={{
                    color: "var(--text-secondary)",
                    borderColor: "var(--border-strong)",
                    background: "var(--surface-2)",
                  }}
                >
                  <Icon name="arrowLeft" size={12} /> Overview
                </Link>
                <div className="flex min-w-0 items-baseline gap-2.5">
                  <h1
                    className="min-w-0 truncate text-[17px] leading-tight font-semibold"
                    style={{ color: "var(--text-primary)", letterSpacing: "-0.012em" }}
                  >
                    {brandName} <span style={{ color: "var(--text-muted)" }}>· Board</span>
                  </h1>
                  {/* Every platform the client has, not Meta's column alone —
                      see `BoardContext.syncedAt`. */}
                  <SyncIndicator syncedAt={context.syncedAt?.toISOString() ?? null} />
                </div>
              </div>
            </div>

            <div className="flex max-w-full min-w-0 flex-[0_1_auto] flex-wrap items-center justify-end gap-2">
              <DateRangePicker currentLabel={rangeLabel(window.startKey, window.endKey)} />
              {board.locked && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium"
                  style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}
                  title={
                    staff
                      ? "The client can view this board but not change it."
                      : "Your agency has fixed this board's layout."
                  }
                >
                  <Icon name="lock" size={12} />
                  {staff ? "Locked for the client" : "Locked by your agency"}
                </span>
              )}
              {/* Staff only, like every share link: publishing figures to whoever
                  holds a URL is the agency's call. */}
              {staff && (
                <ShareReport
                  clientId={client.id}
                  slug={slug}
                  rangeStart={window.startKey}
                  rangeEnd={window.endKey}
                  platform="meta"
                  platforms={[]}
                  today={todayKey(client.timezone)}
                  kind="board"
                />
              )}
              {/* The board as a file, in one click: the same sheets the print
                  view shows and a share link opens. Without a renderer, the
                  print view's Print → Save as PDF makes the same file. */}
              {board.widgets.length > 0 && isPdfConfigured() && (
                <DownloadPdfButton
                  slug={slug}
                  start={window.startKey}
                  end={window.endKey}
                  kind="board"
                  size="header"
                />
              )}
              <Link
                href={`/c/${slug}/board/print?${carried}`}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)]"
                style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
              >
                <Icon name="printer" size={13} />
                Print view
              </Link>
              {canEdit && (
                <Link
                  href={editHref}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)]"
                  style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
                >
                  <Icon name="pencil" size={13} />
                  Edit board
                </Link>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-4 px-4 py-7 sm:px-6">
          {(board.problem || board.dropped > 0 || (!board.customised && canEdit)) && (
            <div className="flex flex-col gap-2">
              <BoardNotices board={board} canEdit={canEdit} />
            </div>
          )}

          {leads.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-sm)] border px-3 py-2 text-xs"
              style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
            >
              {leads.map((p) => (
                <span key={p} style={{ color: "var(--text-secondary)" }}>
                  {leads.length > 1 && (
                    <span className="font-medium">{PLATFORM_LABEL[p]}: </span>
                  )}
                  {leadFilterDescription(p, leadFilter)}
                </span>
              ))}
              {staff && (
                <Link
                  href={`/c/${slug}/setup`}
                  className="ml-auto hover:underline"
                  style={{ color: "var(--text-muted)" }}
                >
                  Change
                </Link>
              )}
            </div>
          )}

          {board.widgets.length === 0 ? (
            <div className="card p-6">
              <DataState
                title="This board is empty"
                detail={
                  canEdit
                    ? "Add a widget to start, or reset it to the starter board."
                    : "Your agency has not added anything to it yet."
                }
              />
              {canEdit && (
                <div className="mt-4 flex justify-center">
                  <Link href={editHref} className="btn-accent">
                    <Icon name="plus" size={14} />
                    Add widgets
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <StatsProvider metrics={context.metrics}>
              <BoardGrid widgets={board.widgets} data={data} slug={slug} range={range} basis={basis} />
            </StatsProvider>
          )}
        </main>
      </div>
    </div>
  );
}

function BoardNotices({ board, canEdit }: { board: StoredBoard; canEdit: boolean }) {
  return (
    <>
      {board.problem === "newer_version" && (
        <PipeNotice
          tone="warning"
          title="This board was saved by a newer version of the dashboard"
          detail="The starter board is showing until this page updates. Nothing has been lost."
        />
      )}
      {board.problem === "unreadable" && (
        <PipeNotice
          tone="warning"
          title="The saved board could not be read"
          detail={
            canEdit
              ? "The starter board is showing. Saving a new layout replaces it."
              : "The starter board is showing instead."
          }
        />
      )}
      {board.problem === "unavailable" && (
        <PipeNotice
          tone="warning"
          title="Saved boards cannot be loaded right now"
          detail="The starter board is showing. Try again in a moment."
        />
      )}
      {board.dropped > 0 && (
        <PipeNotice
          tone="warning"
          title={`${board.dropped} widget${board.dropped === 1 ? "" : "s"} could not be shown`}
          detail="They no longer match a stat the dashboard offers, so they were left out."
        />
      )}
      {!board.customised && !board.problem && canEdit && (
        <PipeNotice
          title="This is the starter board"
          detail="Edit it to make it yours. Nothing is saved until you do."
        />
      )}
    </>
  );
}
