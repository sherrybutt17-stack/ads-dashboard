import {
  VERDICT_LABEL,
  describeTarget,
  formatMetricValue,
  monthLabel,
  nextMonthKey,
  type Accountability,
  type Commitment,
  type CommitmentStatus,
  type ResolvedCommitment,
} from "@/lib/commentary/model";
import type { CommentaryForReport } from "@/lib/commentary/report";

/**
 * The monthly commentary, on the client's document.
 *
 * ── The order is the argument ───────────────────────────────────────────
 *
 * Last month's plan comes FIRST, before the account of what was done and before
 * the plan for next month. A report that opens with new promises and buries the
 * old ones is a sales document; opening with "here is what we said we would do,
 * and here is what happened" is the thing that makes the next promise worth
 * anything.
 *
 * ── Two rules this component must not be talked out of ──────────────────
 *
 * 🔴 **Unanswered commitments render.** They are not filtered out, and the count
 * sits in the heading. The failure mode of every accountability feature is that
 * the answering quietly stops while the section still looks full; a promise with
 * no answer showing as "Not answered" on the client's own copy is the only
 * pressure that reliably works.
 *
 * 🔴 **A missed target renders in full — target, actual, and the word "Missed".**
 * The number was computed by the metrics engine, not typed, so this is the one
 * part of the document nobody can soften. Hiding it would make every "Met" above
 * it worthless.
 */

const STATUS_LOOK: Record<
  CommitmentStatus,
  { label: string; color: string; muted?: boolean }
> = {
  met: { label: "Met", color: "var(--status-good)" },
  missed: { label: "Missed", color: "var(--status-critical)" },
  unmeasurable: { label: "Not measurable", color: "var(--text-muted)", muted: true },
  done: { label: VERDICT_LABEL.done, color: "var(--status-good)" },
  partly: { label: VERDICT_LABEL.partly, color: "var(--status-warning)" },
  not_done: { label: VERDICT_LABEL.not_done, color: "var(--status-critical)" },
  dropped: { label: VERDICT_LABEL.dropped, color: "var(--text-muted)", muted: true },
  unanswered: { label: "Not answered", color: "var(--status-warning)" },
};

function Chip({ status }: { status: CommitmentStatus }) {
  const look = STATUS_LOOK[status];
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={{
        color: look.color,
        border: `1px solid ${look.muted ? "var(--border)" : look.color}`,
        background: look.muted
          ? "transparent"
          : `color-mix(in srgb, ${look.color} 10%, transparent)`,
      }}
    >
      {/* The word carries the meaning; the colour only reinforces it. */}
      {look.label}
    </span>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-[11px] tracking-wide uppercase"
      style={{ color: "var(--text-muted)" }}
    >
      {children}
    </p>
  );
}

/** Prose typed into a textarea. Blank lines separate paragraphs. */
function Prose({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p
          key={i}
          className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-line"
          style={{ color: "var(--text-secondary)" }}
        >
          {p}
        </p>
      ))}
    </>
  );
}

function AnsweredItem({
  item,
  currency,
}: {
  item: ResolvedCommitment;
  currency: string;
}) {
  const target = item.commitment.target;
  return (
    <li className="avoid-break border-t pt-2" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] leading-snug" style={{ color: "var(--text-primary)" }}>
          {item.commitment.text}
        </p>
        <Chip status={item.status} />
      </div>
      {target && (
        <p className="tnum mt-1 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
          {describeTarget(target, currency)} ·{" "}
          {item.status === "unmeasurable"
            ? "no figure recorded for this month"
            : `actual ${formatMetricValue(target.metric, item.actual, currency)}`}
        </p>
      )}
      {item.note && (
        <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {item.note}
        </p>
      )}
    </li>
  );
}

function PlannedItem({
  commitment,
  currency,
}: {
  commitment: Commitment;
  currency: string;
}) {
  return (
    <li className="avoid-break border-t pt-2" style={{ borderColor: "var(--border)" }}>
      <p className="text-[13px] leading-snug" style={{ color: "var(--text-primary)" }}>
        {commitment.text}
      </p>
      {commitment.target && (
        <p className="tnum mt-1 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
          Target: {describeTarget(commitment.target, currency)}
        </p>
      )}
    </li>
  );
}

/**
 * The heading line for the accountability block.
 *
 * States coverage before anything else, because "5 commitments, 2 still
 * unanswered" is the fact a reader most needs and the one an agency has the
 * most incentive to leave out.
 */
function coverageLine(a: Accountability): { text: string; warn: boolean } {
  const judged = a.counts.met + a.counts.missed;
  const parts: string[] = [];
  if (judged > 0) parts.push(`${a.counts.met} of ${judged} measured targets met`);
  if (a.unanswered > 0) {
    parts.push(`${a.unanswered} of ${a.total} not answered`);
  }
  return {
    text: parts.join(" · "),
    warn: a.unanswered > 0,
  };
}

export function CommentaryBlock({ commentary }: { commentary: CommentaryForReport }) {
  const { month, did, commitments, accountability, currency } = commentary;
  const coverage = accountability ? coverageLine(accountability) : null;

  return (
    <section className="card avoid-break p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {monthLabel(month)}
        </h2>
        {/*
         * Labelled with its month even when the report covers exactly that
         * month. The report range can be anything — "last 30 days" ending on the
         * 14th is not August — and prose about a month sitting unlabelled above
         * figures for a different window is precisely the kind of quiet mismatch
         * this product exists to remove.
         */}
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Monthly commentary
        </span>
      </div>

      {accountability && (
        <div className="mt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Heading>
              What we said we&rsquo;d do in {monthLabel(month)}
            </Heading>
            {coverage && coverage.text && (
              <span
                className="text-[11px]"
                style={{
                  color: coverage.warn ? "var(--status-warning)" : "var(--text-muted)",
                }}
              >
                {coverage.text}
              </span>
            )}
          </div>
          <ul className="mt-1.5 grid gap-2">
            {accountability.items.map((item) => (
              <AnsweredItem
                key={item.commitment.id}
                item={item}
                currency={currency}
              />
            ))}
          </ul>
        </div>
      )}

      {did.trim() !== "" && (
        <div className="mt-4">
          <Heading>What we did in {monthLabel(month)}</Heading>
          <Prose text={did} />
        </div>
      )}

      {commitments.length > 0 && (
        <div className="mt-4">
          <Heading>What&rsquo;s next — {monthLabel(nextMonthKey(month))}</Heading>
          <ul className="mt-1.5 grid gap-2">
            {commitments.map((c) => (
              <PlannedItem key={c.id} commitment={c} currency={currency} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
