"use client";

import { useMemo, useState } from "react";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/metrics/compute";
import type { CanonicalStage } from "@/db/schema";
import type { LeadRow } from "@/lib/metrics/queries";

/**
 * The pipeline, made explorable across TWO dimensions:
 *
 *   1. Campaign — "which campaign brought these, and where are campaign 1's
 *      leads vs campaign 2's?" Selecting a campaign recomputes the stage bars
 *      and the lead list for just that campaign.
 *   2. Stage — "who exactly is in Appointment Booked?" Clicking a stage drills
 *      into the leads sitting there right now.
 *
 * Current-state (reads `current_stage` directly, so it is exact and not
 * date-range scoped — it is a live snapshot). Stage is the colored dimension in
 * the bars; campaign is the colored dimension in the chips; the lead's name and
 * campaign text stay neutral so nothing fights for the same hue.
 */

const UNATTRIB = "unattributed";

const RAMP = [
  "var(--seq-300)",
  "var(--seq-350)",
  "var(--seq-400)",
  "var(--seq-450)",
  "var(--seq-500)",
  "var(--seq-550)",
];

function stageColor(canonical: CanonicalStage | null, rampIndex: number): string {
  if (canonical === "closed_won") return "var(--delta-good)";
  if (canonical === "no_show" || canonical === "lost") return "var(--text-muted)";
  return RAMP[Math.min(rampIndex, RAMP.length - 1)];
}

