import { describe, it, expect } from "vitest";
import {
  BOARD_SCHEMA_VERSION,
  BoardWidgetSchema,
  ClientBoardWriteSchema,
  MAX_WIDGETS,
  StaffBoardWriteSchema,
  WidgetQuerySchema,
  resolveWidgets,
} from "./schema";
import {
  MAX_ENCODED_QUERY,
  decodeWidgetQuery,
  encodeWidgetQuery,
  widgetQueryKey,
  widgetQueryOf,
} from "./query";
import type { BoardWidget, WidgetQuery } from "./types";

const kpi = (id: string, y = 0, x = 0): BoardWidget => ({
  id,
  kind: "kpi",
  platform: "meta",
  metric: "spend",
  x,
  y,
  w: 3,
  h: 3,
});

describe("what a save may contain", () => {
  it("refuses unknown keys on a widget", () => {
    const parsed = BoardWidgetSchema.safeParse({ ...kpi("a1"), colour: "red" });
    expect(parsed.success).toBe(false);
  });

  it("🔴 refuses `locked` from a client, and accepts it from staff", () => {
    expect(ClientBoardWriteSchema.safeParse({ widgets: [kpi("a1")], locked: false }).success).toBe(false);
    expect(StaffBoardWriteSchema.safeParse({ widgets: [kpi("a1")], locked: true }).success).toBe(true);
  });

  it("lets staff change only the lock, but not send nothing", () => {
    expect(StaffBoardWriteSchema.safeParse({ locked: true }).success).toBe(true);
    expect(StaffBoardWriteSchema.safeParse({}).success).toBe(false);
  });

  it("refuses duplicate ids and more than the widget limit", () => {
    expect(ClientBoardWriteSchema.safeParse({ widgets: [kpi("a1"), kpi("a1", 3)] }).success).toBe(false);
    const many = Array.from({ length: MAX_WIDGETS + 1 }, (_, i) => kpi(`w${i}`, i * 3));
    expect(ClientBoardWriteSchema.safeParse({ widgets: many }).success).toBe(false);
  });

  it("refuses a combination the catalogue calls dishonest", () => {
    const pie: WidgetQuery = {
      kind: "category",
      platform: "meta",
      metric: "ctr",
      dimension: "gender",
      form: "pie",
      topN: 6,
    };
    const parsed = WidgetQuerySchema.safeParse(pie);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toMatch(/rate or a cost/);
  });

  it("caps text and titles", () => {
    expect(
      BoardWidgetSchema.safeParse({ id: "t1", kind: "text", text: "x".repeat(2001), size: "body", x: 0, y: 0, w: 6, h: 2 })
        .success,
    ).toBe(false);
    expect(BoardWidgetSchema.safeParse({ ...kpi("a1"), title: "x".repeat(81) }).success).toBe(false);
  });
});

describe("reading what is stored", () => {
  it("keeps the good widgets and drops the rest, without throwing", () => {
    const out = resolveWidgets(
      [kpi("a1"), { kind: "kpi", id: "bad" }, kpi("a1", 3), "junk", kpi("b2", 0, 3)],
      BOARD_SCHEMA_VERSION,
    );
    expect(out.widgets.map((w) => w.id)).toEqual(["a1", "b2"]);
    expect(out.dropped).toBe(3);
    expect(out.problem).toBeNull();
  });

  it("does not guess at a shape written by a newer version", () => {
    const out = resolveWidgets([kpi("a1")], BOARD_SCHEMA_VERSION + 1);
    expect(out.widgets).toEqual([]);
    expect(out.problem).toBe("newer_version");
  });

  it("calls a non-list unreadable", () => {
    expect(resolveWidgets({ widgets: [] }, BOARD_SCHEMA_VERSION).problem).toBe("unreadable");
  });

  it("untangles overlaps from a hand-edited row", () => {
    const out = resolveWidgets([kpi("a1"), kpi("b2")], BOARD_SCHEMA_VERSION);
    const [a, b] = out.widgets;
    expect(a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  });
});

describe("sending a widget to the data API", () => {
  const q: WidgetQuery = {
    kind: "table",
    platform: "meta",
    dimension: "ad",
    metrics: ["impressions", "ctr", "spend"],
    sort: "spend",
    topN: 10,
  };

  it("round-trips through the URL encoding", () => {
    expect(decodeWidgetQuery(encodeWidgetQuery(q))).toEqual(q);
    const text: WidgetQuery = { kind: "text", text: "Ünïcode — fine", size: "body" };
    expect(decodeWidgetQuery(encodeWidgetQuery(text))).toEqual(text);
  });

  it("treats junk and oversized input as nothing", () => {
    expect(decodeWidgetQuery("")).toBeNull();
    expect(decodeWidgetQuery("not base64 !")).toBeNull();
    expect(decodeWidgetQuery("x".repeat(MAX_ENCODED_QUERY + 1))).toBeNull();
    expect(decodeWidgetQuery(encodeWidgetQuery(q).slice(0, 5))).toBeNull();
  });

  it("keys a question the same however its fields are ordered, and ignores the chart form", () => {
    const a: WidgetQuery = { kind: "category", platform: "meta", metric: "spend", dimension: "age", form: "bar", topN: 6 };
    const b = { topN: 6, form: "donut", dimension: "age", metric: "spend", platform: "meta", kind: "category" } as WidgetQuery;
    expect(widgetQueryKey(a)).toBe(widgetQueryKey(b));
  });

  it("strips position and title from a stored widget", () => {
    expect(widgetQueryOf({ ...kpi("a1"), title: "Spend" })).toEqual({ kind: "kpi", platform: "meta", metric: "spend" });
  });
});
