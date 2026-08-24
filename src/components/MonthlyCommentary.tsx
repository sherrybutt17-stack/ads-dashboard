"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import {
  TARGET_METRICS,
  TARGET_METRIC_DEFS,
  VERDICTS,
  VERDICT_LABEL,
  defaultDirection,
  describeTarget,
  formatMetricValue,
  judgeTarget,
  monthLabel,
  nextMonthKey,
  previousMonthKey,
  MAX_COMMITMENTS,
  MAX_COMMITMENT_CHARS,
  MAX_NOTE_CHARS,
  type Commitment,
  type CommitmentTarget,
  type MetricSource,
  type Outcome,
  type TargetMetric,
} from "@/lib/commentary/model";
// Type-only, so the store — and the database client behind it — is erased.
import type { StoredCommentary } from "@/lib/commentary/store";

/**
 * The monthly commentary editor. Staff only; filtered out of a client's
 * registry entirely.
 *
 * ---
 *
 * THE SHAPE OF THIS PANEL IS THE ARGUMENT — twice over.
 *
 * **1 · Last month's plan is at the top, and it cannot be skipped past.** The
 * writing box is below it. Every accountability feature ever built dies the same
 * way: the plan is written, the month passes, nobody goes back, and the section
 * quietly becomes a list of aspirations with no results attached. Putting last
 * month's promises first — with an unanswered count in the heading — means the
 * cost of ignoring them is paid at the moment of writing rather than never.
 *
 * **2 · A commitment carrying a target has no verdict selector.** The number
 * decides, the panel prints what it decided, and the only thing a person can add
 * is a note. This is the difference between a report and a press release, and
 * it is deliberately not configurable.
 */

type Props = {
  slug: string;
  platform: string;
  month: string;
  /** Months with anything written or published, newest first — for the picker. */
  months: string[];
  initial: {
    current: StoredCommentary | null;
    prior: { month: string; commitments: Commitment[]; published: boolean } | null;
    actuals: MetricSource | null;
    currency: string;
    error: string | null;
  };
};

type Busy = null | "saving" | "publishing" | "loading";

/**
 * Ids are generated here rather than server-side because a commitment must be
 * addressable while it is still being typed — the note attached to it lives in a
 * different array. `crypto.randomUUID` is available in every browser this app
 * supports; the fallback exists for the jsdom test environment.
 */
