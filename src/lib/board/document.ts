import type { Client } from "@/db/schema";
import type { ClientBranding } from "@/lib/branding";
import { getAgencySettings, getClientLogoDataUri, type AgencySettings } from "@/lib/branding-store";
import type { DateWindow } from "@/lib/dates";
import { inlineThumbs } from "@/lib/meta/thumbs";
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
  await inlineCreativeThumbs(client, widgets, data);
  return { widgets, data, branding: context.branding, agency, logo };
}

/** Enough for every card a full-page widget holds, few enough to keep a PDF light. */
const THUMBS_PER_WIDGET = 12;
const THUMBS_PER_DOCUMENT = 36;

/**
 * Creative cards' thumbnails, as data URIs. The thumb route needs a session,
 * which a share link's reader and the PDF renderer do not have — the same
 * reason the logo is inlined. Never asks Meta for fresh URLs: a public view
 * must not spend the account's Graph quota (`inlineThumbs`).
 */
export async function inlineCreativeThumbs(
  client: Pick<Client, "id" | "agencyId">,
  widgets: readonly BoardWidget[],
  data: BoardData,
): Promise<void> {
  const refs: string[] = [];
  for (const w of widgets) {
    const d = data[w.id];
    if (d?.kind !== "creatives") continue;
    let n = 0;
    for (const card of d.cards) {
      if (!card.thumb || !("ref" in card.thumb)) continue;
      if (n >= THUMBS_PER_WIDGET || refs.length >= THUMBS_PER_DOCUMENT) break;
      refs.push(card.thumb.ref);
      n++;
    }
  }
  if (refs.length === 0) return;

  const included = new Set(refs);
  const srcs = await inlineThumbs(client, refs, { max: THUMBS_PER_DOCUMENT });
  for (const w of widgets) {
    const d = data[w.id];
    if (d?.kind !== "creatives") continue;
    let capped = false;
    const cards = d.cards.map((card) => {
      if (!card.thumb || !("ref" in card.thumb)) return card;
      if (!included.has(card.thumb.ref)) capped = true;
      const src = srcs.get(card.thumb.ref);
      return { ...card, thumb: src ? { src } : null };
    });
    const notes = capped
      ? [...(d.notes ?? []), "Some previews were left out to keep this document small."]
      : d.notes;
    data[w.id] = { ...d, cards, notes };
  }
}

/** Whether a board asks Meta for reach — one question per range, worth asking before a render. */
export function needsReach(widgets: readonly BoardWidget[]): boolean {
  return widgets.some((w) => w.kind === "kpi" && (w.metric === "reach" || w.metric === "frequency"));
}
