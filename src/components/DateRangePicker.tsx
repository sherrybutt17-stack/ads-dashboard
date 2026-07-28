"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { RangeCalendar } from "./RangeCalendar";

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
  { id: "all", label: "All", days: 800 },
] as const;

export function DateRangePicker({ currentLabel }: { currentLabel: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

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

  return (
    <div
      className="flex items-center gap-1"
      style={{ opacity: pending ? 0.55 : 1, transition: "opacity 120ms" }}
    >
      <div
        className="flex items-center gap-0.5 rounded-[10px] p-0.5"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
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
                  : { background: "transparent", color: "var(--text-secondary)" }
              }
            >
              {p.label}
            </button>
          );
        })}

        {/* Custom range */}
        <div className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-pressed={activeId === "custom"}
            aria-expanded={open}
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
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setOpen(false)}
                aria-hidden="true"
              />
              <div
                className="absolute right-0 z-30 mt-2 rounded-[12px] p-3 shadow-lg"
                style={{
                  background: "var(--surface-raised)",
                  border: "1px solid var(--border-strong)",
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
            </>
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
