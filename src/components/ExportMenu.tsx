import { DATASETS } from "@/lib/export/datasets";
import { isPdfConfigured } from "@/lib/report/pdf";
import { ExportPanel } from "@/components/ExportPanel";
import type { AdPlatform } from "@/lib/platforms";

/**
 * Download the numbers.
 *
 * A server component that decides what may be offered, wrapped around the
 * client popover that offers it:
 *
 *   · Datasets are filtered HERE, on the server. The dataset registry lives
 *     beside the schema-aware export builders, and none of that belongs in a
 *     browser bundle (see `client-bundle.test.ts`).
 *   · PDF is offered only when this deployment can render one. Without
 *     `PDF_RENDER_KEY` the route answers 501, and a button whose only possible
 *     outcome is an error message is worse than no button; the panel points at
 *     the report's Print instead.
 */
export function ExportMenu({
  slug,
  start,
  end,
  platform,
  platforms,
  today,
  staff,
}: {
  slug: string;
  start: string;
  end: string;
  platform: AdPlatform;
  /** Platforms this client has connected — the panel offers a choice of them. */
  platforms: readonly AdPlatform[];
  /** Today's date key in the client's timezone. */
  today: string;
  /**
   * Agency staff see every dataset; a client-role viewer does not see the ones
   * carrying lead names. This hides them — the route REFUSES them, which is the
   * check that actually holds.
   */
  staff: boolean;
}) {
  const datasets = DATASETS.filter((d) => staff || !d.personal).map((d) => ({
    id: d.id,
    label: d.label,
    description: d.description,
    personal: d.personal,
  }));

  return (
    <ExportPanel
      slug={slug}
      screen={{ start, end, platform }}
      today={today}
      platforms={platforms.length > 0 ? platforms : [platform]}
      datasets={datasets}
      pdfEnabled={isPdfConfigured()}
      staff={staff}
    />
  );
}