function newId(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 18)
    : `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function MonthlyCommentary({ slug, platform, month, months, initial }: Props) {
  const [state, setState] = useState(initial);
  const [viewing, setViewing] = useState(month);
  const [did, setDid] = useState(initial.current?.did ?? "");
  const [commitments, setCommitments] = useState<Commitment[]>(
    initial.current?.commitments ?? [],
  );
  const [outcomes, setOutcomes] = useState<Outcome[]>(initial.current?.outcomes ?? []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const { prior, actuals, currency } = state;
  const stored = state.current;
  const priorMonth = prior?.month ?? previousMonthKey(viewing);

  function adopt(next: Props["initial"], nextMonth: string) {
    setState(next);
    setViewing(nextMonth);
    setDid(next.current?.did ?? "");
    setCommitments(next.current?.commitments ?? []);
    setOutcomes(next.current?.outcomes ?? []);
    setDirty(false);
  }

  async function loadMonth(next: string) {
    if (next === viewing) return;
    if (dirty && !confirm("Discard your unsaved changes to this month?")) return;
    setBusy("loading");
    setError(null);
    setNote(null);
    try {
      const res = await fetch(
        `/api/c/${slug}/commentary?month=${next}&platform=${platform}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Could not load ${monthLabel(next)}.`);
        return;
      }
      adopt(json, next);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("saving");
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/c/${slug}/commentary`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month: viewing, platform, did, commitments, outcomes }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Could not save (${res.status}).`);
        return;
      }
      setState((s) => ({ ...s, current: json.commentary as StoredCommentary }));
      setDirty(false);
      setNote("Saved.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function setPublished(next: boolean) {
    setBusy("publishing");
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/c/${slug}/commentary/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month: viewing, platform, published: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Could not ${next ? "publish" : "withdraw"}.`);
        return;
      }
      setState((s) => ({ ...s, current: json.commentary as StoredCommentary }));
      setNote(next ? "Published to the client's report." : "Withdrawn.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  /* ---------------- commitment editing ---------------- */

  function mutate(fn: (list: Commitment[]) => Commitment[]) {
    setCommitments((list) => fn(list));
    setDirty(true);
  }

  const addCommitment = () =>
    mutate((list) =>
      list.length >= MAX_COMMITMENTS
        ? list
        : [...list, { id: newId(), text: "", target: null }],
    );

  const setText = (id: string, text: string) =>
    mutate((list) => list.map((c) => (c.id === id ? { ...c, text } : c)));

  const removeCommitment = (id: string) =>
    mutate((list) => list.filter((c) => c.id !== id));

  const setTarget = (id: string, target: CommitmentTarget | null) =>
    mutate((list) => list.map((c) => (c.id === id ? { ...c, target } : c)));

  function answer(commitmentId: string, patch: Partial<Omit<Outcome, "commitmentId">>) {
    setOutcomes((list) => {
      const existing = list.find((o) => o.commitmentId === commitmentId);
      if (!existing) {
        return [...list, { commitmentId, verdict: "done", note: "", ...patch }];
      }
      return list.map((o) => (o.commitmentId === commitmentId ? { ...o, ...patch } : o));
    });
    setDirty(true);
  }

  const answerFor = (id: string) => outcomes.find((o) => o.commitmentId === id) ?? null;

  /* ---------------- derived ---------------- */

  const priorList = prior?.published ? prior.commitments : [];
  const unanswered = priorList.filter(
    (c) => c.target === null && !answerFor(c.id),
  ).length;

  const disabled = busy !== null || Boolean(state.error);
  const canSave = dirty && commitments.every((c) => c.text.trim() !== "");

  return (
    <section className="card p-5" aria-label="Monthly commentary">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Monthly commentary
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            What we did and what happens next — written per calendar month, and
            answered against next month&rsquo;s figures.
          </p>
        </div>
        <span
          className="rounded-full px-2 py-0.5 text-[11px]"
          style={{
            background: "var(--surface-1)",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
          }}
        >
          agency only
        </span>
      </div>

      {/* Month picker. Independent of the dashboard's date range on purpose —
          commentary is monthly and a 30-day window is not a month. */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {months.map((m) => {
          const active = m === viewing;
          return (
            <button
              key={m}
              type="button"
              onClick={() => loadMonth(m)}
              disabled={busy !== null}
              aria-pressed={active}
              className="rounded-full px-3 py-1 text-xs transition-colors disabled:opacity-50"
              style={{
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                background: active
                  ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                  : "transparent",
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
                fontWeight: active ? 600 : 400,
              }}
            >
              {monthLabel(m)}
            </button>
          );
        })}
      </div>

      {state.error && (
        <p
          className="mt-4 rounded-[10px] border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: "var(--text-secondary)",
          }}
        >
          Commentary is unavailable — the table has not been created yet. Run the
          database push and this panel will start working; nothing else on this
          page is affected.
        </p>
      )}

      {/* ── Last month's plan, first ──────────────────────────────────── */}
      <div className="mt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3
            className="text-[13px] font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            What we said we&rsquo;d do in {monthLabel(viewing)}
          </h3>
          {priorList.length > 0 && (
            <span
              className="text-[11.5px]"
              style={{
                color: unanswered > 0 ? "var(--status-warning)" : "var(--text-muted)",
              }}
            >
              {unanswered > 0
                ? `${unanswered} still unanswered`
                : "all answered"}
            </span>
          )}
        </div>

        {priorList.length === 0 ? (
          <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {!prior
              ? `Nothing was written for ${monthLabel(priorMonth)}, so there is no plan to report against. Write one below and it will appear here next month.`
              : prior.published
                ? `${monthLabel(priorMonth)}'s commentary was published without a plan for this month.`
                : /*
                   * 🔴 Stated rather than silently ignored. The report reads the
                   * previous month's PUBLISHED commitments, so an unpublished
                   * plan is a private note, not a promise — and a panel that
                   * quietly showed nothing here would look broken instead of
                   * pointed.
                   */
                  `${monthLabel(priorMonth)}'s plan was never published, so it was never shown to the client and is not carried forward. Publish that month to hold it to account here.`}
          </p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {priorList.map((c) => (
              <PriorItem
                key={c.id}
                commitment={c}
                actuals={actuals}
                currency={currency}
                answer={answerFor(c.id)}
                onAnswer={(patch) => answer(c.id, patch)}
                disabled={disabled}
              />
            ))}
          </ul>
        )}
      </div>

      {/* ── What we did ───────────────────────────────────────────────── */}
      <div className="mt-5">
        <label
          htmlFor="commentary-did"
          className="text-[13px] font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          What we did in {monthLabel(viewing)}
        </label>
        <textarea
          id="commentary-did"
          value={did}
          onChange={(e) => {
            setDid(e.target.value);
            setDirty(true);
          }}
          rows={5}
          placeholder="The work behind the numbers — what was changed, tested, cut or launched."
          className="mt-1.5 w-full rounded-[10px] border px-3 py-2 text-sm leading-relaxed"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      {/* ── The plan ──────────────────────────────────────────────────── */}
      <div className="mt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3
            className="text-[13px] font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            What&rsquo;s next — the plan for {monthLabel(nextMonthKey(viewing))}
          </h3>
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {commitments.length}/{MAX_COMMITMENTS}
          </span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Each line comes back on next month&rsquo;s report.{" "}
          <strong style={{ color: "var(--text-secondary)" }}>
            Attach a number and the verdict is worked out from the figures — not
            typed in.
          </strong>
        </p>

        <ul className="mt-2 grid gap-2">
          {commitments.map((c) => (
            <PlanItem
              key={c.id}
              commitment={c}
              currency={currency}
              disabled={disabled}
              onText={(t) => setText(c.id, t)}
              onTarget={(t) => setTarget(c.id, t)}
              onRemove={() => removeCommitment(c.id)}
            />
          ))}
        </ul>

        <button
          type="button"
          onClick={addCommitment}
          disabled={disabled || commitments.length >= MAX_COMMITMENTS}
          className="mt-2 inline-flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-xs disabled:opacity-50"
          style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
        >
          <span aria-hidden="true">+</span> Add a line
        </button>
      </div>

      {error && (
        <p className="mt-4 text-xs" style={{ color: "var(--status-critical)" }} role="alert">
          {error}
        </p>
      )}
      {note && !error && (
        <p className="mt-4 text-xs" style={{ color: "var(--status-good)" }} role="status">
          {note}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || !canSave}
          onClick={save}
          title={
            dirty && !canSave ? "Every line needs some text before it can be saved." : undefined
          }
          className="rounded-[8px] border px-3 py-1.5 text-xs disabled:opacity-50"
          style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
        >
          {busy === "saving" ? "Saving…" : "Save"}
        </button>

        <span className="flex-1" />

        {stored?.published ? (
          <>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {stored.hasUnpublishedChanges
                ? "Edited since publishing — the client still sees the published version."
                : "Published — on the client's report."}
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setPublished(true)}
              className="rounded-[8px] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{
                background: stored.hasUnpublishedChanges ? "var(--accent)" : "transparent",
                color: stored.hasUnpublishedChanges ? "var(--accent-ink)" : "var(--text-muted)",
                border: stored.hasUnpublishedChanges ? "none" : "1px solid var(--border)",
              }}
            >
              {stored.hasUnpublishedChanges ? "Publish update" : "Republish"}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setPublished(false)}
              className="rounded-[8px] border px-3 py-1.5 text-xs disabled:opacity-50"
              style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
            >
              Withdraw
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled || !stored || dirty}
            title={
              dirty
                ? "Save first — publishing sends the saved text, not what is in the boxes."
                : undefined
            }
            onClick={() => setPublished(true)}
            className="flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            <Icon name="check" size={12} />
            {busy === "publishing" ? "Publishing…" : "Publish to client report"}
          </button>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Only a published month appears on a report. Publishing a plan is also what
        puts it on the record — next month&rsquo;s report carries forward the
        commitments that were published, and nothing else.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * One carried-forward commitment
 * ------------------------------------------------------------------ */

