"use client";

import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/**
 * A dialog that behaves like one.
 *
 * The version this replaces was a `fixed inset-0` div with a click-outside
 * handler and nothing else — no role, no Escape, no focus containment, no focus
 * return, and the page scrolling freely behind it. That is not a small polish
 * gap: a screen reader gets no announcement that a dialog opened and can walk
 * straight out of it into the page underneath, and a keyboard user who tabs past
 * the last field lands on controls they cannot see.
 *
 * Five behaviours, each load-bearing:
 *
 * 1. `role="dialog"` + `aria-modal` + a labelled title — assistive tech
 *    announces what opened instead of reading a nameless group.
 * 2. **Escape closes.** The one keystroke every user already tries first.
 * 3. **Focus is trapped.** Tab from the last focusable wraps to the first, and
 *    Shift-Tab from the first wraps to the last, so focus cannot leave.
 * 4. **Focus returns** to whatever opened the dialog. Without this, dismissing
 *    drops focus onto `<body>` and the next Tab restarts at the top of the page.
 * 5. **Scroll is locked.** Otherwise the page behind scrolls under the scrim on
 *    wheel or touch, which reads as the dialog itself moving.
 *
 * 🔴 **6. It renders through a portal into `document.body`, and that is not
 * optional.**
 *
 * Per the CSS spec, an ancestor carrying `filter`, `backdrop-filter`,
 * `transform`, `perspective`, `contain` or `will-change` becomes the
 * **containing block for every `position: fixed` descendant**. The dashboard
 * header carries `backdropFilter: saturate(180%) blur(14px)`
 * (`app/c/[slug]/page.tsx`), and both the Sections and Share dialogs are opened
 * from controls inside it — so `inset: 0` resolved against that short, wide
 * strip instead of the viewport. The panel was cut off at a hard horizontal
 * edge, scrolled inside a sliver, and the scrim never covered the page.
 *
 * Removing the blur would fix those two and leave the trap armed for the next
 * dialog. `globals.css` also puts `transform: translateY(12px)` on `main > *`
 * for the entrance stagger, so **any** fixed-position element inside a dashboard
 * section hits the identical bug. The portal is the durable fix: escaping to
 * `document.body` means no ancestor can ever create a containing block for it.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Renders children into `document.body`, escaping every ancestor.
 *
 * 🔴 **Use this for ANY `position: fixed` element rendered from inside the
 * dashboard header or a dashboard section.** Both create containing blocks —
 * the header permanently via `backdrop-filter`, a section transiently via the
 * `rise` entrance animation's `transform` — and a fixed element inside one
 * resolves its `inset`/`top`/`left` against that box rather than the viewport.
 *
 * The symptom is not a crash. A full-viewport click-away catcher silently
 * covers only the header strip, so clicking the page below does not dismiss the
 * popover it belongs to; a panel positioned from `getBoundingClientRect()`
 * lands offset by the ancestor's transform. Both read as "the component is
 * janky" rather than as a layout bug with a cause.
 */
/** Nothing to subscribe to — hydration happens once and never changes back. */
const noopSubscribe = () => () => {};

/**
 * `false` during the server render and the hydrating pass, `true` afterwards.
 *
 * `document` does not exist on the server, and a client component is still
 * server-rendered for the initial HTML, so `createPortal` needs a guard.
 * `useSyncExternalStore` is the right tool rather than `useState` +
 * `useEffect(() => setMounted(true))`: it gives React a distinct server
 * snapshot instead of setting state during an effect, which triggers a
 * cascading render (and the `react-hooks/set-state-in-effect` lint rule).
 */
export function useIsHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true, // client
    () => false, // server
  );
}

export function Portal({ children }: { children: React.ReactNode }) {
  if (!useIsHydrated()) return null;
  return createPortal(children, document.body);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  /** Blocks Escape and backdrop dismissal while a submit is in flight. */
  busy = false,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  busy?: boolean;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const mounted = useIsHydrated();

  useEffect(() => {
    // `mounted` gates this because the panel does not exist in the DOM until
    // the portal has rendered, and focus cannot be moved into a node that is
    // not there yet.
    if (!open || !mounted) return;

    // Remember who opened us. `activeElement` is captured on open, before we
    // move focus, so dismissal can hand control back to exactly that control.
    const opener = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    // Focus the first field rather than the panel, so a keyboard user starts
    // typing immediately instead of tabbing in.
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;

      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;

      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      // Wrap at both ends. Also catches focus that has somehow escaped the panel
      // (browser chrome, an extension) and pulls it back in.
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      } else if (!panelRef.current.contains(document.activeElement)) {
        e.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    // Scroll lock. Preserve whatever `overflow` was there rather than assuming
    // "" — a future layout may set it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      // `isConnected` guards the case where the opener was itself unmounted by
      // whatever the dialog did — focusing a detached node throws nothing but
      // silently drops focus to <body>, which is what we are here to prevent.
      if (opener?.isConnected) opener.focus();
    };
    /*
     * `mounted` is a dependency, not just a guard. A dialog rendered open on the
     * very first pass would otherwise run this effect while the panel is still
     * unrendered — `panelRef.current` null, focus silently not moved — and never
     * re-run, because `open` did not change when the portal appeared.
     */
  }, [open, onClose, busy, mounted]);

  if (!open || !mounted) return null;

  const overlay = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4"
      style={{ background: "var(--overlay-scrim)" }}
      onMouseDown={(e) => {
        // mousedown, not click: a click that STARTED inside the panel (drag-
        // selecting text and releasing outside) would otherwise dismiss it and
        // throw away whatever was typed.
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        aria-describedby={description ? descId : undefined}
        className="w-full max-w-sm rounded-[14px] p-5"
        style={{
          background: "var(--surface-raised)",
          border: "1px solid var(--border-strong)",
          boxShadow: "var(--shadow-overlay)",
        }}
      >
        <h2
          id={titleId}
          className="text-base font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {description}
          </p>
        )}
        {children}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

/**
 * Escape-to-close and focus-return for a POPOVER — a menu or calendar that is
 * dismissible but does not block the page.
 *
 * Deliberately not the full dialog treatment: a popover that trapped focus and
 * locked scrolling would be a modal wearing a popover's clothes, and users
 * expect to be able to click past it. What they also expect, and were not
 * getting, is for Escape to shut it and for focus to come back to the button
 * that opened it instead of vanishing to the top of the document.
 */
export function useDismissOnEscape(
  open: boolean,
  onClose: () => void,
  triggerRef?: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
      triggerRef?.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, triggerRef]);
}
