import {
  humanChange,
  humanMarketChange,
  RECENT_DAYS,
  FATIGUE_DAYS,
  RESET_GAP_DAYS,
  type CreativeFatigue as Finding,
  type FatigueReport,
  type SignalFinding,
} from "@/lib/metrics/fatigue";
import { formatCurrency, formatPercent } from "@/lib/metrics/compute";
import { dayLabel } from "@/lib/dates";
import { Icon } from "@/components/Icon";

/**
 * Creative fatigue — the ads that used to work.
 *
 * The panel is deliberately not a list of scores. Every row states the two
 * numbers it is between, the dates each was measured over, and how sure the
 * engine is — because the action it implies costs a day of somebody's time and
 * "fatigue score: 78" is not something a client can argue with.
 *
 * ---
 *
 * THE EMPTY STATES ARE THE DESIGN, as in the anomaly panel. An empty list has
 * four different causes here, and they mean opposite things:
 *
 *   · nothing has tired            → genuine reassurance
 *   · nothing has run long enough  → no basis for reassurance at all
 *   · ad-level data is not synced  → the panel cannot see creatives
 *   · everything is paused         → there is no decision to make
 */

const SEVERITY: Record<
  Finding["severity"],
  { label: string; color: string; icon: "alert" | "help" }
> = {
  fatigued: { label: "Refresh this", color: "var(--status-critical)", icon: "alert" },
  watch: { label: "Watch", color: "var(--status-warning)", icon: "help" },
};

/**
 * Whether a card quotes a frequency at all.
 *
 * Requires it to be measurable AND to have risen. See `FrequencyContext` for
 * why this is a daily figure and can be nothing else.
 */
function showsFrequency(f: Finding): boolean {
  return (
    f.frequency.available &&
    f.frequency.recent !== null &&
    f.frequency.baseline !== null &&
    f.frequency.recent > f.frequency.baseline
  );
}

function value(s: SignalFinding, v: number, currency: string): string {
  return s.kind === "percent" ? formatPercent(v) : formatCurrency(v, currency);
}

function SignalRow({ s, currency }: { s: SignalFinding; currency: string }) {
  const move = humanChange(s);
  const market = humanMarketChange(s);

  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1">
      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
        {s.label}
      </span>
      <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
        {value(s, s.baseline, currency)} → {value(s, s.recent, currency)}
      </span>
      {/*
       * Direction is spelled out, never colour alone — and the arrow follows
       * the metric the reader sees, so a rising CPM points up even though the
       * rate underneath it fell.
       */}
      <span
        className="text-xs font-medium tabular-nums"
        style={{ color: "var(--delta-bad)" }}
      >
        {move >= 0 ? "▲" : "▼"} {formatPercent(Math.abs(move), 0)}
      </span>
      {/*
       * 🔴 Three states, not two. `null` means there was no other creative with
       * enough delivery to compare against — which is NOT the same as "the rest
       * of the account was flat", and printing nothing would let the reader
       * assume the second. On a one-creative account that distinction is the
       * whole reliability of the finding.
       */}
      <span className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
        {Math.round(s.confidence * 100)}% confident ·{" "}
        {market === null
          ? "nothing to compare against"
          : Math.abs(market) < 0.02
            ? "rest of account flat"
            : `rest of account ${market >= 0 ? "+" : "−"}${formatPercent(Math.abs(market), 0)}, already taken out`}
      </span>
    </li>
  );
}

