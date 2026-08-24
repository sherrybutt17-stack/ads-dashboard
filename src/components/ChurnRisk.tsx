import Link from "next/link";
import type { ChurnClient, ChurnLevel, ChurnReport, ChurnSignal } from "@/lib/metrics/churn";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/metrics/compute";
import { Icon } from "@/components/Icon";

/**
 * Which relationship is in trouble.
 *
 * Agency-facing and never shown to a client — nobody should read "you look like
 * you are about to leave" about themselves, and the whole panel is gated on the
 * staff check in `page.tsx` for that reason.
 *
 * 🔴 **No score anywhere.** Every line here is two numbers and a sentence about
 * what changed between them, because that is what a manager can act on in three
 * seconds and dismiss in one when they already know the reason. A percentage
 * would have to come from a model of churn, and this system has never observed
 * a churn to fit one against.
 */

const LEVEL_LABEL: Record<ChurnLevel, string> = {
  talk: "worth a call",
  watch: "worth a look",
  none: "steady",
  unknown: "too new to judge",
};

function LevelChip({ level }: { level: ChurnLevel }) {
  if (level === "none" || level === "unknown") return null;
  const critical = level === "talk";
  return (
    <span
      className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide uppercase"
      style={{
        background: critical
          ? "color-mix(in srgb, var(--status-critical) 14%, transparent)"
          : "color-mix(in srgb, var(--status-warning) 14%, transparent)",
        color: critical ? "var(--status-critical)" : "var(--status-warning)",
      }}
    >
      {LEVEL_LABEL[level]}
    </span>
  );
}

/** The chip that sits on a client's row in the list. */
export function ChurnChip({ level }: { level: ChurnLevel | undefined }) {
  return level === undefined ? null : <LevelChip level={level} />;
}

/**
 * One observation, in words, with the numbers that produced it.
 *
 * Prose rather than a metric row on purpose: these are read once a week by
 * somebody deciding whether to pick up a phone, and "spend fell from $1,240 to
 * $310" is a sentence they can repeat on that call.
 */
function SignalLine({ signal, currency }: { signal: ChurnSignal; currency: string }) {
  const money = (v: number) => formatCurrency(v, currency);
  const drop =
    signal.change !== null ? formatPercent(Math.abs(signal.change), 0) : null;

  const body = (() => {
    switch (signal.id) {
      case "spend_stopped":
        return (
          <>
            <strong>The ads have stopped.</strong> Spend went from{" "}
            <span className="tnum">{money(signal.prior)}</span> to{" "}
            <span className="tnum">{money(signal.recent)}</span>.
          </>
        );
      case "spend_down":
        return (
          <>
            <strong>Budget cut.</strong> Spend fell {drop} — from{" "}
            <span className="tnum">{money(signal.prior)}</span> to{" "}
            <span className="tnum">{money(signal.recent)}</span>
            {/* Four consecutive falls reads very differently from one step
                down, so it is said only when it is actually true. */}
            {signal.everyWeek && <>, and it has fallen every week for four weeks</>}
            .
          </>
        );
      case "results_down":
        return (
          <>
            <strong>Fewer leads for the same money.</strong>{" "}
            <span className="tnum">{formatNumber(signal.prior)}</span> leads down to{" "}
            <span className="tnum">{formatNumber(signal.recent)}</span> while spend
            held.{" "}
            <span style={{ color: "var(--text-muted)" }}>
              {/*
               * Stated as what it is — how unlikely a fall this large is if
               * nothing actually changed — rather than dressed up as a risk
               * figure. A reader can weigh it or ignore it; they cannot
               * misread it as a probability of churn.
               */}
              A drop this size happens{" "}
              {(signal.p ?? 1) < 0.01
                ? "less than once in a hundred"
                : `about once in ${Math.round(1 / (signal.p ?? 0.05))}`}{" "}
              fortnights by chance alone.
            </span>
          </>
        );
      case "nothing_landing":
        return (
          <>
            <strong>Money going out, nothing coming back.</strong>{" "}
            <span className="tnum">{money(signal.spend ?? 0)}</span> spent and{" "}
            {signal.recent === 0 ? "no leads at all" : `${formatNumber(signal.recent)} leads`}{" "}
            in the last four weeks.
          </>
        );
      case "pipe_dead":
        return (
          <>
            <strong>
              {signal.days === null
                ? "The CRM has never sent anything."
                : `No CRM events for ${formatNumber(signal.days ?? 0)} days.`}
            </strong>{" "}
            <span style={{ color: "var(--text-muted)" }}>
              {/*
               * 🔴 Both halves matter. The lead figures cannot be believed while
               * this is true — and a pipe dead for weeks with nobody noticing is
               * a relationship signal in its own right.
               */}
              Lead numbers for this client cannot be trusted until it is fixed,
              so they are not being judged — and nobody has noticed.
            </span>
          </>
        );
    }
  })();

  return (
    <li className="text-[12.5px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
      {body}
    </li>
  );
}

