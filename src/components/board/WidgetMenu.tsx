"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/Icon";
import { Portal, useDismissOnEscape } from "@/components/Modal";

export type WidgetAction =
  | "rename"
  | "settings"
  | "duplicate"
  | "up"
  | "down"
  | "left"
  | "right"
  | "wider"
  | "narrower"
  | "taller"
  | "shorter"
  | "remove";

type Item = { action: WidgetAction; label: string } | "divider";

const ITEMS: readonly Item[] = [
  { action: "rename", label: "Rename…" },
  { action: "settings", label: "Settings…" },
  { action: "duplicate", label: "Duplicate" },
  "divider",
  { action: "up", label: "Move up" },
  { action: "down", label: "Move down" },
  { action: "left", label: "Move left" },
  { action: "right", label: "Move right" },
  "divider",
  { action: "wider", label: "Wider" },
  { action: "narrower", label: "Narrower" },
  { action: "taller", label: "Taller" },
  { action: "shorter", label: "Shorter" },
  "divider",
  { action: "remove", label: "Remove" },
];

const PANEL_W = 196;
const GUTTER = 12;

/**
 * A widget's actions, one keyboard-reachable list.
 *
 * Every drag and resize on the canvas has an entry here too: a pointer is not
 * the only way to arrange a board, and "Move up" is a better instruction than
 * a twelve-column hit target for anyone not holding a mouse.
 *
 * Portalled and `fixed`, like `MetricInfo`: grid items are positioned with
 * transforms, and a transformed ancestor would become the containing block of
 * anything fixed inside it — the menu would land offset by exactly the item's
 * position on the board.
 */
export function WidgetMenu({
  title,
  onAction,
  disabled = {},
  hidden = {},
}: {
  /** The widget's title, for the button's and menu's names. */
  title: string;
  onAction: (action: WidgetAction) => void;
  /** Actions that would do nothing — at the grid's edge, at the size limit. */
  disabled?: Partial<Record<WidgetAction, boolean>>;
  /** Actions this widget does not have at all — a text block or a logo shows no name to rename. */
  hidden?: Partial<Record<WidgetAction, boolean>>;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null;
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAt(null), []);
  useDismissOnEscape(open, close, trigger);

  // Focus moves into the menu as it opens, as a menu button promises.
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);

  function toggle() {
    if (open) return close();
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(GUTTER, r.right - PANEL_W), window.innerWidth - PANEL_W - GUTTER);
    // Below the button, or above it when the widget sits low on the screen.
    const estimated = 420;
    const top = r.bottom + 6 + estimated > window.innerHeight ? Math.max(GUTTER, r.top - 6 - estimated) : r.bottom + 6;
    setAt({ top, left });
  }

  function run(action: WidgetAction) {
    close();
    trigger.current?.focus();
    onAction(action);
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Tab") {
      // The menu lives at the end of <body>; tabbing on would leave the board.
      e.preventDefault();
      close();
      trigger.current?.focus();
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${title} options`}
        title="Options"
        className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] border transition-colors hover:bg-[var(--surface-2)]"
        style={{
          background: "var(--surface-raised)",
          borderColor: "var(--border-strong)",
          color: "var(--text-secondary)",
        }}
      >
        <Icon name="settings" size={14} />
      </button>

      {open && (
        <Portal>
          <span className="fixed inset-0 z-40" onClick={close} aria-hidden="true" />
          <div
            ref={panel}
            role="menu"
            aria-label={`${title} options`}
            onKeyDown={onMenuKey}
            className="glass-panel fixed z-50 flex flex-col rounded-[var(--radius)] p-1"
            style={{ top: at.top, left: at.left, width: PANEL_W }}
          >
            {ITEMS.filter((item) => item === "divider" || !hidden[item.action]).map((item, i) =>
              item === "divider" ? (
                <div
                  key={`d${i}`}
                  role="separator"
                  className="my-1 border-t"
                  style={{ borderColor: "var(--border)" }}
                />
              ) : (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  disabled={disabled[item.action]}
                  onClick={() => run(item.action)}
                  className="rounded-[var(--radius-xs)] px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] disabled:opacity-40 disabled:hover:bg-transparent"
                  style={{
                    color: item.action === "remove" ? "var(--status-critical)" : "var(--text-primary)",
                  }}
                >
                  {item.label}
                </button>
              ),
            )}
          </div>
        </Portal>
      )}
    </>
  );
}
