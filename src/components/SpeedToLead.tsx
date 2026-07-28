import type { SpeedToLead } from "@/lib/metrics/queries";

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

/**
 * Speed-to-lead: how fast a new lead gets its first outbound call.
 *
 * The median is over leads that WERE called; the response-time bars use total
 * leads as the denominator, so a lead never called counts against the SLA
 * rather than being quietly excluded — the whole point of measuring the call
 * itself instead of a manual "Contacted" stage move.
 */
export function SpeedToLeadWidget({ data }: { data: SpeedToLead }) {
  const { leads, called, uncalled, medianSeconds, within5m, within1h, within24h } =
    data;

  const buckets = [
    { label: "within 5 min", n: within5m, tone: "var(--status-good)" },
    { label: "within 1 hour", n: within1h, tone: "var(--accent)" },
    { label: "within 24 hours", n: within24h, tone: "var(--text-secondary)" },
  ];

  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2
            className="text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            Speed to lead
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            Time from a new lead to the first outbound call
          </p>
        </div>
        <div
          className="shrink-0 text-right text-xs tabular-nums"
          style={{ color: "var(--text-muted)" }}
        >
          {leads} lead{leads === 1 ? "" : "s"} · {called} called
        </div>
      </div>

      {leads === 0 ? (
        <p className="mt-6 text-sm" style={{ color: "var(--text-muted)" }}>
          No leads arrived in this period.
        </p>
      ) : (
        <div className="mt-4 grid gap-5 sm:grid-cols-[auto_1fr] sm:items-center">
          <div
            className="sm:border-r sm:pr-6"
            style={{ borderColor: "var(--border)" }}
          >
            <div
              className="text-[40px] font-semibold leading-none tabular-nums"
              style={{ color: "var(--text-primary)" }}
            >
              {formatDuration(medianSeconds)}
            </div>
            <div className="mt-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
              {called === 0 ? "no leads called yet" : "median to first call"}
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            {buckets.map((b) => {
              const p = pct(b.n, leads);
              return (
                <div key={b.label}>
                  <div className="flex items-center justify-between text-xs">
                    <span style={{ color: "var(--text-secondary)" }}>
                      {b.label}
                    </span>
                    <span
                      className="tabular-nums"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {b.n}{" "}
                      <span style={{ color: "var(--text-muted)" }}>({p}%)</span>
                    </span>
                  </div>
                  <div
                    className="mt-1 h-1.5 w-full overflow-hidden rounded-full"
                    style={{ background: "var(--border)" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${p}%`, background: b.tone }}
                    />
                  </div>
                </div>
              );
            })}
            {uncalled > 0 && (
              <p
                className="mt-0.5 text-xs"
                style={{ color: "var(--status-warning)" }}
              >
                {uncalled} lead{uncalled === 1 ? "" : "s"} not called yet
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
