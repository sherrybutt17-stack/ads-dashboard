import { describe, it, expect } from "vitest";
import { parseSnapshot, toSnapshot } from "./snapshot";
import { customId, type CustomMetric } from "./registry";
import type { BoardWidget } from "./types";

/**
 * A share link freezes the agency metrics its widgets name, as they were when
 * the link was made: an edit, a rename or a deletion in Settings → Metrics
 * must never change a link already in someone's inbox.
 */

const metric = (n: number, over: Partial<CustomMetric> = {}): CustomMetric => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  kind: "formula",
  platform: "meta",
  baseMetric: null,
  expression: [{ t: "stat", id: "spend" }, { t: "op", v: "/" }, { t: "stat", id: "clicks" }],
  label: `Metric ${n}`,
  description: null,
  format: "currency",
  polarity: "lower-better",
  archived: false,
  ...over,
});

const used = metric(1);
const unused = metric(2);
const widgets: BoardWidget[] = [
  { id: "w-a", kind: "kpi", platform: "meta", metric: customId(used), x: 0, y: 0, w: 3, h: 3 },
  { id: "w-b", kind: "kpi", platform: "meta", metric: "spend", x: 3, y: 0, w: 3, h: 3 },
];

describe("a board snapshot", () => {
  it("🔴 freezes the definitions its widgets use, and only those", () => {
    const snap = toSnapshot(widgets, [used, unused]);
    expect(snap.metrics).toEqual([used]);
    // What the link reads back is what was frozen, whatever the agency does next.
    const read = parseSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(read?.metrics).toEqual([used]);
    expect(read?.widgets.map((w) => w.id)).toEqual(["w-a", "w-b"]);
  });

  it("carries no metrics key when nothing is custom — older readers see the shape they know", () => {
    expect(toSnapshot([widgets[1]], [used])).not.toHaveProperty("metrics");
    expect(parseSnapshot({ kind: "board", schemaVersion: 1, widgets: [widgets[1]] })?.metrics).toEqual([]);
  });

  it("leaves out a frozen metric that no longer reads, keeping the rest", () => {
    const read = parseSnapshot({
      kind: "board",
      schemaVersion: 1,
      widgets,
      metrics: [used, { ...unused, id: "not-a-uuid" }, "junk"],
    });
    expect(read?.metrics).toEqual([used]);
  });
});