function ClientBlock({ client }: { client: ChurnClient }) {
  return (
    <div className="border-t pt-3 first:border-0 first:pt-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center gap-2">
        <Link
          href={`/c/${client.slug}`}
          className="text-[13px] font-semibold hover:underline"
          style={{ color: "var(--text-primary)" }}
        >
          {client.name}
        </Link>
        <LevelChip level={client.level} />
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {client.signals.map((s) => (
          <SignalLine key={s.id} signal={s} currency={client.currency} />
        ))}
      </ul>
    </div>
  );
}

export function ChurnRiskPanel({
  report,
  error,
}: {
  report: ChurnReport;
  error: string | null;
}) {
  const header = (
    <div>
      <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Worth a conversation
      </h2>
      <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
        The last {report.blockDays} days against the {report.blockDays} before them,
        per client
      </p>
    </div>
  );

  if (error) {
    return (
      <section className="card mb-4 p-5">
        {header}
        <p className="mt-4 text-sm" style={{ color: "var(--status-critical)" }}>
          {/* The panel failing must never look like a book with nothing wrong
              in it — the same rule the roll-up beside it follows. */}
          Could not read the weekly figures, so no client has been checked.
          <span className="mt-1 block text-xs" style={{ color: "var(--text-muted)" }}>
            {error}
          </span>
        </p>
      </section>
    );
  }

  const footer = (
    <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
      {report.steady > 0 && (
        <>
          {formatNumber(report.steady)} client{report.steady === 1 ? "" : "s"} steady.{" "}
        </>
      )}
      {report.unknown > 0 && (
        <>
          {/*
           * 🔴 Counted separately from steady, always. Rolled together, "9
           * clients look fine" would include three nobody could form an opinion
           * about — the reassuring-summary failure this product replaces.
           */}
          {formatNumber(report.unknown)} too new or too quiet to judge.{" "}
        </>
      )}
      {report.flagged.length > 1 && (
        <>
          Ordered by how many separate things are off, which is not a ranking of
          risk —{" "}
        </>
      )}
      {report.flagged.length > 0 && (
        <>
          each line is what changed and by how much, not a prediction. There is no
          history of past departures here to calibrate one against.
        </>
      )}
    </p>
  );

  if (report.flagged.length === 0) {
    /*
     * 🔴 A slim line, not a card — but never nothing.
     *
     * A section that silently vanishes when it has no findings is exactly how a
     * block in the old spreadsheet went empty for months without anyone
     * noticing: absence reads as "not built" rather than "checked and clear".
     * So the all-clear still renders, and still separates the clients that were
     * checked from the ones that could not be.
     */
    if (report.steady === 0 && report.unknown === 0) return null;
    return (
      <div className="mb-4 flex items-start gap-2 px-1">
        <span
          className="mt-0.5 shrink-0"
          style={{ color: report.steady > 0 ? "var(--status-good)" : "var(--text-muted)" }}
        >
          <Icon name={report.steady > 0 ? "check" : "alert"} size={13} />
        </span>
        <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {report.steady > 0 ? (
            <>
              No client is spending or producing less than the {report.blockDays} days
              before.{" "}
            </>
          ) : (
            <>No client has enough history yet to be judged either way. </>
          )}
          {report.steady > 0 && (
            <>
              {formatNumber(report.steady)} checked
              {report.unknown > 0 && ", "}
            </>
          )}
          {report.unknown > 0 && (
            <>
              {/*
               * Never folded into "checked". "9 clients look fine" that quietly
               * includes three nobody could form an opinion about is the
               * reassuring-summary failure this product exists to replace.
               */}
              {formatNumber(report.unknown)} too new or too quiet to judge
            </>
          )}
          .
        </p>
      </div>
    );
  }

  return (
    <section className="card mb-4 p-5">
      {header}
      <div className="mt-4 flex flex-col gap-3">
        {report.flagged.map((c) => (
          <ClientBlock key={c.clientId} client={c} />
        ))}
      </div>
      {footer}
    </section>
  );
}
