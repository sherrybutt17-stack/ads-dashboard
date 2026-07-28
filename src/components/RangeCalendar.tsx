"use client";

import { useMemo, useState } from "react";
import {
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  isSameMonth,
  isSameDay,
  isAfter,
  isBefore,
} from "date-fns";

/**
 * A real click-to-select range calendar — pick the start day, then the end day,
 * and the span between fills in. No typing dd/mm/yyyy into two boxes.
 *
 * Returns YYYY-MM-DD keys (interpreted in the client's timezone server-side).
 * Future days are disabled — a lead can't arrive tomorrow.
 */

function toKey(d: Date): string {
  return format(d, "yyyy-MM-dd");
}
function fromKey(s: string | null): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

export function RangeCalendar({
  initialStart,
  initialEnd,
  onApply,
  today = new Date(),
}: {
  initialStart: string | null;
  initialEnd: string | null;
  onApply: (startKey: string, endKey: string) => void;
  today?: Date;
}) {
  const t0 = startOfDay(today);
  const [start, setStart] = useState<Date | null>(fromKey(initialStart));
  const [end, setEnd] = useState<Date | null>(fromKey(initialEnd));
  const [hover, setHover] = useState<Date | null>(null);
  const [view, setView] = useState<Date>(
    startOfMonth(fromKey(initialStart) ?? t0),
  );

  const days = useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(view));
    const gridEnd = endOfWeek(endOfMonth(view));
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [view]);

  // The effective end while the user is mid-selection (for live range preview).
  const previewEnd = end ?? (start && hover && isAfter(hover, start) ? hover : null);

  function inRange(d: Date): boolean {
    if (!start || !previewEnd) return false;
    return isAfter(d, start) && isBefore(d, previewEnd);
  }

  function click(d: Date) {
    if (isAfter(d, t0)) return; // no future
    if (!start || (start && end)) {
      setStart(d);
      setEnd(null);
      return;
    }
    // start set, end not set
    if (isBefore(d, start)) {
      setStart(d);
      return;
    }
    setEnd(d);
    onApply(toKey(start), toKey(d)); // complete the range → apply immediately
  }

  return (
    <div className="select-none" style={{ width: 260 }}>
      {/* Month nav */}
      <div className="mb-2 flex items-center justify-between">
        <NavBtn label="Previous month" onClick={() => setView((v) => subMonths(v, 1))}>
          ‹
        </NavBtn>
        <span className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          {format(view, "MMMM yyyy")}
        </span>
        <NavBtn
          label="Next month"
          disabled={isSameMonth(view, t0) || isAfter(view, t0)}
          onClick={() => setView((v) => addMonths(v, 1))}
        >
          ›
        </NavBtn>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((w, i) => (
          <div
            key={i}
            className="py-1 text-center text-[10.5px] font-semibold"
            style={{ color: "var(--text-muted)" }}
          >
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0.5" onMouseLeave={() => setHover(null)}>
        {days.map((d) => {
          const isCur = isSameMonth(d, view);
          const isFuture = isAfter(d, t0);
          const isStart = start && isSameDay(d, start);
          const isEnd = previewEnd && isSameDay(d, previewEnd);
          const isEndpoint = isStart || isEnd;
          const within = inRange(d);
          const isToday = isSameDay(d, t0);

          return (
            <button
              key={d.toISOString()}
              onClick={() => click(d)}
              onMouseEnter={() => setHover(d)}
              disabled={isFuture}
              aria-label={format(d, "MMMM d, yyyy")}
              className="relative h-8 text-[12.5px] transition-colors"
              style={{
                cursor: isFuture ? "default" : "pointer",
                opacity: isFuture ? 0.28 : isCur ? 1 : 0.4,
                borderRadius: isEndpoint ? 8 : within ? 0 : 8,
                background: isEndpoint
                  ? "var(--series-1)"
                  : within
                    ? "color-mix(in srgb, var(--series-1) 18%, transparent)"
                    : "transparent",
                color: isEndpoint
                  ? "#fff"
                  : within
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                fontWeight: isEndpoint || isToday ? 600 : 400,
              }}
            >
              {format(d, "d")}
              {isToday && !isEndpoint && (
                <span
                  className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full"
                  style={{ background: "var(--series-1)" }}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Footer: current selection + reset */}
      <div className="mt-2 flex items-center justify-between text-[11px]" style={{ color: "var(--text-muted)" }}>
        <span className="tnum">
          {start ? format(start, "MMM d") : "Start"} — {end ? format(end, "MMM d") : "End"}
        </span>
        {(start || end) && (
          <button
            onClick={() => {
              setStart(null);
              setEnd(null);
            }}
            className="underline"
          >
            reset
          </button>
        )}
      </div>
    </div>
  );
}

function NavBtn({
  children,
  onClick,
  label,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-[7px] text-[15px] transition-colors disabled:opacity-30"
      style={{ color: "var(--text-secondary)", background: "var(--surface-2)" }}
    >
      {children}
    </button>
  );
}
