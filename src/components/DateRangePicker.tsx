"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { RangeCalendar } from "./RangeCalendar";
import { useDismissOnEscape, Portal } from "./Modal";
import { MAX_RANGE_DAYS } from "@/lib/dates";

/**
 * Date range control — an always-visible segmented control, so changing the
 * window is a single click rather than open-dropdown-then-choose. Custom range
 * lives behind one calendar button that opens a small popover.
 *
 * Range state lives in the URL so a view is shareable and survives reload —
 * "look at the dashboard for last month" should be a link, not instructions.
 */

const PRESETS = [
  { id: "7d", label: "7D", days: 7 },
  { id: "14d", label: "14D", days: 14 },
  { id: "30d", label: "30D", days: 30 },
  { id: "90d", label: "90D", days: 90 },
  { id: "180d", label: "6M", days: 180 },
  // Labelled for what it actually is. This was "All" at 800 days, which the
  // dashboard clamped to MAX_RANGE_DAYS — the segment stayed highlighted while
  // showing a different window than its own label claimed.
  { id: "all", label: "1Y", days: MAX_RANGE_DAYS },
] as const;

export function DateRangePicker({ currentLabel }: { currentLabel: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const calendarTrigger = useRef<HTMLButtonElement>(null);
  /*
   * Where to paint the popover, measured from the trigger.
   *
   * 🔴 The popover CANNOT be positioned by CSS relative to its trigger, because
   * it no longer lives next to it — see the stacking-context note where it is
   * rendered. Portalled to <body>, `absolute right-0` would resolve against the
   * document instead of the button, so the coordinates are taken from the
   * trigger's own rect and re-taken whenever the page moves under it.
   */
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );

  const place = useCallback(() => {
    const el = calendarTrigger.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ top: r.bottom + 8, right: window.innerWidth - r.right });
  }, []);

  // The header is sticky, so scrolling moves the trigger under a popover that
  // would otherwise stay where it was first painted.
  useEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  // Escape shuts the calendar and hands focus back to the button that opened
  // it. Deliberately not a focus trap — a popover you cannot click past is a
  // modal in disguise. `useCallback` keeps the hook's effect from re-binding
  // its listener on every render.
  useDismissOnEscape(
    open,
    useCallback(() => setOpen(false), []),
    calendarTrigger,
  );

  const start = params.get("start");
  const end = params.get("end");
  const rangeId = params.get("range");
  const days = params.get("days");
  const isCustom = Boolean(start && end);
  // Active segment: explicit range id, else infer from days, else the 30d default.
  const activeId = isCustom
    ? "custom"
    : (rangeId ?? PRESETS.find((p) => String(p.days) === days)?.id ?? "30d");

  function selectPreset(days: number, id: string) {
    const next = new URLSearchParams(params.toString());
    next.set("range", id);
    next.set("days", String(days));
    next.delete("start");
    next.delete("end");
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  }

  function applyRange(startKey: string, endKey: string) {
    const next = new URLSearchParams(params.toString());
    next.set("start", startKey);
    next.set("end", endKey);
    next.delete("range");
    next.delete("days");
    startTransition(() => {
      router.push(`${pathname}?${next.toString()}`);
      setOpen(false);
    });
  }

  /*
   * Tell the REST OF THE PAGE that a range change is in flight.
   *
   * Until now the only feedback was this control fading to 55% — while every
   * figure on the page kept rendering the PREVIOUS range at full opacity, with
   * a new range already highlighted in the segmented control above them. Stale
   * numbers presented as current answers, with a label claiming otherwise: the
   * exact failure mode this dashboard was built to replace.
   *
   * The dashboard body is a server component, so there is no shared React state
   * to thread this through. A data attribute on <body> is the smallest bridge:
   * `globals.css` dims and disables the data region while it is set, and the
   * live region below announces the change for screen readers, which cannot see
   * an opacity shift at all.
   */
  useEffect(() => {
    const el = document.body;
    if (pending) el.dataset.rangePending = "1";
    else delete el.dataset.rangePending;
    return () => {
      delete el.dataset.rangePending;
    };
  }, [pending]);

  return (
    <div
      className="flex items-center gap-1"
      style={{ opacity: pending ? 0.55 : 1, transition: "opacity 120ms" }}
    >
      <span aria-live="polite" className="sr-only">
        {pending ? "Updating figures for the new date range" : ""}
      </span>
      <div
        className="flex items-center gap-0.5 rounded-[10px] p-0.5"
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
        }}
        role="group"
        aria-label="Date range"
      >
        {PRESETS.map((p) => {
          const active = activeId === p.id;
          return (
            <button
              key={p.id}
              onClick={() => selectPreset(p.days, p.id)}
              aria-pressed={active}
              className="tnum rounded-[7px] px-2.5 py-1.5 text-[12.5px] font-semibold transition-colors"
              style={
                active
                  ? { background: "var(--series-1)", color: "#fff" }
                  : {
                      background: "transparent",
                      color: "var(--text-secondary)",
                    }
              }
            >
              {p.label}
            </button>
          );
        })}

        {/* Custom range */}
        <div className="relative">
          <button
            ref={calendarTrigger}
            onClick={() => {
              // Measure before paint so the popover never flashes at 0,0.
              if (!open) place();
              setOpen((v) => !v);
            }}
            aria-pressed={activeId === "custom"}
            aria-expanded={open}
            aria-haspopup="dialog"
            className="flex items-center gap-1 rounded-[7px] px-2.5 py-1.5 text-[12.5px] font-semibold transition-colors"
            style={
              activeId === "custom"
                ? { background: "var(--series-1)", color: "#fff" }
                : { background: "transparent", color: "var(--text-secondary)" }
            }
            title="Custom range"
          >
            <span aria-hidden="true">🗓</span>
            <span className="hidden sm:inline">Custom</span>
          </button>

          {open && (
            /*
             * 🔴 The catcher AND the dialog both go through the portal, and
             * they have to travel together.
             *
             * The catcher was portalled on its own to fix a real bug: it lives
             * inside the sticky header, whose `backdrop-filter` makes that
             * header the containing block for fixed descendants, so in place it
             * covered only the header strip and clicking the page below left
             * the picker open.
             *
             * But `backdrop-filter` also opens a STACKING CONTEXT, and that is
             * what broke the calendar. The dialog left behind was `z-30` inside
             * a header painted at `z-10`, while the portalled catcher sat at
             * `z-20` in the ROOT context — above the entire header, dialog
             * included. The catcher covered the calendar and swallowed every
             * click on it: pressing "‹" to go back a month dismissed the
             * popover instead, so the calendar could not be navigated at all
             * and no range before the current month was reachable.
             *
             * Both in the same context, dialog above catcher, is the fix.
             */
            <Portal>
              <div
                className="fixed inset-0 z-[100]"
                onClick={() => setOpen(false)}
                aria-hidden="true"
              />
              <div
                role="dialog"
                aria-label="Pick a custom date range"
                className="fixed z-[101] rounded-[12px] p-3"
                style={{
                  top: anchor?.top ?? 0,
                  // Clamped so the popover cannot be pushed off-screen on a
                  // narrow viewport, where the trigger sits near the edge.
                  right: Math.max(8, anchor?.right ?? 8),
                  visibility: anchor ? "visible" : "hidden",
                  background: "var(--surface-raised)",
                  border: "1px solid var(--border-strong)",
                  boxShadow: "var(--shadow-overlay)",
                }}
              >
                <div
                  className="mb-2 text-[10.5px] font-semibold tracking-[0.08em] uppercase"
                  style={{ color: "var(--text-muted)" }}
                >
                  Pick a range
                </div>
                <RangeCalendar
                  initialStart={start}
                  initialEnd={end}
                  onApply={applyRange}
                />
              </div>
            </Portal>
          )}
        </div>
      </div>

      <span
        className="tnum ml-1 hidden text-[12px] whitespace-nowrap lg:inline"
        style={{ color: "var(--text-muted)" }}
      >
        {currentLabel}
      </span>
    </div>
  );
}
