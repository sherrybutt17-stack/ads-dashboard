"use client";

import { useSyncExternalStore } from "react";
import { Icon } from "./Icon";

/**
 * Theme toggle.
 *
 * The theme lives on `document.documentElement.dataset.theme`, stamped before
 * first paint by the inline script in the root layout. That makes it external
 * mutable state, so it is read with `useSyncExternalStore` rather than mirrored
 * into component state via an effect — the effect version renders once with the
 * wrong icon and then corrects itself, which is a visible flicker.
 *
 * The server snapshot is `null`, which renders a neutral icon and so cannot
 * cause a hydration mismatch.
 */

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): "light" | "dark" | null {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "light" || stamped === "dark") return stamped;
  // Dark-first: the pre-paint script always stamps a value, so this is only a
  // fallback — and the fallback is dark, not the OS setting.
  return "dark";
}

function getServerSnapshot(): "light" | "dark" | null {
  return null;
}

function setTheme(next: "light" | "dark") {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* private browsing — the toggle still works for this session */
  }
  listeners.forEach((cb) => cb());
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="btn-ghost flex items-center rounded-[8px] px-2.5 py-2"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
    </button>
  );
}
