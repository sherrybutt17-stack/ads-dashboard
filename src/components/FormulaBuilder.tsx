"use client";

import { useId, useState } from "react";
import { AD_PLATFORMS, PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";
import { METRICS, METRIC_GROUPS, METRIC_IDS, metricLabel, type MetricId } from "@/lib/board/catalog";
import { FORMULA_LIMITS, formulaText, parseFormula, type FormulaOp, type FormulaToken } from "@/lib/metrics/formula";

/**
 * Builds a formula by clicking — stats, + − × ÷, brackets and numbers — the
 * way Whatagraph's metric builder does, and shows it as a sentence with any
 * problem in plain words as it is built.
 *
 * Nothing is typed as text: each click adds a token (`metrics/formula.ts`),
 * which is what is stored. That keeps every formula one the server can read
 * back exactly, and none that it would have to run as code.
 */

const OPS: Array<{ v: FormulaOp; text: string; name: string }> = [
  { v: "+", text: "+", name: "plus" },
  { v: "-", text: "−", name: "minus" },
  { v: "*", text: "×", name: "times" },
  { v: "/", text: "÷", name: "divided by" },
];

/** Stats a formula on this platform can use: reported there (on every platform for "any"), never reach. */
export function formulaStatsFor(platform: AdPlatform | "any"): MetricId[] {
  const on = platform === "any" ? AD_PLATFORMS : [platform];
  return METRIC_IDS.filter(
    (m) => m !== "reach" && m !== "frequency" && on.every((p) => METRICS[m].platforms.includes(p)),
  );
}

export function FormulaBuilder({
  tokens,
  onChange,
  platform,
}: {
  tokens: FormulaToken[];
  onChange: (tokens: FormulaToken[]) => void;
  platform: AdPlatform | "any";
}) {
  const ids = useId();
  const [number, setNumber] = useState("");
  const labelPlatform: AdPlatform = platform === "any" ? "meta" : platform;
  const label = (id: string) => (id in METRICS ? metricLabel(id as MetricId, labelPlatform) : id);
  const parsed = parseFormula(tokens);
  const full = tokens.length >= FORMULA_LIMITS.tokens;
  const add = (t: FormulaToken) => {
    if (!full) onChange([...tokens, t]);
  };
  const offered = formulaStatsFor(platform);
  const num = Number(number.trim());
  const numberOk = number.trim() !== "" && Number.isFinite(num) && Math.abs(num) <= FORMULA_LIMITS.number;

  return (
    <div className="flex flex-col gap-3">
      {/* The formula as built, one chip per part. */}
      <div
        className="flex min-h-[46px] flex-wrap items-center gap-1.5 rounded-[var(--radius-sm)] border p-2"
        style={{ borderColor: "var(--border-strong)", background: "var(--surface-1)" }}
        aria-label="Formula"
        role="group"
      >
        {tokens.length === 0 ? (
          <span className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            Add a stat to start — for example Ad spend, then ÷, then Appointments.
          </span>
        ) : (
          tokens.map((t, i) => (
            <span
              key={i}
              className="rounded-[var(--radius-xs)] px-2 py-1 text-[12.5px]"
              style={{
                background: t.t === "stat" ? "var(--accent-soft, var(--surface-2))" : "var(--surface-2)",
                color: "var(--text-primary)",
                outline: parsed.ok === false && parsed.at === i ? "2px solid var(--delta-bad)" : undefined,
              }}
            >
              {t.t === "stat"
                ? label(t.id)
                : t.t === "num"
                  ? t.v.toLocaleString("en-US", { maximumFractionDigits: 6 })
                  : t.t === "op"
                    ? OPS.find((o) => o.v === t.v)?.text
                    : t.t}
            </span>
          ))
        )}
      </div>

      <p className="text-[12px]" role="status" style={{ color: parsed.ok || tokens.length === 0 ? "var(--text-muted)" : "var(--delta-bad)" }}>
        {tokens.length === 0
          ? "Nothing yet."
          : parsed.ok
            ? `Reads: ${formulaText(tokens, label)}`
            : parsed.error}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
            Add a stat
          </span>
          <select
            className="field w-full"
            value=""
            disabled={full}
            onChange={(e) => {
              if (e.target.value) add({ t: "stat", id: e.target.value });
            }}
          >
            <option value="">{platform === "any" ? "Stats every platform reports…" : `${PLATFORM_LABEL[platform]} stats…`}</option>
            {METRIC_GROUPS.map((g) => {
              const inGroup = offered.filter((m) => METRICS[m].group === g);
              if (inGroup.length === 0) return null;
              return (
                <optgroup key={g} label={g}>
                  {inGroup.map((m) => (
                    <option key={m} value={m}>
                      {metricLabel(m, labelPlatform)}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>
        <div className="flex gap-1" role="group" aria-label="Operators and brackets">
          {OPS.map((o) => (
            <button
              key={o.v}
              type="button"
              className="btn-ghost h-9 w-9 rounded-[var(--radius-sm)] text-[15px]"
              aria-label={`Add “${o.name}”`}
              disabled={full}
              onClick={() => add({ t: "op", v: o.v })}
            >
              {o.text}
            </button>
          ))}
          <button type="button" className="btn-ghost h-9 w-9 rounded-[var(--radius-sm)] text-[15px]" aria-label="Add an opening bracket" disabled={full} onClick={() => add({ t: "(" })}>
            (
          </button>
          <button type="button" className="btn-ghost h-9 w-9 rounded-[var(--radius-sm)] text-[15px]" aria-label="Add a closing bracket" disabled={full} onClick={() => add({ t: ")" })}>
            )
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex w-36 flex-col gap-1" htmlFor={`${ids}-num`}>
          <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
            Number
          </span>
          <input
            id={`${ids}-num`}
            className="field w-full"
            inputMode="decimal"
            placeholder="1000"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-ghost rounded-[var(--radius-sm)] px-3 py-2 text-[12.5px]"
          disabled={!numberOk || full}
          onClick={() => {
            add({ t: "num", v: num });
            setNumber("");
          }}
        >
          Add number
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className="btn-ghost rounded-[var(--radius-sm)] px-3 py-2 text-[12.5px]"
          disabled={tokens.length === 0}
          onClick={() => onChange(tokens.slice(0, -1))}
          aria-label="Remove the last part"
        >
          ⌫ Back
        </button>
        <button
          type="button"
          className="btn-ghost rounded-[var(--radius-sm)] px-3 py-2 text-[12.5px]"
          disabled={tokens.length === 0}
          onClick={() => onChange([])}
        >
          Clear
        </button>
      </div>
      <p className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
        Worked out from each row&apos;s totals, so a month is its own spend ÷ its own appointments — never an
        average of days. For a share, choose “Percent” below rather than multiplying by 100.
      </p>
    </div>
  );
}
