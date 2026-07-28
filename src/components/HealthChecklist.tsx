"use client";

import { useState } from "react";
import type { HealthLevel, HealthReport } from "@/lib/health";
import { Icon, type IconName } from "./Icon";

/**
 * Connection health.
 *
 * The amber/red distinction is the whole point:
 *   red   — we cannot get data (broken credential, unreachable account)
 *   amber — we can get data, and the data says nothing is happening
 *   green — flowing
 *
 * A paused ad account must read amber "ads paused", never green (which hides a
 * dead pipe) and never red (which trains people to ignore alarms). The system
 * this replaces had six empty report blocks and nothing ever flagged them.
 *
 * Status is never colour-alone — every row carries a glyph and a text label.
 */

const LEVEL_META: Record<
  HealthLevel,
  { color: string; icon: IconName; label: string }
> = {
  green: { color: "var(--status-good)", icon: "check", label: "OK" },
  amber: { color: "var(--status-warning)", icon: "alert", label: "Attention" },
  red: { color: "var(--status-critical)", icon: "x", label: "Broken" },
  unknown: { color: "var(--text-muted)", icon: "help", label: "Unknown" },
};

export function HealthBadge({ level }: { level: HealthLevel }) {
  const m = LEVEL_META[level];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: "var(--surface-2)", color: "var(--text-secondary)" }}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-white"
        style={{ background: m.color }}
      >
        <Icon name={m.icon} size={9} style={{ strokeWidth: 3 }} />
      </span>
      {m.label}
    </span>
  );
}

export function HealthChecklist({
  clientId,
  initial,
}: {
  clientId: string;
  initial?: HealthReport;
}) {
  const [report, setReport] = useState<HealthReport | null>(initial ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retest() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/health`, {
        cache: "no-store",
      });
      if (res.ok) setReport(await res.json());
      else setError("Couldn't run the health checks — try again.");
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Connection health
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            Verifies each pipe is actually delivering, not just configured
          </p>
        </div>
        <button
          onClick={retest}
          disabled={loading}
          className="shrink-0 rounded-[8px] border px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-50"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {loading ? "Testing…" : "Re-test"}
        </button>
      </div>

      {error && (
        <p
          className="mb-3 rounded-[8px] px-3 py-2 text-xs"
          style={{
            color: "var(--status-critical)",
            background: "color-mix(in srgb, var(--status-critical) 10%, transparent)",
          }}
        >
          {error}
        </p>
      )}

      {!report ? (
        error ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            No results yet — press Re-test to run the checks.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton h-11 w-full" />
            ))}
          </div>
        )
      ) : (
        <ul className="flex flex-col">
          {report.checks.map((check) => {
            const m = LEVEL_META[check.level];
            return (
              <li
                key={check.id}
                className="flex items-start gap-3 border-b py-2.5 last:border-b-0"
                style={{ borderColor: "var(--border)" }}
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white"
                  style={{ background: m.color }}
                >
                  <Icon name={m.icon} size={10} style={{ strokeWidth: 3 }} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className="text-[13px] font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {check.label}
                    </span>
                    <span className="sr-only">{m.label}: </span>
                    <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                      {check.message}
                    </span>
                  </div>
                  {check.hint && (
                    <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                      {check.hint}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