function Card({ f, currency }: { f: Finding; currency: string }) {
  const sev = SEVERITY[f.severity];

  return (
    <li className="flex items-start gap-3 py-3.5">
      {/*
       * The thumbnail is what makes this scannable — an agency recognises the
       * ad before it reads the name. Meta's thumbnail URLs expire, so a broken
       * one must degrade to the placeholder rather than a torn image icon.
       */}
      <div
        className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded"
        style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
      >
        {f.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={f.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <Icon name="image" size={16} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span
            className="text-[13px] font-medium"
            style={{ color: "var(--text-primary)" }}
          >
            {f.name}
          </span>
          <span
            className="inline-flex items-baseline gap-1 text-[11px] font-semibold"
            style={{ color: sev.color }}
          >
            <span aria-hidden className="translate-y-px">
              <Icon name={sev.icon} size={11} />
            </span>
            {sev.label}
          </span>
          <span className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
            {formatCurrency(f.recentSpend, currency)} in the last {f.recentDays} days it
            ran
          </span>
        </div>

        <ul className="mt-1">
          {f.signals.map((s) => (
            <SignalRow key={s.id} s={s} currency={currency} />
          ))}
        </ul>

        <p
          className="mt-1 text-[11px] leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          {dayLabel(f.baselineRange[0])}–{dayLabel(f.baselineRange[1])} ({f.baselineDays}{" "}
          days it ran) against {dayLabel(f.recentRange[0])}–{dayLabel(f.recentRange[1])}.
          {/*
           * Only when it actually rose. An unchanged frequency printed beside a
           * fatigue finding reads as corroboration for a number that did not
           * move — and saturation is the mechanism people will reach for first,
           * so a spurious one here is the most likely to be believed.
           */}
          {showsFrequency(f) ? (
            <>
              {" "}
              Daily frequency {f.frequency.baseline!.toFixed(2)} →{" "}
              {f.frequency.recent!.toFixed(2)}.
            </>
          ) : null}
          {f.gapDays >= RESET_GAP_DAYS
            ? ` It was off for ${f.gapDays} days in between, which can reset audience saturation and makes the two windows less comparable.`
            : ""}
          {f.learning
            ? " An ad set running it has not exited learning, so recent delivery is not yet at steady state."
            : ""}
        </p>
      </div>
    </li>
  );
}

export function CreativeFatiguePanel({
  report,
  currency,
  adLevelSynced,
}: {
  report: FatigueReport;
  currency: string;
  adLevelSynced: boolean;
}) {
  const { findings, judged, hidden, skipped, costOnly } = report;
  const anyCreatives =
    judged + skipped.inactive + skipped.tooNew + skipped.tooSmall > 0;

  return (
    <section className="card p-5" aria-label="Creative fatigue">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Creative fatigue
        </h2>
        <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
          {judged === 0
            ? "nothing to judge"
            : `${judged} creative${judged === 1 ? "" : "s"} checked`}
        </span>
      </div>

      {!adLevelSynced ? (
        <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          Ad-level data has not been synced for this account yet, so there are no
          creatives to compare. This is not a statement about the ads — it is a
          statement about the sync.
        </p>
      ) : !anyCreatives ? (
        <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          No creative delivered in the last {FATIGUE_DAYS} days.
        </p>
      ) : findings.length > 0 ? (
        <>
          <ul className="mt-1 divide-y" style={{ borderColor: "var(--border)" }}>
            {findings.map((f) => (
              <Card key={f.creativeKey} f={f} currency={currency} />
            ))}
          </ul>
          {hidden > 0 && (
            <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
              {hidden} more creative{hidden === 1 ? "" : "s"} met the bar and{" "}
              {hidden === 1 ? "is" : "are"} not shown — the list is capped at five so
              it stays a work queue.
            </p>
          )}
        </>
      ) : judged === 0 ? (
        <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          Nothing has run long enough to have a &ldquo;before&rdquo;. A creative needs
          about {RECENT_DAYS * 2} days of delivery before this can tell a decline from
          an ordinary week — until then, silence here means <em>we cannot tell</em>,
          not <em>all clear</em>.
        </p>
      ) : (
        <div className="mt-4 flex items-start gap-2.5">
          <span style={{ color: "var(--status-good)" }} className="mt-0.5">
            <Icon name="check" size={14} />
          </span>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            No creative is performing measurably worse than it used to. Every asset
            still running is within its own normal range on click-through, hook rate
            and cost.
          </p>
        </div>
      )}

      {/*
       * 🔴 The frequency caveat, printed only where a frequency is. Everyone in
       * this category quotes "frequency" meaning the 7-day figure, and the
       * familiar rule of thumb is attached to that number. Ours cannot be that
       * number — see `FrequencyContext` — so it has to say so where it is read,
       * not in a documentation comment nobody opens.
       */}
      {findings.some(showsFrequency) && (
        <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {findings.find(showsFrequency)!.frequency.note}
        </p>
      )}

      {/*
       * 🔴 Stated whether or not there are findings. "Your CPM went up" is the
       * sentence every fatigue tool in this category prints as a fatigue alert,
       * and it is usually the auction — which no new creative fixes.
       */}
      {costOnly > 0 && (
        <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {costOnly} creative{costOnly === 1 ? " got" : "s got"} more expensive without
          losing engagement. That is the auction, not the advertising, so{" "}
          {costOnly === 1 ? "it is" : "they are"} not listed above — a new video does
          not lower a CPM.
        </p>
      )}

      {(skipped.tooNew > 0 || skipped.inactive > 0 || skipped.tooSmall > 0) && (
        <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Not judged:{" "}
          {[
            skipped.tooNew > 0 && `${skipped.tooNew} too new`,
            skipped.inactive > 0 && `${skipped.inactive} not running`,
            skipped.tooSmall > 0 && `${skipped.tooSmall} under the spend floor`,
          ]
            .filter(Boolean)
            .join(", ")}
          .
        </p>
      )}

      <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Each creative is compared against its own earlier weeks, with whatever the
        rest of the account did over the same days taken out — so a seasonal swing
        that moved every ad does not read as one ad tiring. Confidence is the
        probability the drop is real rather than the week&rsquo;s noise, judged
        against how much this creative normally varies day to day.
      </p>
    </section>
  );
}
