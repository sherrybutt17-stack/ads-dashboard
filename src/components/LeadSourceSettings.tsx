"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Which leads divide into ad spend.
 *
 * This setting decides whether cost-per-lead is honest. A GHL pipeline receives
 * leads from everywhere — organic, referral, walk-in — but only Facebook spend
 * is in the numerator. Counting every lead understates true paid CPL by exactly
 * the non-paid share.
 *
 * Two signals, because each alone has a blind spot: UTM attribution misses
 * native Instant Form leads entirely (they carry no UTMs no matter how the ads
 * are configured), and tagging depends on someone actually applying the tag.
 */

const MODES = [
  {
    id: "either",
    label: "Ad-attributed or tagged",
    hint: "Recommended. Counts a lead as paid if it has a Facebook campaign ID OR carries your tag (below) — so leads that are only tagged, with no ad attribution, ARE included. Covers Instant Form leads, which never carry UTMs.",
  },
  {
    id: "attributed",
    label: "Ad-attributed only (exclude tagged)",
    hint: "Only leads with a real Facebook campaign ID. Leads that are only tagged — including any added by hand in the CRM — are NOT counted. Cleanest, but misses Instant Form leads.",
  },
  {
    id: "tagged",
    label: "Tagged only",
    hint: "Only leads carrying the tag, regardless of ad attribution. Use when UTMs aren't set up and a GHL workflow applies the tag instead.",
  },
  {
    id: "all",
    label: "Every lead in the pipeline",
    hint: "⚠️ Cost-per-lead will be optimistic — organic and referral leads divide into Facebook spend.",
  },
] as const;

export function LeadSourceSettings({
  clientId,
  initialMode,
  initialTag,
  breakdown,
}: {
  clientId: string;
  initialMode: "all" | "attributed" | "tagged" | "either";
  initialTag: string;
  breakdown?: { total: number; attributed: number; tagged: number; paid: number };
}) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  const [tag, setTag] = useState(initialTag);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsTag = mode === "tagged" || mode === "either";

  async function save() {
    if (needsTag && tag.trim() === "") {
      setError("Enter the GHL tag that marks a Facebook lead, or switch to Ad-attributed only.");
      return;
    }
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paidLeadFilter: mode, paidLeadTag: tag }),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Couldn't save — please try again.");
      }
    } catch {
      setError("Couldn't reach the server — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const dirty = mode !== initialMode || tag !== initialTag;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Which leads count as paid
      </h2>
      <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
        Ad spend is divided by these leads to produce cost-per-lead, per-appointment,
        and per-close.
      </p>

      <div className="mt-4 flex flex-col gap-1">
        {MODES.map((m) => (
          <label
            key={m.id}
            className="flex cursor-pointer gap-3 rounded-[8px] p-2.5 transition-colors"
            style={{
              background: mode === m.id ? "var(--surface-2)" : "transparent",
            }}
          >
            <input
              type="radio"
              name="lead-mode"
              checked={mode === m.id}
              onChange={() => setMode(m.id)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span
                className="block text-[13px] font-medium"
                style={{ color: "var(--text-primary)" }}
              >
                {m.label}
              </span>
              <span
                className="mt-0.5 block text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                {m.hint}
              </span>
            </span>
          </label>
        ))}
      </div>

      {(mode === "tagged" || mode === "either") && (
        <label className="mt-3 block">
          <span
            className="text-[11px] font-medium tracking-wider uppercase"
            style={{ color: "var(--text-muted)" }}
          >
            GHL tag marking a Facebook lead
          </span>
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="facebook-lead"
            className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--surface-1)",
              color: "var(--text-primary)",
            }}
          />
          <span
            className="mt-1 block text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            Case-insensitive. Apply it in GHL with a workflow on your Facebook
            lead source, or by hand.
          </span>
        </label>
      )}

      {breakdown && breakdown.total > 0 && (
        <div
          className="mt-4 rounded-[8px] border p-3"
          style={{ borderColor: "var(--border)" }}
        >
          <div
            className="text-[11px] font-medium tracking-wider uppercase"
            style={{ color: "var(--text-muted)" }}
          >
            In the current range
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <Stat label="Leads in pipeline" value={breakdown.total} />
            <Stat label="With campaign ID" value={breakdown.attributed} />
            <Stat label="With tag" value={breakdown.tagged} />
            <Stat label="Counted as paid" value={breakdown.paid} emphasis />
          </div>
          {breakdown.paid === 0 && breakdown.total > 0 && (
            <p
              className="mt-2 text-xs"
              style={{ color: "var(--status-critical)" }}
            >
              No leads qualify as paid, so every cost metric will show a dash.
              Either UTMs are missing from the ads or the tag is not being
              applied.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
          style={{ background: "var(--series-1)" }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && !dirty && (
          <span className="text-xs" style={{ color: "var(--delta-good)" }}>
            ✓ Saved
          </span>
        )}
        {error && (
          <span className="text-xs" style={{ color: "var(--status-critical)" }}>
            {error}
          </span>
        )}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span
        className="tnum font-semibold"
        style={{
          color: emphasis ? "var(--text-primary)" : "var(--text-secondary)",
        }}
      >
        {value}
      </span>
    </span>
  );
}