function fmtDate(iso: string | null, tz: string): string {
  if (!iso) return "–";
  // Pin BOTH locale and timezone: unpinned, this formats in the viewer's/server's
  // tz, so a near-midnight lead renders a different day on the server than in the
  // browser (a hydration mismatch) and shows the wrong day relative to the client
  // account's timezone, which is the reporting authority.
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function PipelineExplorer({
  leads,
  currency,
  timezone,
  campaignColors,
  campaignNames,
}: {
  leads: LeadRow[];
  currency: string;
  /** The client account's timezone — dates are bucketed/displayed in it. */
  timezone: string;
  /** campaignId → dot color, shared with the campaign table for consistency. */
  campaignColors: Record<string, string>;
  /** campaignId → display name (Meta campaign name), for nicer chip labels. */
  campaignNames: Record<string, string>;
}) {
  const [campaign, setCampaign] = useState<string | "all">("all");
  const [stage, setStage] = useState<string | "all">("all");
  const [q, setQ] = useState("");

  // Campaign groups from the leads themselves (all-time), largest first,
  // Unattributed always last.
  const campaigns = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; count: number }>();
    for (const l of leads) {
      const key = l.campaignId || UNATTRIB;
      const label =
        key === UNATTRIB
          ? "Unattributed"
          : campaignNames[key] || l.campaignName || key;
      const e = seen.get(key) ?? { key, label, count: 0 };
      e.count++;
      seen.set(key, e);
    }
    return [...seen.values()].sort((a, b) => {
      if (a.key === UNATTRIB) return 1;
      if (b.key === UNATTRIB) return -1;
      return b.count - a.count;
    });
  }, [leads, campaignNames]);

  const inCampaign = useMemo(
    () => (campaign === "all" ? leads : leads.filter((l) => (l.campaignId || UNATTRIB) === campaign)),
    [leads, campaign],
  );

  // Stage distribution for the selected campaign — "where are these leads".
  const stages = useMemo(() => {
    const seen = new Map<
      string,
      { name: string; canonical: CanonicalStage | null; ord: number; count: number }
    >();
    for (const l of inCampaign) {
      const key = l.ghlStageName ?? "Unmapped";
      const e = seen.get(key) ?? { name: key, canonical: l.canonicalStage, ord: l.displayOrder, count: 0 };
      e.count++;
      seen.set(key, e);
    }
    const list = [...seen.values()].sort((a, b) => a.ord - b.ord);
    let ramp = 0;
    return list.map((s) => {
      const special =
        s.canonical === "closed_won" || s.canonical === "no_show" || s.canonical === "lost";
      return { ...s, color: stageColor(s.canonical, special ? 0 : ramp++) };
    });
  }, [inCampaign]);

  const colorByStage = useMemo(() => new Map(stages.map((s) => [s.name, s.color])), [stages]);
  const maxCount = stages.reduce((m, s) => Math.max(m, s.count), 0);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return inCampaign.filter((l) => {
      if (stage !== "all" && (l.ghlStageName ?? "Unmapped") !== stage) return false;
      if (!needle) return true;
      return (
        (l.name ?? "").toLowerCase().includes(needle) ||
        (l.campaignName ?? "").toLowerCase().includes(needle)
      );
    });
  }, [inCampaign, stage, q]);

  const campaignColor = (key: string) =>
    key === UNATTRIB ? "var(--text-muted)" : campaignColors[key] ?? "var(--series-1)";

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 p-5 pb-3">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Where your leads are now
        </h2>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          Live snapshot · <span className="tnum">{formatNumber(leads.length)}</span> Facebook leads
        </span>
      </div>

      {leads.length === 0 ? (
        <div className="px-5 pb-5">
          <div
            className="rounded-[10px] border border-dashed p-6 text-center"
            style={{ borderColor: "var(--border-strong)" }}
          >
            <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              No Facebook leads in the pipeline yet
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Dimension 1 — campaign filter */}
          <div className="flex flex-wrap gap-1.5 px-5 pb-4">
            <CampaignChip
              active={campaign === "all"}
              label="All campaigns"
              count={leads.length}
              onClick={() => {
                setCampaign("all");
                setStage("all");
              }}
            />
            {campaigns.map((c) => (
              <CampaignChip
                key={c.key}
                active={campaign === c.key}
                label={c.label}
                count={c.count}
                dot={campaignColor(c.key)}
                onClick={() => {
                  setCampaign((cur) => (cur === c.key ? "all" : c.key));
                  setStage("all");
                }}
              />
            ))}
          </div>

          {/* Dimension 2 — stage distribution for the selected campaign */}
          <div className="border-t px-5 pt-3 pb-4" style={{ borderColor: "var(--border)" }}>
            <div className="mb-2 flex items-baseline gap-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
              <span className="font-semibold" style={{ color: "var(--text-secondary)" }}>
                {campaign === "all" ? "All campaigns" : campaigns.find((c) => c.key === campaign)?.label}
              </span>
              · where {formatNumber(inCampaign.length)} leads sit · click a stage
            </div>
            <div className="flex flex-col gap-1">
              {stages.map((s) => (
                <StageRow
                  key={s.name}
                  label={s.name}
                  count={s.count}
                  pctOfMax={maxCount > 0 ? s.count / maxCount : 0}
                  color={s.color}
                  active={stage === s.name}
                  total={inCampaign.length}
                  onClick={() => setStage((cur) => (cur === s.name ? "all" : s.name))}
                />
              ))}
            </div>
          </div>

          {/* Drill-down: the actual leads for campaign × stage */}
          <div className="border-t" style={{ borderColor: "var(--border)" }}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-semibold" style={{ color: "var(--text-primary)" }}>
                  {stage === "all" ? "All leads" : stage}
                </span>
                <span
                  className="tnum rounded-full px-2 py-0.5 text-[12px]"
                  style={{ background: "var(--surface-2)", color: "var(--text-secondary)" }}
                >
                  {formatNumber(visible.length)}
                </span>
                {(stage !== "all" || campaign !== "all") && (
                  <button
                    onClick={() => {
                      setStage("all");
                      setCampaign("all");
                    }}
                    className="text-[12px] underline"
                    style={{ color: "var(--text-muted)" }}
                  >
                    clear filters
                  </button>
                )}
              </div>
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name or campaign…"
                className="w-full rounded-[8px] border px-3 py-1.5 text-[13px] sm:w-56"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--surface-1)",
                  color: "var(--text-primary)",
                }}
              />
            </div>

            <div
              className="table-scroll max-h-[460px] overflow-y-auto border-t"
              style={{ borderColor: "var(--border)" }}
            >
              <table className="w-full border-collapse text-[13px]">
                <thead className="sticky top-0 z-10" style={{ background: "var(--surface-1)" }}>
                  <tr style={{ color: "var(--text-muted)" }}>
                    <Th className="text-left">Lead</Th>
                    <Th className="text-left">Campaign</Th>
                    <Th className="text-left">Stage</Th>
                    <Th className="text-left">Added</Th>
                    <Th className="text-right">Value</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((l) => (
                    <tr key={l.id} className="row-hover border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="px-4 py-2.5 font-medium" style={{ color: "var(--text-primary)" }}>
                        {l.name?.trim() || "Unnamed lead"}
                      </td>
                      <td className="px-4 py-2.5">
                        {l.campaignName ? (
                          <span className="inline-flex max-w-[240px] items-center gap-1.5 align-middle">
                            <span
                              className="inline-block h-2 w-2 shrink-0 rounded-full"
                              style={{ background: campaignColor(l.campaignId || UNATTRIB) }}
                              aria-hidden="true"
                            />
                            <span className="truncate text-[12.5px]" style={{ color: "var(--text-secondary)" }} title={l.campaignName}>
                              {campaignNames[l.campaignId ?? ""] || l.campaignName}
                            </span>
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>Unattributed</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5" style={{ color: "var(--text-secondary)" }}>
                          <span
                            className="inline-block h-2 w-2 shrink-0 rounded-full"
                            style={{ background: colorByStage.get(l.ghlStageName ?? "Unmapped") ?? "var(--text-muted)" }}
                            aria-hidden="true"
                          />
                          {l.ghlStageName ?? "Unmapped"}
                        </span>
                      </td>
                      <td className="tnum px-4 py-2.5" style={{ color: "var(--text-muted)" }}>
                        {fmtDate(l.createdAt, timezone)}
                      </td>
                      <td className="tnum px-4 py-2.5 text-right" style={{ color: "var(--text-secondary)" }}>
                        {l.value > 0 ? formatCurrency(l.value, currency) : "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visible.length === 0 && (
                <div className="px-4 py-8 text-center text-[13px]" style={{ color: "var(--text-muted)" }}>
                  No leads match this filter.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function CampaignChip({
  active,
  label,
  count,
  dot,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  dot?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors"
      style={
        active
          ? { background: "var(--series-1)", color: "#fff", border: "1px solid var(--series-1)" }
          : { background: "var(--surface-1)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)" }
      }
    >
      {dot && !active && (
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: dot }} aria-hidden="true" />
      )}
      <span className="max-w-[200px] truncate">{label}</span>
      <span className="tnum" style={{ opacity: 0.75 }}>
        {count}
      </span>
    </button>
  );
}

function StageRow({
  label,
  count,
  pctOfMax,
  color,
  active,
  total,
  onClick,
}: {
  label: string;
  count: number;
  pctOfMax: number;
  color: string;
  active: boolean;
  total: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="grid w-full items-center gap-3 rounded-[8px] px-2 py-1.5 text-left transition-colors"
      style={{
        gridTemplateColumns: "minmax(96px, 150px) 1fr auto",
        background: active ? "var(--surface-2)" : "transparent",
      }}
    >
      <span
        className="truncate text-xs sm:text-[13px]"
        style={{
          color: active ? "var(--text-primary)" : "var(--text-secondary)",
          fontWeight: active ? 600 : 400,
        }}
        title={label}
      >
        {label}
      </span>
      <span className="min-w-0">
        <span
          className="block h-7 rounded-r-[4px] transition-[width] duration-500"
          style={{ width: `${Math.max(pctOfMax * 100, count > 0 ? 2 : 0)}%`, background: color }}
        />
      </span>
      <span className="tnum shrink-0 pl-1 text-right text-[13px] font-semibold whitespace-nowrap" style={{ color: "var(--text-primary)" }}>
        {formatNumber(count)}
        <span className="ml-1.5 text-[11px] font-normal" style={{ color: "var(--text-muted)" }}>
          {formatPercent(total > 0 ? count / total : null, 0)}
        </span>
      </span>
    </button>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2 text-[11px] font-semibold tracking-wider uppercase ${className}`}
      style={{ background: "var(--surface-1)" }}
    >
      {children}
    </th>
  );
}
