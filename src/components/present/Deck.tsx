"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { clampSlide, type Deck as DeckData, type Slide } from "@/lib/present/slides";
import { SlideView } from "./SlideView";

/**
 * Meeting mode — the deck, its keyboard, and its exits.
 *
 * ── What this has to get right, none of which is visual ─────────────────
 *
 * **1 · Reloading mid-call must not lose the presenter's place.** The slide
 * index lives in the URL. A share-screen session that drops and comes back
 * lands on the same slide instead of at the beginning with a room watching.
 *
 * **2 · The keyboard cannot be a guess.** ← → space Home End Escape, and every
 * one of them is also a visible control, because a presenter who cannot
 * remember the shortcut mid-sentence needs a button, and because a keyboard-only
 * interface is unusable for anyone who cannot use one.
 *
 * **3 · What is NOT in the deck is told to the presenter, before they start.**
 * A shorter deck with no explanation is how somebody walks into a call not
 * knowing revenue is missing. The pre-flight card names every dropped slide and
 * its reason; the room never sees it.
 *
 * **4 · Nothing here fetches.** The whole deck is built server-side and handed
 * over complete, so no slide can arrive mid-presentation, spin, or fail.
 */

interface Props {
  deck: DeckData;
  slug: string;
  /** Where "Leave" goes — back to the dashboard, keeping range and platform. */
  backHref: string;
  initialSlide: number;
  /** Staff see the pre-flight card. A client-role viewer does not. */
  staff: boolean;
}

export function DeckView({ deck, slug, backHref, initialSlide, staff }: Props) {
  const total = deck.slides.length;
  const [index, setIndex] = useState(() => clampSlide(initialSlide, total));
  const [preflight, setPreflight] = useState(staff && deck.skipped.length > 0);
  const stageRef = useRef<HTMLDivElement>(null);
  /*
   * The live index, read by the key handler. Kept in a ref so the handler is
   * bound once rather than re-bound on every slide — a listener that churns
   * twenty times during a presentation is a listener that can be missing at the
   * moment somebody presses a key.
   */
  const indexRef = useRef(index);
  indexRef.current = index;

  const go = useCallback(
    (next: number) => {
      setIndex((prev) => {
        const clamped = clampSlide(next, total);
        if (clamped !== prev) {
          /*
           * `replaceState`, not `pushState`. Twenty slides would otherwise put
           * twenty entries in the history stack, and the browser Back button —
           * which a presenter WILL hit — would walk back one slide at a time
           * instead of leaving.
           */
          const url = new URL(window.location.href);
          url.searchParams.set("slide", String(clamped));
          window.history.replaceState(null, "", url);
        }
        return clamped;
      });
    },
    [total],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Never steal a key from a text field; there are none here today, and
      // that is exactly the kind of thing that stops being true.
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;

      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
        case " ":
          e.preventDefault();
          setPreflight(false);
          go(indexRef.current + 1);
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          go(indexRef.current - 1);
          break;
        case "Home":
          e.preventDefault();
          go(0);
          break;
        case "End":
          e.preventDefault();
          go(total - 1);
          break;
        case "Escape":
          // Escape leaves fullscreen if the browser has not already taken it;
          // otherwise it leaves the deck. Two meanings, in the order a
          // presenter expects them.
          if (document.fullscreenElement) return;
          if (preflight) setPreflight(false);
          break;
        case "f":
        case "F":
          e.preventDefault();
          void toggleFullscreen();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, total, preflight]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Denied by the browser or unsupported. The deck works either way, so
      // there is nothing to tell anyone.
    }
  }

  const slide: Slide | undefined = deck.slides[index];

  return (
    <div
      className="flex h-[100dvh] flex-col"
      style={{ background: "var(--surface-page)" }}
    >
      {/* ── The room sees this ─────────────────────────────────────── */}
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center px-6 py-8 sm:px-12"
      >
        {/*
         * Announced on change, so a screen reader follows the presentation
         * rather than being left on slide one. `atomic` because a slide is one
         * statement, not a stream of edits.
         */}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          Slide {index + 1} of {total}
        </div>
        {slide && <SlideView slide={slide} currency={deck.currency} />}
      </div>

      {/* ── Controls ───────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center gap-3 border-t px-4 py-2.5"
        style={{ borderColor: "var(--border)" }}
      >
        <a
          href={backHref}
          className="btn-ghost inline-flex items-center gap-1 rounded-[8px] px-2.5 py-1.5 text-[12px]"
          style={{ color: "var(--text-muted)" }}
        >
          <Icon name="arrowLeft" size={12} /> Leave
        </a>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => go(index - 1)}
          disabled={index === 0}
          aria-label="Previous slide"
          className="btn-ghost rounded-[8px] px-3 py-1.5 text-[13px] disabled:opacity-40"
          style={{ color: "var(--text-secondary)" }}
        >
          ←
        </button>
        <span
          className="tnum text-[12px] tabular-nums"
          style={{ color: "var(--text-muted)" }}
        >
          {index + 1} / {total}
        </span>
        <button
          type="button"
          onClick={() => {
            setPreflight(false);
            go(index + 1);
          }}
          disabled={index >= total - 1}
          aria-label="Next slide"
          className="btn-ghost rounded-[8px] px-3 py-1.5 text-[13px] disabled:opacity-40"
          style={{ color: "var(--text-secondary)" }}
        >
          →
        </button>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          className="btn-ghost rounded-[8px] px-2.5 py-1.5 text-[12px]"
          style={{ color: "var(--text-muted)" }}
        >
          Full screen
        </button>
      </div>

      {/* A thin progress rule. Position in a deck is the one thing a room
          reliably wants to know and a presenter never remembers to say. */}
      <div
        className="h-0.5 shrink-0"
        style={{ background: "var(--border)" }}
        role="presentation"
      >
        <div
          className="h-full transition-[width] duration-200"
          style={{
            width: `${total <= 1 ? 100 : (index / (total - 1)) * 100}%`,
            background: "var(--accent)",
          }}
        />
      </div>

      {/* ── Pre-flight: the presenter's copy, never the room's ────────── */}
      {preflight && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: "color-mix(in srgb, var(--surface-page) 92%, transparent)" }}
          role="dialog"
          aria-modal="true"
          aria-label="Before you present"
        >
          <div className="card max-w-lg p-6">
            <h2
              className="text-[15px] font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              {deck.skipped.length} slide{deck.skipped.length === 1 ? "" : "s"} not
              in this deck
            </h2>
            <p
              className="mt-1.5 text-[12.5px] leading-relaxed"
              style={{ color: "var(--text-muted)" }}
            >
              Listed so you find out now rather than when the slide does not
              arrive. Only you see this.
            </p>
            <ul className="mt-4 grid gap-2">
              {deck.skipped.map((s) => (
                <li
                  key={s.label}
                  className="rounded-[9px] border p-2.5 text-[12.5px]"
                  style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
                >
                  <strong style={{ color: "var(--text-primary)" }}>{s.label}</strong>
                  <span style={{ color: "var(--text-secondary)" }}> — {s.why}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPreflight(false)}
                className="rounded-[8px] px-3 py-1.5 text-[13px] font-medium"
                style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
              >
                Start presenting
              </button>
              <a
                href={`/c/${slug}`}
                className="btn-ghost rounded-[8px] px-3 py-1.5 text-[13px]"
                style={{ color: "var(--text-secondary)" }}
              >
                Fix it first
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
