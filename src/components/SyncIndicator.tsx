"use client";

import { useSyncExternalStore } from "react";

/**
 * "Synced 3m ago" with a live pulse.
 *
 * The product's whole promise is that the numbers are LIVE — so it should say
 * so. A soft pulsing dot when data is fresh, an amber steady dot when it's gone
 * stale, and an honest "not synced yet" when a pipe has never delivered. The
 * relative label re-renders on a timer so it never sits reading "just now" for
 * an hour.
 */

const FRESH_MS = 15 * 60 * 1000; // matches the stale-while-revalidate threshold
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * A shared 30s clock, read the idiomatic way for an external mutable source.
 * `getSnapshot` returns a cached value (only mutated inside `subscribe`), so it
 * is stable between ticks — no impure Date.now() during render, no render loop.
 * The server snapshot is null, which the component renders as a stable
 * placeholder, so hydration never mismatches.
 */
const clock: { t: number | null; stop?: () => void } = { t: null };
const listeners = new Set<() => void>();

function subscribeClock(cb: () => void): () => void {
  if (clock.t === null) clock.t = Date.now();
  listeners.add(cb);
  if (listeners.size === 1) {
    const id = setInterval(() => {
      clock.t = Date.now();
      listeners.forEach((l) => l());
    }, 30_000);
    clock.stop = () => clearInterval(id);
  }
  cb(); // pick up the freshly-stamped time on mount
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) clock.stop?.();
  };
}

function useNow(): number | null {
  return useSyncExternalStore(
    subscribeClock,
    () => clock.t,
    () => null,
  );
}

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function SyncIndicator({ syncedAt }: { syncedAt: string | null }) {
  const now = useNow();

  if (!syncedAt) {
    return (
      <Shell
        dot="var(--text-muted)"
        pulse={false}
        label="Not synced yet"
        short="No data"
      />
    );
  }
  if (now === null) {
    // Pre-hydration placeholder — no time math, so no hydration mismatch.
    return (
      <Shell
        dot="var(--text-muted)"
        pulse={false}
        label="Synced"
        short="Synced"
      />
    );
  }

  const age = now - new Date(syncedAt).getTime();
  const fresh = age < FRESH_MS;
  const stale = age >= STALE_MS;
  const dot = fresh
    ? "var(--status-good)"
    : stale
      ? "var(--status-critical)"
      : "var(--status-warning)";

  return (
    <Shell
      dot={dot}
      pulse={fresh}
      label={`Synced ${ago(age)}`}
      short={ago(age)}
    />
  );
}

/**
 * Visible at EVERY width. This was `hidden sm:inline-flex`, so the one element
 * that says whether the numbers are current disappeared on precisely the device
 * where someone glances at a dashboard for four seconds between appointments.
 * "Are these numbers live?" is not a desktop-only question, and a stale figure
 * read as current on a phone does the same damage as one read on a monitor.
 *
 * Below `sm:` it drops the word "Synced" and keeps the dot and the age — the
 * information survives, only the prose is trimmed. The full phrasing stays in
 * `title` and in the screen-reader text.
 */
function Shell({
  dot,
  pulse,
  label,
  short,
}: {
  dot: string;
  pulse: boolean;
  label: string;
  short: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[12px]"
      style={{ color: "var(--text-muted)" }}
      title={label}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full${pulse ? " live-dot" : ""}`}
        style={{ background: dot }}
      />
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="hidden sm:inline">
        {label}
      </span>
      <span aria-hidden="true" className="tnum sm:hidden">
        {short}
      </span>
    </span>
  );
}
