import type { SpeedToLead, SpeedToLeadRow } from "@/lib/metrics/queries";
import { DASH } from "@/lib/metrics/compute";

function formatDuration(seconds: number | null): string {
  // DASH, not a hardcoded em-dash: "no value" must look identical everywhere,
  // or the reader learns two glyphs mean two different things when they don't.
  if (seconds == null) return DASH;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Compact "how long ago" for an uncalled lead — its waiting time, the urgency. */
function ago(iso: string): string {
  const s = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

function shortDate(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
  });
}

/**
 * Colour a response time by how fast it was — green ≤5m, blue ≤1h, amber slower.
 *
 * The middle rung was `var(--accent)`, the per-client brand colour. That is a
 * rung in an ORDINAL scale sitting between good and warning, so a client whose
 * brand is red made "within an hour" indistinguishable from critical, and a
 * green brand collided with good. Identity colour must never carry a position
 * in a scale; `--seq-450` is fixed and sits cleanly between the two statuses.
 */
function toneFor(seconds: number | null): string {
  if (seconds == null) return "var(--status-critical)";
  if (seconds <= 300) return "var(--status-good)";
  if (seconds <= 3600) return "var(--seq-450)";
  return "var(--status-warning)";
}

function LeadRow({ row, timezone }: { row: SpeedToLeadRow; timezone: string }) {
  const tone = toneFor(row.secondsToCall);
  const leadIn = new Date(row.leadInAt).toLocaleString("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div
      className="flex items-center justify-between gap-3 py-2"
      style={{ borderTop: "1px solid var(--border)" }}
    >
      <div className="min-w-0">
        <div
          className="truncate text-[13px]"
          style={{ color: "var(--text-primary)" }}
        >
          {row.name ?? "Unnamed lead"}
        </div>
        <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          in {leadIn}
        </div>
      </div>
      <span
        className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums"
        style={{
          color: tone,
          background: `color-mix(in srgb, ${tone} 14%, transparent)`,
        }}
      >
        {row.status === "called"
          ? formatDuration(row.secondsToCall)
          : `Not called · ${ago(row.leadInAt)}`}
      </span>
    </div>
  );
}

/**
 * Speed-to-lead: how fast a new lead gets its first outbound call.
 *
 * Call history — like GHL stage history — only accumulates FORWARD, from the
 * moment we first received a call event (`trackingStartedAt`). Leads that
 * arrived earlier have no knowable first-call time, so they are shown as an
 * "before tracking" count, NEVER as red "not called" — mislabelling them as
 * misses is the exact silent-failure this dashboard exists to replace.
 *
 * The median and the response-time bars are computed over TRACKABLE leads only
 * (those that arrived after tracking went live); a trackable lead never called
 * counts against the SLA. The per-lead list is the actionable set — misses
 * first, then slowest calls.
 */
export function SpeedToLeadWidget({
  data,
  timezone,
}: {
  data: SpeedToLead;
  timezone: string;
}) {
  const {
    trackingStartedAt,
    leads,
    trackable,
    preTracking,
    called,
    uncalled,
    medianSeconds,
    within5m,
    within1h,
    within24h,
    rows,
  } = data;

  const trackingLabel = trackingStartedAt
    ? shortDate(trackingStartedAt, timezone)
    : null;

  const buckets = [
    { label: "within 5 min", n: within5m, tone: "var(--status-good)" },
    // Same ordinal scale as toneFor — must stay the fixed hue, not the brand.
    { label: "within 1 hour", n: within1h, tone: "var(--seq-450)" },
    { label: "within 24 hours", n: within24h, tone: "var(--text-secondary)" },
  ];

  const header = (
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
        {trackingLabel
          ? `tracking since ${trackingLabel}`
          : "no call events yet"}
      </div>
    </div>
  );

  // A muted line accounting for leads we simply cannot measure. Keeps the number
  // honest instead of dropping them or counting them as misses.
  const preTrackingNote = preTracking > 0 && (
    <p className="mt-4 text-xs" style={{ color: "var(--text-muted)" }}>
      {preTracking} earlier lead{preTracking === 1 ? "" : "s"} arrived before
      call tracking — first-call time unknown.
    </p>
  );

  return (
    <section className="card p-5">
      {header}

      {leads === 0 ? (
        <p className="mt-6 text-sm" style={{ color: "var(--text-muted)" }}>
          No leads arrived in this period.
        </p>
      ) : trackingStartedAt == null ? (
        // We have never received a call event — nothing is measurable yet.
        <>
          <p
            className="mt-5 text-sm"
            style={{ color: "var(--text-secondary)" }}
          >
            No outbound-call events have arrived from GoHighLevel yet.
            Speed-to-lead starts measuring the moment the first call is
            recorded, then fills in going forward.
          </p>
          {preTrackingNote}
        </>
      ) : trackable === 0 ? (
        // Tracking is live, but no lead has arrived since it went live.
        <>
          <p
            className="mt-5 text-sm"
            style={{ color: "var(--text-secondary)" }}
          >
            No new leads since call tracking went live on {trackingLabel}. This
            fills in as new leads arrive and get their first call.
          </p>
          {preTrackingNote}
        </>
      ) : (
        <>
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
              <div
                className="mt-1.5 text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                {called === 0
                  ? `0 of ${trackable} called`
                  : "median to first call"}
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              {buckets.map((b) => {
                // Denominator is trackable leads — the ones we could measure.
                const p = pct(b.n, trackable);
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
                        <span style={{ color: "var(--text-muted)" }}>
                          ({p}%)
                        </span>
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

          {preTrackingNote}

          {rows.length > 0 && (
            <div className="mt-5">
              <div className="flex items-center justify-between">
                <span
                  className="text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--text-muted)" }}
                >
                  Per lead
                </span>
                <span
                  className="text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  time to first call
                </span>
              </div>
              <div className="mt-1 max-h-[320px] overflow-y-auto">
                {rows.map((row, i) => (
                  <LeadRow key={i} row={row} timezone={timezone} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
