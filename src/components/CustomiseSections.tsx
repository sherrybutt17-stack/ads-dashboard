"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import type { SectionCadence } from "@/lib/dashboard/registry";
import { moveSection, orderChanged } from "@/lib/dashboard/reorder";

/**
 * Choose which sections a dashboard shows — §5.
 *
 * **Show/hide only. Reordering is deliberately absent**, and that is a decision
 * rather than a gap. Reorder is the expensive half — drag affordances, keyboard
 * equivalents, order integers, tie-breaks — and the less valuable one: the
 * request that actually exists is "get month-on-month off my screen", which a
 * checkbox answers completely. The stored shape is already an ordered array, so
 * reordering stays purely additive later, with no migration.
 *
 * Three details that are load-bearing rather than decorative:
 *
 *   · **Required sections render, disabled, with the reason.** Hiding the fact
 *     that the lead-source note cannot be turned off would leave someone hunting
 *     for a switch that does not exist.
 *   · **A section that shipped after this layout was saved carries a "New"
 *     badge** and arrives visible. A dashboard that silently omits a newly
 *     shipped capability is the `SHOWN = 0` failure this whole project replaces.
 *   · **The cadence is shown.** Four sections describe fixed trailing windows
 *     and ignore the date picker entirely; someone deciding whether to keep
 *     "Month on month" should know that before they decide.
 */

export interface SectionChoice {
  id: string;
  label: string;
  description: string;
  /*
   * The registry's own union, not a copy of it. Restating the members here left
   * this drawer failing to compile the moment a new cadence shipped, which is
   * the good failure — but the fix is to stop restating them, so a new cadence
   * only ever needs a note below.
   */
  cadence: SectionCadence;
  required: boolean;
  visible: boolean;
  isNew: boolean;
}

const CADENCE_NOTE: Record<SectionChoice["cadence"], string | null> = {
  range: null,
  fixed_windows: "Fixed trailing windows — ignores the date range",
  all_time: "Current state across all time — ignores the date range",
  month: "One calendar month at a time — ignores the date range",
  current_month: "The month in progress — ignores the date range",
};

