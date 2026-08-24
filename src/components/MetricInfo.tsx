"use client";

import { useCallback, useRef, useState } from "react";
import { definitionFor } from "@/lib/metrics/definitions";
import { useDismissOnEscape, Portal } from "./Modal";
import { Icon } from "./Icon";

/**
 * "What is this number?" — one tap, on the number itself.
 *
 * CLICK, not hover. A hover tooltip is unreachable on every touch device and
 * invisible to keyboard users, which excludes exactly the client reading the
 * dashboard on a phone before a meeting. The trigger is a real `<button>` so it
 * is tabbable, and the panel is described by `aria-describedby` so a screen
 * reader gets the definition attached to the metric rather than floating loose.
 *
 * Rendered muted and small on purpose. This is a footnote marker: available to
 * anyone who wonders, invisible to anyone who does not.
 */
const PANEL_W = 264;
const GUTTER = 12;

export function MetricInfo({
  metricKey,
  label,
}: {
  metricKey: string;
  /** The metric's display name, for the popover heading and the button's label. */
  label: string;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null;
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setAt(null), []);
  useDismissOnEscape(open, close, trigger);

  /*
   * Positioned `fixed`, from the trigger's measured rect, rather than `absolute`
   * inside the tile. Two reasons, both of which break the simpler version:
   *
   * - The rightmost tile in the grid would push a 264px panel past the viewport
   *   edge, and the page is not allowed to scroll horizontally.
   * - Any ancestor with `overflow: hidden` or `auto` clips an absolute panel.
   *   The report tables scroll inside exactly such a container.
   *
   * Clamped to the viewport on open. It does not follow scroll — the click-away
   * layer sits over the page, so nothing can scroll underneath it anyway.
   */
  function toggle() {
    if (open) return close();
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(
      Math.max(GUTTER, r.left),
      window.innerWidth - PANEL_W - GUTTER,
    );
    setAt({ top: r.bottom + 6, left });
  }

  const def = definitionFor(metricKey);
  // No definition, no marker. A "?" that explains nothing is worse than none.
  if (!def) return null;

  const panelId = `def-${metricKey}`;

  return (
    <span className="relative inline-flex">
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`How ${label} is calculated`}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full align-middle transition-colors hover:bg-[var(--surface-2)]"
        style={{ color: "var(--text-muted)" }}
      >
        <Icon name="help" size={12} />
      </button>

      {open && (
        <Portal>
          {/*
            Portalled, because BOTH children are `position: fixed` and this
            component renders inside dashboard sections and stat tiles.

            `top`/`left` below come from `getBoundingClientRect()` — viewport
            coordinates. Any ancestor with a transform (the `rise` entrance
            animation on `main > *`) or a filter would become the containing
            block, and the panel would land offset by exactly that transform
            while the catcher covered only the section instead of the page.
          */}
          {/* Click-away. Transparent, above the page, below the panel. */}
          <span
            className="fixed inset-0 z-40"
            onClick={close}
            aria-hidden="true"
          />
          <span
            id={panelId}
            role="dialog"
            aria-label={`${label} — definition`}
            className="fixed z-50 block rounded-[10px] p-3 text-left normal-case"
            style={{
              top: at.top,
              left: at.left,
              width: PANEL_W,
              background: "var(--surface-raised)",
              border: "1px solid var(--border-strong)",
              boxShadow: "var(--shadow-overlay)",
              // The tile's label sets uppercase + letter-spacing; prose inherits
              // it and becomes unreadable without this reset.
              letterSpacing: "normal",
              fontWeight: 400,
            }}
          >
            <span
              className="block text-[11px] font-semibold tracking-[0.06em] uppercase"
              style={{ color: "var(--text-muted)" }}
            >
              {label}
            </span>
            <span
              className="mt-1 block text-[12px] leading-relaxed"
              style={{ color: "var(--text-primary)" }}
            >
              {def.what}
            </span>
            <span
              className="mt-2 block rounded-[6px] px-2 py-1 font-mono text-[11px] leading-relaxed"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-secondary)",
              }}
            >
              {def.formula}
            </span>
            {def.caveat && (
              <span
                className="mt-2 block text-[11px] leading-relaxed"
                style={{ color: "var(--text-muted)" }}
              >
                {def.caveat}
              </span>
            )}
          </span>
        </Portal>
      )}
    </span>
  );
}
