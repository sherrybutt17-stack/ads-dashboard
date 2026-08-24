"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { monthLabel } from "@/lib/commentary/model";
import type { AdPlatform } from "@/lib/platforms";

/**
 * Setting the monthly budget this client's spend is paced against.
 *
 * ── Why this edits a LIST rather than a single field ──────────────────
 *
 * The obvious design is one box: "Monthly budget: £4,000". It is wrong in a way
 * that only shows up months later. A budget is renegotiated, and a single
 * mutable figure has no way to say "£2,000 until May, £4,000 after" — so the
 * day it is raised, every closed month is silently restated against the new
 * number and a March that hit its target starts reading as a 50% miss. The
 * agency's own history of hitting budget is rewritten by an edit that looked
 * like a settings change.
 *
 * So each row is an agreement effective from a month, and pacing picks the
 * latest one at or before the month it is describing. Changing the budget going
 * forward is adding a row, not editing the old one — which is also how it
 * should read to whoever does it.
 */

interface BudgetRow {
  id: string;
  effectiveFrom: string;
  monthlyAmount: number | null;
  updatedAt: string;
  updatedBy: string | null;
}

interface Loaded {
  budgets: BudgetRow[];
  pacing: { monthKey: string; budget: number | null; spendToDate: number } | null;
}

/** `yyyy-MM` for the month currently running, in the browser's timezone.
 *
 *  Only a default for the picker — every figure on the dashboard is computed in
 *  the CLIENT's timezone server-side, and this never feeds that arithmetic. */
function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function BudgetSettings({
  clientId,
  platform = "meta",
  currency = "USD",
}: {
  clientId: string;
  platform?: AdPlatform;
  currency?: string;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [month, setMonth] = useState(thisMonth);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/clients/${clientId}/budgets?platform=${platform}`);
    if (!res.ok) throw new Error("load failed");
    return (await res.json()) as Loaded;
  }, [clientId, platform]);

  useEffect(() => {
    let live = true;
    load()
      .then((json) => {
        if (live) setLoaded(json);
      })
      .catch(() => {
        if (live) setNote({ kind: "bad", text: "Could not load budgets." });
      });
    return () => {
      live = false;
    };
  }, [load]);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const trimmed = amount.trim();
      /*
       * An empty box is an explicit "no budget from this month", not a reason
       * to refuse the save — it is how a client who stops committing to a
       * figure is recorded without deleting what they committed to before.
       */
      const parsed = trimmed === "" ? null : Number(trimmed.replace(/[^0-9.]/g, ""));
      if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
        setNote({ kind: "bad", text: "Enter a number, or leave it empty for no budget." });
        return;
      }

      const res = await fetch(`/api/clients/${clientId}/budgets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          effectiveFrom: month,
          monthlyAmount: parsed,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote({ kind: "bad", text: json.error ?? "Could not save." });
        return;
      }
      setLoaded(json);
      setAmount("");
      setNote({ kind: "ok", text: `Saved for ${monthLabel(month)} onward.` });
    } catch {
      setNote({ kind: "bad", text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }

  async function remove(effectiveFrom: string) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/budgets`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, effectiveFrom }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote({ kind: "bad", text: json.error ?? "Could not remove." });
        return;
      }
      setLoaded(json);
      setNote({ kind: "ok", text: `Removed the ${monthLabel(effectiveFrom)} agreement.` });
    } finally {
      setBusy(false);
    }
  }

  const rows = loaded?.budgets ?? [];

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card-bg)] p-5">
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">Monthly budget</h2>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        What this client agreed to spend per month, in {currency}. Pacing on the
        dashboard is measured against it. Each entry applies from its month
        onward until a later one replaces it, so past months keep the figure
        that was actually agreed at the time.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-[var(--text-secondary)]">
          <span className="block">Effective from</span>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="mt-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>
        <label className="text-xs text-[var(--text-secondary)]">
          <span className="block">Amount per month</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 4000 — empty for none"
            className="mt-1 w-52 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-sm tabular-nums text-[var(--text-primary)]"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={busy || !/^\d{4}-\d{2}$/.test(month)}
          className="rounded-[var(--radius)] bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-ink)] disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      {note && (
        <p
          className="mt-3 flex items-center gap-1.5 text-xs"
          style={{
            color: note.kind === "ok" ? "var(--status-good)" : "var(--status-critical)",
          }}
        >
          <Icon name={note.kind === "ok" ? "check" : "alert"} size={12} />
          {note.text}
        </p>
      )}

      {rows.length > 0 ? (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              <th className="pb-1 font-medium">From</th>
              <th className="pb-1 text-right font-medium">Per month</th>
              <th className="pb-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-[var(--border)]">
                <td className="py-1.5 text-[var(--text-primary)]">
                  {monthLabel(r.effectiveFrom)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-[var(--text-primary)]">
                  {r.monthlyAmount === null ? (
                    <span className="text-[var(--text-muted)]">No budget</span>
                  ) : (
                    r.monthlyAmount.toLocaleString()
                  )}
                </td>
                <td className="py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => remove(r.effectiveFrom)}
                    disabled={busy}
                    className="text-xs text-[var(--text-muted)] underline disabled:opacity-50"
                    aria-label={`Remove the ${monthLabel(r.effectiveFrom)} agreement`}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-4 text-xs text-[var(--text-muted)]">
          No budget on record. The dashboard will still project where the month
          lands — it simply has nothing to pace that against.
        </p>
      )}
    </section>
  );
}
