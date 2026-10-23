import { notFound, redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { getClientForSession } from "@/lib/clients";
import { getSessionUser, canAccessSlug, isAgencyOperator } from "@/lib/auth";
import { rangeLabel } from "@/lib/dates";
import {
  carriedRange,
  comparisonBasis,
  parseRangeParams,
  rangeQuery,
  withRange,
} from "@/lib/dashboard/range";
import { accentFor } from "@/lib/branding";
import { loadBoardContext } from "@/lib/board/context";
import { getBoard } from "@/lib/board/store";
import { loadBoardData } from "@/lib/board/aggregate";
import { AD_PLATFORMS } from "@/lib/platforms";
import { ClientSideNav } from "@/components/ClientSideNav";
import { BoardEditor } from "@/components/board/BoardEditor";

export const dynamic = "force-dynamic";

/**
 * The board editor's page: the same prologue as the board, then the draft.
 *
 * A client opening a board their agency locked is sent back to it — the save
 * route would refuse them anyway (403, checked on the stored row), but an
 * editor whose every change is doomed is a worse answer than no editor.
 *
 * `key` remounts the editor whenever the stored board changes underneath it:
 * after "Load latest" on a conflict, or a reset, the draft starts again from
 * what is actually saved rather than merging into stale state.
 */
export default async function EditBoardPage({
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

  const window = parseRangeParams(sp, client.timezone, { clampExplicit: true });
  const carried = rangeQuery(window);
  const viewHref = withRange(`/c/${slug}/board`, carriedRange(sp));

  const context = await loadBoardContext(client);
  const board = await getBoard(client.id, context.starter);
  if (board.locked && !staff) redirect(viewHref);

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
    },
    board.widgets,
  );

  const { branding, brandName, connections } = context;
  const accent = accentFor(client.id, branding);
  const accentVars = {
    "--accent": accent.color,
    "--accent-glow": accent.glow,
  } as CSSProperties;

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
        boardHref={viewHref}
        reportHref={`/c/${slug}/report?${carried}`}
        presentHref={`/c/${slug}/present?${carried}`}
      />

      <div className="app-frame flex min-w-0 flex-1 flex-col">
        <BoardEditor
          key={board.updatedAt?.toISOString() ?? "starter"}
          slug={slug}
          staff={staff}
          initialWidgets={board.widgets}
          initialData={data}
          initialLocked={board.locked}
          updatedAt={board.updatedAt?.toISOString() ?? null}
          platforms={AD_PLATFORMS.filter((p) => connections[p])}
          range={{ start: window.startKey, end: window.endKey }}
          rangeText={rangeLabel(window.startKey, window.endKey)}
          basis={comparisonBasis(window, client.timezone)}
          viewHref={viewHref}
        />
      </div>
    </div>
  );
}
