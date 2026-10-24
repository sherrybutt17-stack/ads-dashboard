"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Icon } from "@/components/Icon";
import { MAX_WIDGETS, WIDGET_KINDS, defaultTitle } from "@/lib/board/catalog";
import { BOARD_COLS, firstFreeSlot, limitsFor, moveBy, normalizeLayout, resizeBy } from "@/lib/board/grid";
import { encodeWidgetQuery, widgetQueryKey, widgetQueryOf } from "@/lib/board/query";
import type { BoardData, BoardWidget, WidgetBox, WidgetData, WidgetQuery } from "@/lib/board/types";
import type { AdPlatform } from "@/lib/platforms";
import { BoardWidget as WidgetCard } from "./BoardWidget";
import { WidgetMenu, type WidgetAction } from "./WidgetMenu";
import { WidgetPicker, type PickerResult } from "./WidgetPicker";

// The grid library measures the DOM, so it never renders on the server — and it
// loads here only, never on the board a client opens to read.
const BoardCanvasRgl = dynamic(() => import("./BoardCanvasRgl"), {
  ssr: false,
  loading: () => <div className="skeleton h-[480px] w-full rounded-[var(--radius-xl)]" />,
});

const LOADING: WidgetData = { kind: "pending", reason: "load" };
const TEXT: WidgetData = { kind: "text" };
const HINT_ID = "board-move-hint";

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

