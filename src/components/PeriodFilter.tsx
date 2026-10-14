"use client";

import { useState } from "react";
import { MAX_RANGE_DAYS, rangeLabel, shiftDateKey } from "@/lib/dates";
import { PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";

/**
 * Choose WHAT a share link or an export covers, without leaving the panel.
 *
 * Both used to take the dashboard's own range and platform silently: to export
 * last month you had to close the menu, change the picker, wait for the whole
 * dashboard to reload and open the menu again — and the Export menu never even
 * said which range it was about to write. The default is still "what is on
 * screen", so nothing changes for anyone who never touches this.
 *
 * Presets end YESTERDAY, like the dashboard's own: today is partial.
 */

export interface PeriodSelection {
  start: string;
  end: string;
  platform: AdPlatform;
}

type PresetId = "screen" | "7" | "30" | "90" | "this-month" | "last-month" | "custom";

/** Days in an inclusive `start..end` span of date keys. */
function spanDays(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
}

/** Why a selection cannot be used, in a sentence; null when it can. */
export function periodProblem(sel: PeriodSelection, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sel.start) || !/^\d{4}-\d{2}-\d{2}$/.test(sel.end)) {
    return "Pick both a start and an end date.";
  }
  if (sel.start > sel.end) return "The start date is after the end date.";
  if (sel.start > today) return "The period starts in the future.";
  if (spanDays(sel.start, sel.end) > MAX_RANGE_DAYS) {
    return `Pick ${MAX_RANGE_DAYS} days or fewer.`;
  }
  return null;
}

export function presetRange(id: Exclude<PresetId, "screen" | "custom">, today: string) {
  const yesterday = shiftDateKey(today, -1);
  switch (id) {
    case "7":
    case "30":
    case "90":
      return { start: shiftDateKey(yesterday, -(Number(id) - 1)), end: yesterday };
    case "this-month":
      return { start: `${today.slice(0, 8)}01`, end: yesterday };
    case "last-month": {
      const lastOfPrev = shiftDateKey(`${today.slice(0, 8)}01`, -1);
      return { start: `${lastOfPrev.slice(0, 8)}01`, end: lastOfPrev };
    }
  }
}

const PRESETS: { id: PresetId; label: string }[] = [
  { id: "screen", label: "As on screen" },
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
  { id: "90", label: "Last 90 days" },
  { id: "this-month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "custom", label: "Custom" },
];

/*
 * `.chip` is unlayered CSS, so it beats Tailwind's spacing utilities; a smaller
 * chip for a narrow panel has to come in as an inline style.
 */
const CHIP_STYLE = { padding: "4px 10px", fontSize: 12 } as const;

const INPUT_STYLE = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
  colorScheme: "light dark",
} as const;

export function PeriodFilter({
  value,
  onChange,
  screen,
  today,
  platforms,
  headings = "caps",
}: {
  value: PeriodSelection;
  onChange: (next: PeriodSelection) => void;
  /** The range and platform the dashboard is showing right now. */
  screen: PeriodSelection;
  /** Today's date key in the CLIENT's timezone, from the server. */
  today: string;
  /** Platforms this client has connected; the choice is hidden below two. */
  platforms: readonly AdPlatform[];
  /**
   * "caps" for a popover; "field" to match the sentence-case field labels of a
   * form it sits in (the Share dialog), so one dialog does not mix two styles.
   */
  headings?: "caps" | "field";
}) {
  const [preset, setPreset] = useState<PresetId>("screen");
  const problem = periodProblem(value, today);
  const headingClass =
    headings === "field"
      ? "mb-1 block text-xs font-medium"
      : "mb-1.5 block text-[11px] font-semibold tracking-[0.06em] uppercase";
  const headingStyle = {
    color: headings === "field" ? "var(--text-secondary)" : "var(--text-muted)",
  };
  // On the 1st there is no complete day of this month yet.
  const thisMonthEmpty = today.endsWith("-01");

  function choose(id: PresetId) {
    setPreset(id);
    if (id === "screen") onChange({ ...value, start: screen.start, end: screen.end });
    else if (id !== "custom") onChange({ ...value, ...presetRange(id, today) });
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <span className={headingClass} style={headingStyle}>
          Period
        </span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Period">
          {PRESETS.filter((p) => !(p.id === "this-month" && thisMonthEmpty)).map((p) => (
            <button
              key={p.id}
              type="button"
              className="chip font-medium"
              style={CHIP_STYLE}
              aria-pressed={preset === p.id}
              onClick={() => choose(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {preset === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-secondary)" }}>
            From
            <input
              type="date"
              value={value.start}
              max={today}
              onChange={(e) => onChange({ ...value, start: e.target.value })}
              className="rounded-[var(--radius-xs)] border px-2 py-1 text-[12px]"
              style={INPUT_STYLE}
            />
          </label>
          <label className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-secondary)" }}>
            To
            <input
              type="date"
              value={value.end}
              max={today}
              onChange={(e) => onChange({ ...value, end: e.target.value })}
              className="rounded-[var(--radius-xs)] border px-2 py-1 text-[12px]"
              style={INPUT_STYLE}
            />
          </label>
        </div>
      )}

      {platforms.length > 1 && (
        <div>
          <span className={headingClass} style={headingStyle}>
            Platform
          </span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Platform">
            {platforms.map((p) => (
              <button
                key={p}
                type="button"
                className="chip font-medium"
                style={CHIP_STYLE}
                aria-pressed={value.platform === p}
                onClick={() => onChange({ ...value, platform: p })}
              >
                {p === "meta" ? "Facebook" : PLATFORM_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Always stated, so what the button will write is never a guess. */}
      <p
        className="tnum text-[12px] leading-snug"
        style={{ color: problem ? "var(--status-critical)" : "var(--text-secondary)" }}
      >
        {problem ??
          `${rangeLabel(value.start, value.end)}${
            platforms.length > 1
              ? ` · ${value.platform === "meta" ? "Facebook" : PLATFORM_LABEL[value.platform]}`
              : ""
          }`}
      </p>
    </div>
  );
}
