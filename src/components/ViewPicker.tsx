"use client";

import {
  DEFAULT_VIEW,
  KPI_OPTIONS,
  VIEW_SECTION_OPTIONS,
  normalizeView,
  type KpiId,
  type ReportView,
} from "@/lib/report/view";
import type { SectionId } from "@/lib/dashboard/registry";

/**
 * Choose what a shared or exported dashboard includes: sections, and which
 * headline numbers.
 *
 * The same control in Export and Share, so a choice reads identically in both.
 * It starts as the standard report — what every link showed before the choice
 * existed — and sections that list people by name are never ticked for anyone:
 * "Select all" leaves them out, and each carries a warning, because a share
 * link can be forwarded to anyone.
 */
export function ViewPicker({
  value,
  onChange,
  staff,
  mode,
  headings = "caps",
}: {
  value: ReportView;
  onChange: (next: ReportView) => void;
  /** Lead-list sections are offered to agency staff only. */
  staff: boolean;
  /** In export, sections with no table form are marked "PDF only". */
  mode: "export" | "share";
  headings?: "caps" | "field";
}) {
  const options = VIEW_SECTION_OPTIONS.filter((o) => staff || !o.personal);
  const picked = new Set<SectionId>(value.sections);
  const kpis = new Set<KpiId>(value.kpis);
  const valid = normalizeView(value) !== null;

  const setSection = (id: SectionId, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    // Ticking the headline block with no numbers chosen means all of them.
    const nextKpis =
      id === "kpis" && on && value.kpis.length === 0
        ? KPI_OPTIONS.map((k) => k.id)
        : value.kpis;
    onChange({ sections: [...next], kpis: [...nextKpis] });
  };
  const setKpi = (id: KpiId, on: boolean) => {
    const next = new Set(kpis);
    if (on) next.add(id);
    else next.delete(id);
    onChange({
      sections: value.sections,
      kpis: KPI_OPTIONS.map((k) => k.id).filter((k) => next.has(k)),
    });
  };

  const headingClass =
    headings === "field"
      ? "text-xs font-medium"
      : "text-[11px] font-semibold tracking-[0.06em] uppercase";
  const headingStyle = {
    color: headings === "field" ? "var(--text-secondary)" : "var(--text-muted)",
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className={headingClass} style={headingStyle}>
          What to include
        </span>
        <span className="flex gap-3 text-[11.5px]">
          <button
            type="button"
            className="hover:underline"
            style={{ color: "var(--text-secondary)" }}
            onClick={() => onChange({ ...DEFAULT_VIEW })}
          >
            Standard report
          </button>
          <button
            type="button"
            className="hover:underline"
            style={{ color: "var(--text-secondary)" }}
            title="Sections that list lead names are added only when ticked one by one."
            onClick={() =>
              onChange({
                sections: options.filter((o) => !o.personal).map((o) => o.id),
                kpis: KPI_OPTIONS.map((k) => k.id),
              })
            }
          >
            Select all
          </button>
        </span>
      </div>

      <ul className="flex flex-col gap-1">
        {options.map((o) => {
          const on = o.always || picked.has(o.id);
          return (
            <li key={o.id}>
              <label
                className="flex items-start gap-2 text-[12.5px] leading-snug"
                style={{ color: "var(--text-primary)" }}
                title={o.description}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={on}
                  disabled={o.always}
                  onChange={(e) => setSection(o.id, e.target.checked)}
                />
                <span className="min-w-0">
                  {o.label}
                  {o.always && (
                    <span className="ml-1" style={{ color: "var(--text-muted)" }}>
                      · always included
                    </span>
                  )}
                  {o.personal && (
                    <span className="ml-1" style={{ color: "var(--status-warning)" }}>
                      · lead names
                    </span>
                  )}
                  {mode === "export" && !o.tabular && (
                    <span className="ml-1" style={{ color: "var(--text-muted)" }}>
                      · PDF only
                    </span>
                  )}
                </span>
              </label>

              {o.id === "kpis" && on && (
                <div className="mt-1 mb-1 ml-6 grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {KPI_OPTIONS.map((k) => (
                    <label
                      key={k.id}
                      className="flex items-center gap-1.5 text-[12px]"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <input
                        type="checkbox"
                        checked={kpis.has(k.id)}
                        onChange={(e) => setKpi(k.id, e.target.checked)}
                      />
                      {k.label}
                    </label>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {!valid && (
        <p className="text-[12px]" style={{ color: "var(--status-critical)" }}>
          Pick at least one section.
        </p>
      )}
    </div>
  );
}