function newId(): string {
  return `w-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function titleOf(w: BoardWidget): string {
  return w.title?.trim() || defaultTitle(widgetQueryOf(w));
}

/** A widget with its query replaced, keeping its id, place and size. */
function withQuery(w: BoardWidget, q: WidgetQuery, title: string | undefined): BoardWidget {
  return { ...q, id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, ...(title ? { title } : {}) } as BoardWidget;
}

/**
 * The board editor: a draft of the board, arranged on the grid, saved as one.
 *
 * Nothing touches the stored board until Save. The draft carries the
 * `updatedAt` it started from, and the save sends it back
 * (`ifUnmodifiedSince`, or `expectNew` for a first save) — so if the agency and
 * the client both had the editor open, the second save is refused with a 409
 * and a way to load the other version, instead of silently replacing it.
 *
 * Numbers are fetched only from event handlers — adding a widget, changing
 * one — and cached by question, so dragging, resizing or duplicating never
 * asks the server again, and switching a bar to a donut reuses what is there.
 *
 * Every arrangement has a keyboard path: the drag handle is a button, arrow
 * keys move and Shift with an arrow resizes, and the widget menu repeats both
 * in words. Each change is announced.
 */
export function BoardEditor({
  slug,
  staff,
  initialWidgets,
  initialData,
  initialLocked,
  updatedAt,
  platforms,
  metaCampaigns,
  range,
  rangeText,
  basis,
  viewHref,
}: {
  slug: string;
  staff: boolean;
  initialWidgets: BoardWidget[];
  initialData: BoardData;
  initialLocked: boolean;
  /** The saved board's version, or null while the starter is showing. */
  updatedAt: string | null;
  /** Connected ad platforms, offered as widget sources. */
  platforms: AdPlatform[];
  /** Meta campaigns a creative-cards widget can be narrowed to. */
  metaCampaigns: Array<{ id: string; name: string | null }>;
  range: { start: string; end: string };
  rangeText: string;
  basis: string;
  viewHref: string;
}) {
  const router = useRouter();
  const [widgets, setWidgets] = useState<BoardWidget[]>(initialWidgets);
  const [locked, setLocked] = useState(initialLocked);
  const [dirty, setDirty] = useState(false);
  const [cache, setCache] = useState<Record<string, WidgetData>>(() => {
    const out: Record<string, WidgetData> = {};
    for (const w of initialWidgets) {
      const d = initialData[w.id];
      if (d) out[widgetQueryKey(widgetQueryOf(w))] = d;
    }
    return out;
  });
  const [picker, setPicker] = useState<{ editing: BoardWidget | null; seq: number } | null>(null);
  const [confirm, setConfirm] = useState<"reset" | "leave" | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [said, setSaid] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const known = useRef(new Set(Object.keys(cache)));
  const seq = useRef(0);

  // Closing the tab with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const ensure = useCallback(
    (q: WidgetQuery) => {
      if (q.kind === "text") return;
      const key = widgetQueryKey(q);
      if (known.current.has(key)) return;
      known.current.add(key);
      const url =
        `/api/c/${encodeURIComponent(slug)}/board/data?w=${encodeWidgetQuery(q)}` +
        `&start=${range.start}&end=${range.end}`;
      fetch(url, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((body: { data?: WidgetData }) => {
          setCache((c) => ({ ...c, [key]: body.data ?? { kind: "unavailable", tone: "problem", title: "No data" } }));
        })
        .catch(() => {
          // Forget it, so the next change to this widget can try again.
          known.current.delete(key);
          setCache((c) => ({
            ...c,
            [key]: { kind: "unavailable", tone: "problem", title: "This widget could not be loaded" },
          }));
        });
    },
    [slug, range.start, range.end],
  );

  function dataFor(w: BoardWidget): WidgetData {
    const q = widgetQueryOf(w);
    if (q.kind === "text") return TEXT;
    return cache[widgetQueryKey(q)] ?? LOADING;
  }

  function change(next: BoardWidget[], message: string) {
    setWidgets(next);
    setDirty(true);
    setSaid(message);
  }

  const arrange = useCallback(
    (boxes: WidgetBox[], how: "move" | "resize") => {
      const byId = new Map(boxes.map((b) => [b.id, b]));
      const same = (w: BoardWidget, b: WidgetBox | undefined) =>
        !b || (b.x === w.x && b.y === w.y && b.w === w.w && b.h === w.h);
      // A drag that ends where it began is not an edit.
      if (widgets.every((w) => same(w, byId.get(w.id)))) return;
      const next = widgets.map((w) => {
        const b = byId.get(w.id);
        return same(w, b) || !b ? w : { ...w, x: b.x, y: b.y, w: b.w, h: b.h };
      });
      setWidgets(next);
      setDirty(true);
      setSaid(how === "move" ? "Widget moved." : "Widget resized.");
    },
    [widgets],
  );

  function move(w: BoardWidget, dx: number, dy: number) {
    const next = moveBy(widgets, w.id, dx, dy);
    const me = next.find((n) => n.id === w.id)!;
    if (me.x === w.x && me.y === w.y) return setSaid(`${titleOf(w)} cannot move that way.`);
    change(next, `${titleOf(w)} moved to row ${me.y + 1}, column ${me.x + 1}.`);
  }

  function resize(w: BoardWidget, dw: number, dh: number) {
    const next = resizeBy(widgets, w.id, dw, dh);
    const me = next.find((n) => n.id === w.id)!;
    if (me.w === w.w && me.h === w.h) return setSaid(`${titleOf(w)} is already at that limit.`);
    change(next, `${titleOf(w)} is now ${me.w} columns wide and ${me.h} rows tall.`);
  }

  function onHandleKey(e: KeyboardEvent<HTMLButtonElement>, w: BoardWidget) {
    const step = ARROWS[e.key];
    if (!step) return;
    e.preventDefault();
    if (e.shiftKey) resize(w, step[0], step[1]);
    else move(w, step[0], step[1]);
  }

  function act(action: WidgetAction, w: BoardWidget) {
    const title = titleOf(w);
    switch (action) {
      case "settings":
        seq.current += 1;
        return setPicker({ editing: w, seq: seq.current });
      case "duplicate": {
        if (widgets.length >= MAX_WIDGETS) return setSaid(`A board holds at most ${MAX_WIDGETS} widgets.`);
        const slot = firstFreeSlot(widgets, w.w, w.h);
        const copy = { ...w, id: newId(), x: slot.x, y: slot.y };
        return change(normalizeLayout([...widgets, copy]), `Duplicated ${title}.`);
      }
      case "up":
        return move(w, 0, -1);
      case "down":
        return move(w, 0, 1);
      case "left":
        return move(w, -1, 0);
      case "right":
        return move(w, 1, 0);
      case "wider":
        return resize(w, 1, 0);
      case "narrower":
        return resize(w, -1, 0);
      case "taller":
        return resize(w, 0, 1);
      case "shorter":
        return resize(w, 0, -1);
      case "remove":
        change(
          widgets.filter((x) => x.id !== w.id),
          `Removed ${title}.`,
        );
        // Its own buttons are gone; give focus somewhere that still exists.
        addButton.current?.focus();
        return;
    }
  }

  function disabledFor(w: BoardWidget): Partial<Record<WidgetAction, boolean>> {
    const { min, max } = limitsFor(w.kind);
    return {
      duplicate: widgets.length >= MAX_WIDGETS,
      up: w.y === 0,
      left: w.x === 0,
      right: w.x + w.w >= BOARD_COLS,
      wider: w.w >= Math.min(max.w, BOARD_COLS - w.x),
      narrower: w.w <= min.w,
      taller: w.h >= max.h,
      shorter: w.h <= min.h,
    };
  }

  function onPicked(r: PickerResult) {
    const editing = picker?.editing ?? null;
    setPicker(null);
    if (r.query.kind !== "text") {
      const key = widgetQueryKey(r.query);
      const data = r.data;
      if (data && data.kind !== "pending") {
        known.current.add(key);
        setCache((c) => ({ ...c, [key]: data }));
      } else {
        ensure(r.query);
      }
    }
    if (editing) {
      const next = normalizeLayout(widgets.map((w) => (w.id === editing.id ? withQuery(w, r.query, r.title) : w)));
      change(next, `Updated ${titleOf(next.find((w) => w.id === editing.id)!)}.`);
      return;
    }
    const size = r.size ?? WIDGET_KINDS[r.query.kind].size;
    const slot = firstFreeSlot(widgets, size.w, size.h);
    const id = newId();
    const added = { ...r.query, id, x: slot.x, y: slot.y, w: size.w, h: size.h, ...(r.title ? { title: r.title } : {}) } as BoardWidget;
    change(normalizeLayout([...widgets, added]), `Added ${titleOf(added)}.`);
    // Show where it landed — a slot freed higher up is easy to miss.
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.querySelector<HTMLButtonElement>(".board-drag-handle")?.focus({ preventScroll: true });
    }, 120);
  }

  async function save() {
    setStatus({ kind: "saving" });
    const body = {
      widgets,
      ...(updatedAt ? { ifUnmodifiedSince: updatedAt } : { expectNew: true }),
      ...(staff && locked !== initialLocked ? { locked } : {}),
    };
    try {
      const res = await fetch(`/api/c/${encodeURIComponent(slug)}/board`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setDirty(false);
        router.push(viewHref);
        return;
      }
      if (res.status === 409) return setStatus({ kind: "conflict" });
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setStatus({ kind: "error", message: err?.error ?? "The board could not be saved. Try again." });
    } catch {
      setStatus({ kind: "error", message: "The board could not be saved — check your connection and try again." });
    }
  }

  async function reset() {
    setConfirm(null);
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(`/api/c/${encodeURIComponent(slug)}/board`, { method: "DELETE" });
      if (res.ok) {
        setDirty(false);
        router.push(viewHref);
        return;
      }
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setStatus({ kind: "error", message: err?.error ?? "The board could not be reset." });
    } catch {
      setStatus({ kind: "error", message: "The board could not be reset — check your connection." });
    }
  }

  function leave(e: MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return;
    e.preventDefault();
    setConfirm("leave");
  }

  function openPicker() {
    seq.current += 1;
    setPicker({ editing: null, seq: seq.current });
  }

  const saving = status.kind === "saving";
  const full = widgets.length >= MAX_WIDGETS;
  const showPlatform = new Set(widgets.flatMap((w) => ("platform" in w ? [w.platform] : []))).size > 1;

  return (
    <>
      <header className="glass-bar sticky top-0 z-10">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3.5 sm:px-6">
          <div className="flex min-w-0 flex-1 basis-[15rem] flex-col items-start gap-1">
            <Link
              href={viewHref}
              onClick={leave}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80"
              style={{
                color: "var(--text-secondary)",
                borderColor: "var(--border-strong)",
                background: "var(--surface-2)",
              }}
            >
              <Icon name="arrowLeft" size={12} /> Board
            </Link>
            <h1
              className="min-w-0 truncate text-[17px] leading-tight font-semibold"
              style={{ color: "var(--text-primary)", letterSpacing: "-0.012em" }}
            >
              Editing board{" "}
              <span className="text-[13px] font-normal" style={{ color: "var(--text-muted)" }}>
                · numbers for {rangeText}
              </span>
            </h1>
          </div>

          <div className="flex max-w-full min-w-0 flex-[0_1_auto] flex-wrap items-center justify-end gap-2">
            {staff && (
              <label
                className="mr-1 inline-flex items-center gap-2 text-[12.5px]"
                style={{ color: "var(--text-secondary)" }}
                title="When this is off, the client sees the board but cannot change it."
              >
                <input
                  type="checkbox"
                  checked={!locked}
                  onChange={(e) => {
                    setLocked(!e.target.checked);
                    setDirty(true);
                    setSaid(e.target.checked ? "The client will be able to edit this board." : "The board will be locked for the client.");
                  }}
                />
                Client can edit
              </label>
            )}
            <button
              type="button"
              onClick={() => setConfirm("reset")}
              disabled={saving}
              className="btn-ghost rounded-[var(--radius-sm)] px-3 py-2 text-[13px]"
            >
              Reset
            </button>
            <button
              ref={addButton}
              type="button"
              onClick={openPicker}
              disabled={full || saving}
              title={full ? `A board holds at most ${MAX_WIDGETS} widgets.` : undefined}
              className="btn-ghost inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-2 text-[13px]"
            >
              <Icon name="plus" size={13} />
              Add widget
            </button>
            <Link
              href={viewHref}
              onClick={leave}
              className="btn-ghost rounded-[var(--radius-sm)] px-3 py-2 text-[13px]"
            >
              Cancel
            </Link>
            <button type="button" onClick={save} disabled={!dirty || saving} className="btn-accent">
              {saving ? "Saving…" : "Save board"}
            </button>
          </div>
        </div>

        {(confirm || status.kind === "conflict" || status.kind === "error") && (
          <div className="mx-auto max-w-[1400px] px-4 pb-3 sm:px-6">
            {confirm === "leave" && (
              <Banner tone="neutral" text="Leave without saving? The changes made here will be lost.">
                <Link href={viewHref} className="btn-ghost rounded-[var(--radius-sm)] px-3 py-1.5 text-[12.5px]">
                  Discard changes
                </Link>
                <button type="button" className="btn-accent" onClick={() => setConfirm(null)}>
                  Keep editing
                </button>
              </Banner>
            )}
            {confirm === "reset" && (
              <Banner
                tone="warning"
                text={`Reset to the starter board? The saved board is deleted for everyone${
                  staff && initialLocked ? ", and the client's lock is removed" : ""
                }.`}
              >
                <button type="button" className="btn-ghost rounded-[var(--radius-sm)] px-3 py-1.5 text-[12.5px]" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
                <button type="button" className="btn-accent" onClick={reset}>
                  Reset board
                </button>
              </Banner>
            )}
            {status.kind === "conflict" && (
              <Banner
                tone="warning"
                text="Someone else saved this board while you were editing. Load their version to carry on — the changes made here will be lost."
              >
                <button type="button" className="btn-accent" onClick={() => router.refresh()}>
                  Load latest
                </button>
              </Banner>
            )}
            {status.kind === "error" && <Banner tone="warning" text={status.message} />}
          </div>
        )}
      </header>

      <main className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-4 px-4 py-7 sm:px-6">
        <div className="card p-6 text-center text-[13.5px] lg:hidden" style={{ color: "var(--text-secondary)" }}>
          Editing needs a wider screen. Open this board on a laptop or desktop to arrange it.{" "}
          <Link href={viewHref} className="underline">
            Back to the board
          </Link>
        </div>

        <div className="hidden lg:block">
          <p id={HINT_ID} className="sr-only">
            Drag the handle to move a widget, or drag its edges to resize it. With the keyboard, focus the
            handle and use the arrow keys to move, or Shift and the arrow keys to resize.
          </p>
          {widgets.length === 0 ? (
            <div
              className="flex flex-col items-center gap-3 rounded-[var(--radius-xl)] border border-dashed px-6 py-16 text-center"
              style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}
            >
              <p className="text-[14px]">This board is empty.</p>
              <button type="button" onClick={openPicker} className="btn-accent">
                <Icon name="plus" size={14} />
                Add a widget
              </button>
            </div>
          ) : (
            <BoardCanvasRgl
              widgets={widgets}
              onArrange={arrange}
              renderItem={(w) => {
                const title = titleOf(w);
                return (
                  <div className="group relative h-full" data-widget-id={w.id}>
                    <WidgetCard
                      key={widgetQueryKey(widgetQueryOf(w))}
                      widget={w}
                      data={dataFor(w)}
                      slug={slug}
                      range={range}
                      basis={basis}
                      showPlatform={showPlatform}
                    />
                    <div className="pointer-events-none absolute top-2 right-2 z-[2] flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        type="button"
                        className="board-drag-handle pointer-events-auto inline-flex h-7 w-7 cursor-grab items-center justify-center rounded-[var(--radius-xs)] border active:cursor-grabbing"
                        aria-label={`Move or resize ${title}`}
                        aria-describedby={HINT_ID}
                        onKeyDown={(e) => onHandleKey(e, w)}
                        style={{
                          background: "var(--surface-raised)",
                          borderColor: "var(--border-strong)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        <Icon name="grip" size={14} />
                      </button>
                      <WidgetMenu title={title} onAction={(a) => act(a, w)} disabled={disabledFor(w)} />
                    </div>
                  </div>
                );
              }}
            />
          )}
        </div>

        <div aria-live="polite" className="sr-only">
          {said}
        </div>
      </main>

      {picker && (
        <WidgetPicker
          key={picker.seq}
          open
          editing={picker.editing}
          platforms={platforms}
          campaigns={metaCampaigns}
          slug={slug}
          range={range}
          basis={basis}
          onClose={() => setPicker(null)}
          onDone={onPicked}
        />
      )}
    </>
  );
}

function Banner({
  tone,
  text,
  children,
}: {
  tone: "neutral" | "warning";
  text: string;
  children?: ReactNode;
}) {
  const color = tone === "warning" ? "var(--status-warning)" : "var(--text-muted)";
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] border px-3 py-2 text-[12.5px]"
      style={{
        borderColor: `color-mix(in srgb, ${color} 45%, var(--border))`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        color: "var(--text-secondary)",
      }}
    >
      <span className="mr-auto">{text}</span>
      {children}
    </div>
  );
}