function PriorItem({
  commitment,
  actuals,
  currency,
  answer,
  onAnswer,
  disabled,
}: {
  commitment: Commitment;
  actuals: MetricSource | null;
  currency: string;
  answer: Outcome | null;
  onAnswer: (patch: Partial<Omit<Outcome, "commitmentId">>) => void;
  disabled: boolean;
}) {
  const judged = commitment.target ? judgeTarget(commitment.target, actuals) : null;

  return (
    <li
      className="rounded-[10px] border p-3"
      style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
    >
      <p className="text-[13px]" style={{ color: "var(--text-primary)" }}>
        {commitment.text}
      </p>

      {commitment.target && judged ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
            {describeTarget(commitment.target, currency)}
          </span>
          <StatusChip status={judged.status} />
          <span className="tnum text-[12px]" style={{ color: "var(--text-secondary)" }}>
            {judged.status === "unmeasurable"
              ? "no figure for this month"
              : `actual ${formatMetricValue(commitment.target.metric, judged.actual, currency)}`}
          </span>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {VERDICTS.map((v) => {
            const active = answer?.verdict === v;
            return (
              <button
                key={v}
                type="button"
                disabled={disabled}
                onClick={() => onAnswer({ verdict: v })}
                aria-pressed={active}
                className="rounded-full px-2.5 py-0.5 text-[11.5px] disabled:opacity-50"
                style={{
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  background: active
                    ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                    : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                {VERDICT_LABEL[v]}
              </button>
            );
          })}
          {!answer && (
            <span
              className="self-center text-[11.5px]"
              style={{ color: "var(--status-warning)" }}
            >
              unanswered — this shows on the report
            </span>
          )}
        </div>
      )}

      <input
        value={answer?.note ?? ""}
        onChange={(e) => onAnswer({ note: e.target.value })}
        disabled={disabled}
        maxLength={MAX_NOTE_CHARS}
        placeholder={
          commitment.target
            ? "Optional note — context the number does not carry."
            : "Optional note."
        }
        className="mt-2 w-full rounded-[8px] border px-2.5 py-1.5 text-[12.5px]"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface-2)",
          color: "var(--text-primary)",
        }}
      />
    </li>
  );
}

