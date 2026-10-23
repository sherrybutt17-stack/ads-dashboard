import type { Client } from "@/db/schema";
import type { ClientBranding } from "@/lib/branding";
import { getAgencySettings, getClientLogoDataUri, type AgencySettings } from "@/lib/branding-store";
import type { DateWindow } from "@/lib/dates";
import { loadBoardData, type BoardMode } from "./aggregate";
import { loadBoardContext } from "./context";
import { getBoard } from "./store";
import type { BoardData, BoardWidget } from "./types";

export interface BoardDocumentData {
  widgets: BoardWidget[];
  data: BoardData;
  branding: ClientBranding;
  agency: AgencySettings;
  /** The client's logo as a data URI, or null. */
  logo: string | null;
}

/**
 * Everything a board document needs, for the print view, the PDF and a share
 * link alike.
 *
 * `source` is where the widgets come from: the board as stored now (the print
 * view and the PDF), or a snapshot frozen into a share link. Never a request
 * body — what a document shows is decided on the server.
 *
 * The client's logo is read once, as a data URI, and used twice: in the sheet
 * header and for any logo widget. The asset route that the board page links
 * to needs a session; a share link's reader and the PDF renderer have none.
 */
export async function loadBoardDocument(
  client: Client,
  window: DateWindow,
  mode: BoardMode,
  source: "stored" | { snapshot: readonly BoardWidget[] },
): Promise<BoardDocumentData> {
  const context = await loadBoardContext(client);
  const [widgets, logo, agency] = await Promise.all([
    source === "stored"
      ? getBoard(client.id, context.starter).then((b) => b.widgets)
      : Promise.resolve([...source.snapshot]),
    context.branding.hasLogo ? getClientLogoDataUri(client.id) : Promise.resolve(null),
    // Signed by the agency whose client this is, wherever it is read from.
    getAgencySettings(client.agencyId),
  ]);
  const data = await loadBoardData(
    {
      client,
      window,
      mode,
      connections: context.connections,
      assets: { logoSrc: logo, brandName: context.brandName },
    },
    widgets,
  );
  return { widgets, data, branding: context.branding, agency, logo };
}

/** Whether a board asks Meta for reach — one question per range, worth asking before a render. */
export function needsReach(widgets: readonly BoardWidget[]): boolean {
  return widgets.some((w) => w.kind === "kpi" && (w.metric === "reach" || w.metric === "frequency"));
}