export function CustomiseSections({
  slug,
  initial,
  locked,
  staff,
  initialUpdatedAt,
}: {
  slug: string;
  initial: SectionChoice[];
  /** The agency has frozen this layout. */
  locked: boolean;
  staff: boolean;
  /** For optimistic concurrency — echoed back on save. */
  initialUpdatedAt: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState(initial);
  const [isLocked, setIsLocked] = useState(locked);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readOnly = isLocked && !staff;

  const toggle = useCallback((id: string) => {
    setChoices((prev) =>
      prev.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)),
    );
  }, []);

  /**
   * Move one section up or down by a single place.
   *
   * ── 🔴 Buttons, not drag-and-drop ─────────────────────────────────────
   *
   * Drag is the expected affordance and the wrong one here. It needs pointer
   * handlers, drop targets, an auto-scroll for a list taller than the drawer,
   * a touch fallback, and a parallel keyboard interface — because a
   * drag-only control is unusable by anyone navigating with a keyboard, and
   * this list is a settings surface a client may well be operating that way.
   * Two buttons per row are keyboard-operable by construction, work on touch
   * with no extra code, and are announced correctly by a screen reader without
   * any ARIA at all.
   *
   * The stored layout has always been an ordered array and `resolveLayout` has
   * always sorted by it, so this writes through the existing shape — no
   * migration, no server change.
   */
  const move = useCallback((id: string, direction: -1 | 1) => {
    setChoices((prev) => moveSection(prev, id, direction) as SectionChoice[]);
  }, []);

  const moved = orderChanged(initial, choices);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/c/${slug}/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sections: choices.map((c) => ({ id: c.id, visible: c.visible })),
          ...(staff ? { locked: isLocked } : {}),
          // Only sent when a row already exists — a conditional write against
          // nothing is reported as a conflict, which would be confusing on a
          // first save.
          ...(updatedAt ? { ifUnmodifiedSince: updatedAt } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.status === 409) {
        // Someone else wrote first. Show THEIR layout rather than silently
        // overwriting it, and let the user decide again from the real state.
        setChoices(json.layout?.sections ?? choices);
        setUpdatedAt(json.layout?.updatedAt ?? null);
        setError(
          `${json.error} Their version is now shown — change it again if you still want to.`,
        );
        return;
      }
      if (!res.ok) {
        setError(json.error ?? "Could not save");
        return;
      }

      setChoices(json.layout.sections);
      setUpdatedAt(json.layout.updatedAt);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/c/${slug}/layout`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Could not reset");
        return;
      }
      setChoices(json.layout.sections);
      setUpdatedAt(json.layout.updatedAt);
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const hidden = choices.filter((c) => !c.visible).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-[9px] border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)]"
        style={{
          borderColor: "var(--border-strong)",
          color: "var(--text-secondary)",
        }}
      >
        <Icon name="layers" size={13} />
        Sections
        {hidden > 0 && (
          // The count is the honesty mechanism: a dashboard with sections
          // switched off should say so on its face, or the next person to look
          // at it reads a missing block as missing DATA.
          <span
            className="tnum rounded-full px-1.5 text-[10px]"
            style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
          >
            {choices.length - hidden}/{choices.length}
          </span>
        )}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        title="Sections on this dashboard"
        description="Choose what appears. Hiding a section never changes any number — it only stops it being drawn."
      >
        <div className="flex flex-col gap-3">
          {readOnly && (
            <div
              className="flex items-start gap-2 rounded-[8px] border p-3 text-xs"
              style={{
                borderColor: "var(--border-strong)",
                background: "var(--surface-2)",
                color: "var(--text-secondary)",
              }}
            >
              <Icon name="alert" size={13} className="mt-[1px] shrink-0" />
              <span>
                Your agency has fixed this layout. Ask them to unlock it if you
                would like to change it.
              </span>
            </div>
          )}

          <ul className="flex flex-col">
            {choices.map((c, i) => (
              <li
                key={c.id}
                className="flex items-start gap-2.5 border-b py-2.5 last:border-b-0"
                style={{ borderColor: "var(--border)" }}
              >
                <input
                  id={`sec-${c.id}`}
                  type="checkbox"
                  checked={c.visible}
                  disabled={c.required || readOnly || busy}
                  onChange={() => toggle(c.id)}
                  className="mt-0.5"
                />
                {/*
                  Order controls. Labelled with the section name rather than
                  "Move up", because a screen reader announces these out of
                  context and twenty-five identical "Move up" buttons are no
                  more use than none.
                */}
                <span className="mt-px flex shrink-0 flex-col">
                  <button
                    type="button"
                    onClick={() => move(c.id, -1)}
                    disabled={i === 0 || readOnly || busy}
                    aria-label={`Move ${c.label} up`}
                    className="rounded-[4px] px-1 leading-none transition-opacity hover:opacity-70 disabled:opacity-25"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <Icon name="arrowUp" size={11} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(c.id, 1)}
                    disabled={i === choices.length - 1 || readOnly || busy}
                    aria-label={`Move ${c.label} down`}
                    className="rounded-[4px] px-1 leading-none transition-opacity hover:opacity-70 disabled:opacity-25"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <Icon name="arrowDown" size={11} />
                  </button>
                </span>
                <label htmlFor={`sec-${c.id}`} className="min-w-0 flex-1 cursor-pointer">
                  <span
                    className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {c.label}
                    {c.isNew && (
                      <span
                        className="rounded-full px-1.5 py-px text-[10px] font-semibold"
                        style={{
                          background: "color-mix(in srgb, var(--accent) 18%, transparent)",
                          color: "var(--accent)",
                        }}
                      >
                        New
                      </span>
                    )}
                    {c.required && (
                      <span
                        className="rounded-full px-1.5 py-px text-[10px]"
                        style={{
                          background: "var(--surface-2)",
                          color: "var(--text-muted)",
                        }}
                      >
                        Always shown
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {c.description}
                    {c.required && " It says which leads these numbers count, so it cannot be hidden."}
                  </span>
                  {CADENCE_NOTE[c.cadence] && (
                    <span
                      className="mt-0.5 flex items-center gap-1 text-[10px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <Icon name="help" size={9} />
                      {CADENCE_NOTE[c.cadence]}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>

          {staff && (
            <label
              className="flex items-start gap-2 border-t pt-3 text-xs"
              style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
            >
              <input
                type="checkbox"
                checked={isLocked}
                onChange={(e) => setIsLocked(e.target.checked)}
                disabled={busy}
                className="mt-0.5"
              />
              <span>
                Lock this layout
                <span className="block" style={{ color: "var(--text-muted)" }}>
                  The client can still see which sections exist, but cannot change
                  them. Agency-only — a client cannot clear this for themselves.
                </span>
              </span>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || readOnly}
              className="rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
              style={{ background: "var(--brand, var(--series-1))" }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            {moved && !busy && (
              /*
               * Reordering happens one click at a time and nothing on the page
               * behind the drawer moves until this is saved. Without a line
               * saying so, the obvious reading of "I clicked up four times and
               * the dashboard looks identical" is that the control is broken.
               */
              <span className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
                Order changed — save to apply it.
              </span>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={() => void reset()}
                disabled={busy}
                className="text-[12px] underline underline-offset-2"
                style={{ color: "var(--text-muted)" }}
              >
                Reset to defaults
              </button>
            )}
            {error && (
              <span
                role="alert"
                className="flex items-start gap-1.5 text-xs"
                style={{ color: "var(--status-critical)" }}
              >
                <Icon name="alert" size={12} className="mt-[2px] shrink-0" />
                {error}
              </span>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