function StatusChip({ status }: { status: "met" | "missed" | "unmeasurable" }) {
  const look = {
    met: { color: "var(--status-good)", label: "Met" },
    missed: { color: "var(--status-critical)", label: "Missed" },
    unmeasurable: { color: "var(--text-muted)", label: "Not measurable" },
  }[status];
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: look.color,
        border: `1px solid ${look.color}`,
        background: `color-mix(in srgb, ${look.color} 10%, transparent)`,
      }}
    >
      {/* Never colour alone — the word carries the meaning on its own. */}
      {look.label}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * One line of the plan
 * ------------------------------------------------------------------ */

function PlanItem({
  commitment,
  currency,
  disabled,
  onText,
  onTarget,
  onRemove,
}: {
  commitment: Commitment;
  currency: string;
  disabled: boolean;
  onText: (t: string) => void;
  onTarget: (t: CommitmentTarget | null) => void;
  onRemove: () => void;
}) {
  const t = commitment.target;

  return (
    <li
      className="rounded-[10px] border p-3"
      style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
    >
      <div className="flex items-start gap-2">
        <input
          value={commitment.text}
          onChange={(e) => onText(e.target.value)}
          disabled={disabled}
          maxLength={MAX_COMMITMENT_CHARS}
          placeholder="e.g. Rebuild the top-of-funnel creative around the new offer"
          className="min-w-0 flex-1 rounded-[8px] border px-2.5 py-1.5 text-[13px]"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-2)",
            color: "var(--text-primary)",
          }}
        />
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label="Remove this line"
          className="btn-ghost rounded-[8px] px-2 py-1.5 disabled:opacity-50"
          style={{ color: "var(--text-muted)" }}
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {t === null ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onTarget({
                metric: "cpLead",
                direction: defaultDirection("cpLead"),
                value: 0,
              })
            }
            className="rounded-[7px] border px-2.5 py-1 text-[11.5px] disabled:opacity-50"
            style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
          >
            Attach a number
          </button>
        ) : (
          <>
            <select
              value={t.metric}
              onChange={(e) => {
                const metric = e.target.value as TargetMetric;
                onTarget({ ...t, metric, direction: defaultDirection(metric) });
              }}
              disabled={disabled}
              aria-label="Metric"
              className="rounded-[7px] border px-2 py-1 text-[11.5px]"
              style={{
                borderColor: "var(--border)",
                background: "var(--surface-2)",
                color: "var(--text-primary)",
              }}
            >
              {TARGET_METRICS.map((m) => (
                <option key={m} value={m}>
                  {TARGET_METRIC_DEFS[m].label}
                </option>
              ))}
            </select>
            <select
              value={t.direction}
              onChange={(e) =>
                onTarget({ ...t, direction: e.target.value as CommitmentTarget["direction"] })
              }
              disabled={disabled}
              aria-label="Direction"
              className="rounded-[7px] border px-2 py-1 text-[11.5px]"
              style={{
                borderColor: "var(--border)",
                background: "var(--surface-2)",
                color: "var(--text-primary)",
              }}
            >
              <option value="at_most">at most</option>
              <option value="at_least">at least</option>
            </select>
            <input
              type="number"
              min={0}
              step="any"
              value={Number.isFinite(t.value) ? t.value : 0}
              onChange={(e) => onTarget({ ...t, value: Number(e.target.value) })}
              disabled={disabled}
              aria-label="Target value"
              className="tnum w-24 rounded-[7px] border px-2 py-1 text-[11.5px]"
              style={{
                borderColor: "var(--border)",
                background: "var(--surface-2)",
                color: "var(--text-primary)",
              }}
            />
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {TARGET_METRIC_DEFS[t.metric].format === "percent"
                ? "%"
                : TARGET_METRIC_DEFS[t.metric].format === "currency"
                  ? currency
                  : TARGET_METRIC_DEFS[t.metric].format === "multiple"
                    ? "×"
                    : ""}
            </span>
            <button
              type="button"
              onClick={() => onTarget(null)}
              disabled={disabled}
              className="btn-ghost rounded-[7px] px-2 py-1 text-[11.5px] disabled:opacity-50"
              style={{ color: "var(--text-muted)" }}
            >
              Remove number
            </button>
          </>
        )}
      </div>
    </li>
  );
}
