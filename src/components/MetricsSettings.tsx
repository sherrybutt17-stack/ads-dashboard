"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { FormulaBuilder } from "@/components/FormulaBuilder";
import { AD_PLATFORMS, PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";
import { METRICS, METRIC_GROUPS, METRIC_IDS, metricLabel, type MetricFormat, type MetricId } from "@/lib/board/catalog";
import { CUSTOM_LIMITS, type CustomMetric, type CustomMetricDraft } from "@/lib/board/registry";
import { formulaText, type FormulaToken } from "@/lib/metrics/formula";
import type { Polarity } from "@/lib/metrics/compute";

/**
 * Settings → Metrics: the agency's own metrics, for every client's Board.
 *
 * Two kinds, as Whatagraph offers them: rename a platform's stat (your own
 * name and description for, say, Meta's "Leads"), or build a formula from
 * built-in stats. Every change goes to `/api/agency/metrics*` and then
 * `router.refresh()`, so what is listed is always the server's rows.
 *
 * A metric a board uses can't be deleted — deleting it would leave those
 * widgets unable to say what they showed — so it is archived instead: gone
 * from the picker, still working where it is used, and restorable.
 */

export type ListedMetric = CustomMetric & { boards: number };

const FORMATS: Array<{ v: MetricFormat; label: string }> = [
  { v: "currency", label: "Money" },
  { v: "count", label: "Number" },
  { v: "percent", label: "Percent" },
  { v: "decimal", label: "Decimal (2 places)" },
  { v: "multiple", label: "Multiple (3.2×)" },
];

const POLARITIES: Array<{ v: Polarity; label: string }> = [
  { v: "higher-better", label: "Higher is better" },
  { v: "lower-better", label: "Lower is better" },
  { v: "neutral", label: "Neither" },
];

const SECTIONS: Array<AdPlatform | "any"> = [...AD_PLATFORMS, "any"];
const sectionName = (p: AdPlatform | "any") => (p === "any" ? "Any platform" : PLATFORM_LABEL[p]);

const BLANK: CustomMetricDraft = {
  kind: "rename",
  platform: "meta",
  baseMetric: null,
  expression: [],
  label: "",
  description: "",
  format: "currency",
  polarity: "lower-better",
};

function draftOf(m: CustomMetric): CustomMetricDraft {
  return {
    kind: m.kind,
    platform: m.platform,
    baseMetric: m.baseMetric,
    expression: m.expression ?? [],
    label: m.label,
    description: m.description ?? "",
    format: m.format ?? "currency",
    polarity: m.polarity ?? "lower-better",
  };
}

/** What the metric is, in a line: "Rename of Link clicks" or its formula. */
function describe(m: CustomMetric): string {
  const p: AdPlatform = m.platform === "any" ? "meta" : m.platform;
  if (m.kind === "rename") {
    return m.baseMetric && m.baseMetric in METRICS ? `Your name for ${metricLabel(m.baseMetric, p)}` : "Its stat no longer exists";
  }
  return formulaText(m.expression ?? [], (id) => (id in METRICS ? metricLabel(id as MetricId, p) : id));
}

async function call(path: string, method: "POST" | "PUT" | "DELETE", payload?: unknown) {
  const res = await fetch(path, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export function MetricsSettings({ metrics }: { metrics: ListedMetric[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ id: string | null; draft: CustomMetricDraft } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string; archive?: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function archive(id: string, archived: boolean) {
    setBusy(true);
    const { ok, json } = await call(`/api/agency/metrics/${id}`, "PUT", { archived });
    setBusy(false);
    setMessage(ok ? { ok: true, text: archived ? "Archived." : "Restored." } : { ok: false, text: String(json.error ?? "That didn't work.") });
    if (ok) router.refresh();
  }

  async function remove(m: ListedMetric) {
    if (confirming !== m.id) {
      setConfirming(m.id);
      return;
    }
    setConfirming(null);
    setBusy(true);
    const { ok, status, json } = await call(`/api/agency/metrics/${m.id}`, "DELETE");
    setBusy(false);
    if (ok) {
      setMessage({ ok: true, text: `Deleted “${m.label}”.` });
      router.refresh();
    } else {
      setMessage({ ok: false, text: String(json.error ?? "That didn't work."), archive: status === 409 ? m.id : undefined });
    }
  }

  return (
    <section className="card flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold" style={{ color: "var(--section-ink, var(--text-primary))" }}>
            Your metrics
          </h2>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            Rename a platform&apos;s stat, or build your own from stats with a formula. They appear at the top of
            the stat list on every client&apos;s Board, for you and for clients who can edit theirs.
          </p>
        </div>
        <button
          type="button"
          className="btn-accent"
          onClick={() => {
            setMessage(null);
            setEditing({ id: null, draft: { ...BLANK } });
          }}
        >
          New metric
        </button>
      </div>

      {message && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-[12.5px]"
          role="status"
          style={{ background: "var(--surface-2)", color: message.ok ? "var(--text-secondary)" : "var(--delta-bad)" }}
        >
          <span className="min-w-0 flex-1">{message.text}</span>
          {message.archive && (
            <button type="button" className="btn-ghost rounded-[var(--radius-sm)] px-2.5 py-1 text-[12px]" onClick={() => archive(message.archive!, true)}>
              Archive instead
            </button>
          )}
        </div>
      )}

      {metrics.length === 0 ? (
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          No metrics yet. For example: rename Meta&apos;s “On-Facebook leads” to “Form leads”, or make “Cost per booked
          call” from Ad spend ÷ Appointments.
        </p>
      ) : (
        SECTIONS.map((p) => {
          const list = metrics.filter((m) => m.platform === p);
          if (list.length === 0) return null;
          return (
            <div key={p} className="flex flex-col gap-1.5">
              <h3 className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
                {sectionName(p)}
              </h3>
              <div className="table-scroll overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr className="text-left text-[10.5px] tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">Name</th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">What it is</th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold whitespace-nowrap">Used on</th>
                      <th scope="col" className="py-1.5 font-semibold"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => (
                      <tr key={m.id} className="border-t align-top" style={{ borderColor: "var(--border)" }}>
                        <td className="py-2 pr-3">
                          <span className="font-medium" style={{ color: "var(--text-primary)" }}>{m.label}</span>
                          {m.archived && <span className="badge badge-neutral ml-2">Archived</span>}
                          {m.description && (
                            <span className="mt-0.5 block text-[11.5px]" style={{ color: "var(--text-muted)" }}>{m.description}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3" style={{ color: "var(--text-secondary)" }}>{describe(m)}</td>
                        <td className="tnum py-2 pr-3 whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
                          {m.boards === 0 ? "Not used" : `${m.boards} ${m.boards === 1 ? "board" : "boards"}`}
                        </td>
                        <td className="py-2">
                          <div className="flex flex-wrap justify-end gap-1">
                            <button type="button" className="btn-ghost rounded-[var(--radius-sm)] px-2 py-1 text-[12px]" disabled={busy}
                              onClick={() => { setMessage(null); setEditing({ id: m.id, draft: draftOf(m) }); }}
                              aria-label={`Edit ${m.label}`}>
                              Edit
                            </button>
                            <button type="button" className="btn-ghost rounded-[var(--radius-sm)] px-2 py-1 text-[12px]" disabled={busy}
                              onClick={() => { setMessage(null); setEditing({ id: null, draft: { ...draftOf(m), label: `${m.label} (copy)`.slice(0, CUSTOM_LIMITS.label) } }); }}
                              aria-label={`Duplicate ${m.label}`}>
                              Duplicate
                            </button>
                            <button type="button" className="btn-ghost rounded-[var(--radius-sm)] px-2 py-1 text-[12px]" disabled={busy}
                              onClick={() => archive(m.id, !m.archived)}
                              aria-label={`${m.archived ? "Restore" : "Archive"} ${m.label}`}>
                              {m.archived ? "Restore" : "Archive"}
                            </button>
                            <button type="button" className="btn-ghost rounded-[var(--radius-sm)] px-2 py-1 text-[12px]" disabled={busy}
                              onClick={() => remove(m)}
                              aria-label={confirming === m.id ? `Confirm deleting ${m.label}` : `Delete ${m.label}`}
                              style={confirming === m.id ? { color: "var(--delta-bad)" } : undefined}>
                              {confirming === m.id ? "Confirm delete" : "Delete"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}

      {editing && (
        <MetricForm
          id={editing.id}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setMessage({ ok: true, text });
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

function MetricForm({
  id,
  initial,
  onClose,
  onSaved,
}: {
  /** The metric being changed, or null for a new one. */
  id: string | null;
  initial: CustomMetricDraft;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const ids = useId();
  const [d, setD] = useState<CustomMetricDraft>(initial);
  const [error, setError] = useState<{ field?: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const isNew = id === null;
  const set = (patch: Partial<CustomMetricDraft>) => setD((x) => ({ ...x, ...patch }));
  const renamePlatform: AdPlatform = d.platform === "any" ? "meta" : d.platform;

  async function save() {
    setSaving(true);
    setError(null);
    const payload: CustomMetricDraft = {
      ...d,
      baseMetric: d.kind === "rename" ? d.baseMetric : null,
      expression: d.kind === "formula" ? (d.expression ?? []) : null,
      format: d.kind === "formula" ? d.format : null,
      polarity: d.kind === "formula" ? d.polarity : null,
      description: d.description?.trim() || null,
    };
    const res = await call(isNew ? "/api/agency/metrics" : `/api/agency/metrics/${id}`, isNew ? "POST" : "PUT", payload);
    setSaving(false);
    if (!res.ok) {
      setError({ field: typeof res.json.field === "string" ? res.json.field : undefined, text: String(res.json.error ?? "That didn't work.") });
      return;
    }
    const broken = Number(res.json.broken ?? 0);
    onSaved(
      broken > 0
        ? `Saved. ${broken} ${broken === 1 ? "widget can't" : "widgets can't"} show it the way ${broken === 1 ? "it is" : "they are"} set up any more, and ${broken === 1 ? "says" : "say"} so on the board until edited.`
        : isNew
          ? `Added “${d.label.trim()}”. It's at the top of the stat list on every client's Board.`
          : "Saved. Every board using it shows the change now; share links already sent keep the version they were sent with.",
    );
  }

  const fieldError = (f: string) =>
    error?.field === f ? (
      <span className="text-[11.5px]" role="alert" style={{ color: "var(--delta-bad)" }}>{error.text}</span>
    ) : null;

  return (
    <Modal open onClose={onClose} size="lg" title={isNew ? "New metric" : "Edit metric"} description="Available on every client's Board.">
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Kind of metric" className="inline-flex self-start rounded-[var(--radius-sm)] border p-0.5" style={{ borderColor: "var(--border-strong)", background: "var(--surface-2)" }}>
          {(["rename", "formula"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={d.kind === k}
              disabled={!isNew}
              title={isNew ? undefined : "A metric's kind can't change. Duplicate it instead."}
              onClick={() => set({ kind: k, platform: k === "rename" && d.platform === "any" ? "meta" : d.platform })}
              className="rounded-[var(--radius-xs)] px-3 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed"
              style={{ background: d.kind === k ? "var(--surface-1)" : "transparent", color: d.kind === k ? "var(--text-primary)" : "var(--text-muted)" }}
            >
              {k === "rename" ? "Rename a stat" : "Formula"}
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5" htmlFor={`${ids}-platform`}>
            <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>Platform</span>
            <select id={`${ids}-platform`} className="field w-full" value={d.platform} disabled={!isNew}
              onChange={(e) => set({ platform: e.target.value as AdPlatform | "any", baseMetric: null, expression: [] })}>
              {AD_PLATFORMS.map((p) => (
                <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>
              ))}
              {d.kind === "formula" && <option value="any">Any platform</option>}
            </select>
            {fieldError("platform")}
          </label>

          {d.kind === "rename" && (
            <label className="flex flex-col gap-1.5" htmlFor={`${ids}-base`}>
              <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>Stat to rename</span>
              <select id={`${ids}-base`} className="field w-full" value={d.baseMetric ?? ""}
                onChange={(e) => set({ baseMetric: e.target.value || null })}>
                <option value="">Choose a stat…</option>
                {METRIC_GROUPS.map((g) => {
                  const inGroup = METRIC_IDS.filter((m) => METRICS[m].group === g && METRICS[m].platforms.includes(renamePlatform));
                  if (inGroup.length === 0) return null;
                  return (
                    <optgroup key={g} label={g}>
                      {inGroup.map((m) => (
                        <option key={m} value={m}>{metricLabel(m, renamePlatform)}</option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              {fieldError("baseMetric")}
            </label>
          )}
        </div>

        {d.kind === "formula" && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>Formula</span>
            <FormulaBuilder tokens={(d.expression ?? []) as FormulaToken[]} onChange={(expression) => set({ expression })} platform={d.platform} />
            {fieldError("expression")}
          </div>
        )}

        {d.kind === "formula" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5" htmlFor={`${ids}-format`}>
              <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>Show the result as</span>
              <select id={`${ids}-format`} className="field w-full" value={d.format ?? "currency"} onChange={(e) => set({ format: e.target.value as MetricFormat })}>
                {FORMATS.map((f) => (
                  <option key={f.v} value={f.v}>{f.label}</option>
                ))}
              </select>
              {fieldError("format")}
            </label>
            <label className="flex flex-col gap-1.5" htmlFor={`${ids}-polarity`}>
              <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>When it changes</span>
              <select id={`${ids}-polarity`} className="field w-full" value={d.polarity ?? "neutral"} onChange={(e) => set({ polarity: e.target.value as Polarity })}>
                {POLARITIES.map((p) => (
                  <option key={p.v} value={p.v}>{p.label}</option>
                ))}
              </select>
              {fieldError("polarity")}
            </label>
          </div>
        )}

        <label className="flex flex-col gap-1.5" htmlFor={`${ids}-label`}>
          <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>Name</span>
          <input id={`${ids}-label`} className="field w-full" maxLength={CUSTOM_LIMITS.label} value={d.label}
            placeholder={d.kind === "rename" ? "Form leads" : "Cost per booked call"} onChange={(e) => set({ label: e.target.value })} />
          {fieldError("label")}
        </label>

        <label className="flex flex-col gap-1.5" htmlFor={`${ids}-desc`}>
          <span className="text-[11px] font-semibold tracking-[0.06em] uppercase" style={{ color: "var(--text-muted)" }}>
            Description <span className="normal-case tracking-normal">(optional — shown when someone taps the ⓘ)</span>
          </span>
          <textarea id={`${ids}-desc`} className="field min-h-[64px] w-full" maxLength={CUSTOM_LIMITS.description} value={d.description ?? ""}
            onChange={(e) => set({ description: e.target.value })} />
          {fieldError("description")}
        </label>

        {error && !error.field && (
          <p className="text-[12.5px]" role="alert" style={{ color: "var(--delta-bad)" }}>{error.text}</p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4" style={{ borderColor: "var(--border)" }}>
          <button type="button" className="btn-ghost rounded-[var(--radius-sm)] px-3 py-2 text-[13px]" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-accent" disabled={saving} onClick={save}>
            {saving ? "Saving…" : isNew ? "Add metric" : "Save changes"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
