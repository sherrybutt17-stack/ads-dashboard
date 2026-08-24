"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
/*
 * From `framings.ts`, not `summary.ts`: that module imports the Anthropic SDK
 * at module scope and would follow these four labels into the browser bundle.
 */
import { FRAMINGS, FRAMING_LABEL, FRAMING_HINT, type Framing } from "@/lib/ai/framings";
// Type-only, so the store — and the database client behind it — is erased.
import type { StoredSummary } from "@/lib/ai/store";

/**
 * The written summary — draft, edit, publish.
 *
 * Staff only; the section is filtered out of a client's registry entirely.
 *
 * ---
 *
 * THE SHAPE OF THIS PANEL IS THE ARGUMENT.
 *
 * "Generate" produces a draft in a textarea. Nothing leaves this screen until
 * somebody presses "Publish", which is a separate button with a separate
 * endpoint, and the published text is frozen — regenerating afterwards changes
 * what is on screen and not what the client is reading.
 *
 * The flag above the draft is the other half. Every figure in the text is
 * checked against what the metrics engine computed, and an unrecognised one is
 * named rather than counted. It is a warning, not a lock: a person editing
 * their own paragraph may legitimately mention a number this system has never
 * heard of. What must not happen is a number reaching a client with nobody
 * having looked at it.
 */

type Props = {
  slug: string;
  platform: string;
  rangeStart: string;
  rangeEnd: string;
  periodLabel: string;
  initial: StoredSummary[];
  /** Null when the feature is wired up; a sentence when it is not. */
  unavailable: string | null;
  configured: boolean;
};

type Busy = null | "generating" | "saving" | "publishing";

export function WeeklySummary({
  slug,
  platform,
  rangeStart,
  rangeEnd,
  periodLabel,
  initial,
  unavailable,
  configured,
}: Props) {
  const [framing, setFraming] = useState<Framing>("summary");
  const [stored, setStored] = useState<StoredSummary[]>(initial);
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const current = stored.find((s) => s.framing === framing) ?? null;
  // The textarea shows local edits when there are any, and the stored copy
  // otherwise — so switching framing does not silently discard typing.
  const shownHeadline = dirty ? headline : (current?.headline ?? "");
  const shownBody = dirty ? body : (current?.body ?? "");
  const issues = current?.verification?.issues ?? [];

  const period = { start: rangeStart, end: rangeEnd, platform };

  function select(next: Framing) {
    if (dirty && !confirm("Discard your unsaved edits to this framing?")) return;
    setDirty(false);
    setError(null);
    setFraming(next);
  }

  function replace(next: StoredSummary) {
    setStored((prev) => [...prev.filter((s) => s.framing !== next.framing), next]);
    setDirty(false);
  }

  async function call(
    path: string,
    method: string,
    payload: Record<string, unknown>,
    phase: Busy,
  ) {
    setBusy(phase);
    setError(null);
    try {
      const res = await fetch(`/api/c/${slug}/summary${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...period, framing, ...payload }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Request failed (${res.status}).`);
        return null;
      }
      if (json.summary) replace(json.summary as StoredSummary);
      return json;
    } catch {
      setError("Could not reach the server.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || Boolean(unavailable);

  return (
    <section className="card p-5" aria-label="Written summary">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Written summary
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
            {periodLabel} · drafted from the figures on this page, never sent
            automatically
          </p>
        </div>
        <span
          className="rounded-full px-2 py-0.5 text-[11px]"
          style={{
            background: "var(--surface-1)",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
          }}
        >
          agency only
        </span>
      </div>

      {/* Framing selector. */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        {FRAMINGS.map((f) => {
          const has = stored.some((s) => s.framing === f);
          const live = stored.find((s) => s.framing === f)?.published != null;
          const active = f === framing;
          return (
            <button
              key={f}
              type="button"
              onClick={() => select(f)}
              aria-pressed={active}
              title={FRAMING_HINT[f]}
              className="rounded-full px-3 py-1 text-xs transition-colors"
              style={{
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
                fontWeight: active ? 600 : 400,
              }}
            >
              {FRAMING_LABEL[f]}
              {/* A dot for "drafted", a filled dot for "published" — never
                  colour alone, and never a bare colour swatch with no meaning. */}
              {has && (
                <span
                  className="ml-1.5 text-[10px]"
                  style={{ color: live ? "var(--status-good)" : "var(--text-muted)" }}
                  aria-label={live ? "published" : "draft saved"}
                >
                  {live ? "●" : "○"}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
        {FRAMING_HINT[framing]}
      </p>

      {unavailable && (
        <p
          className="mt-4 rounded-[10px] border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: "var(--text-secondary)",
          }}
        >
          {unavailable}
        </p>
      )}

      {!configured && !unavailable && (
        <p
          className="mt-4 rounded-[10px] border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: "var(--text-secondary)",
          }}
        >
          <strong style={{ color: "var(--text-primary)" }}>Drafting is not configured.</strong>{" "}
          Set <code>ANTHROPIC_API_KEY</code> to generate summaries. You can still
          write and publish one by hand — every figure on this page is unaffected
          either way.
        </p>
      )}

      {/* 🔴 The unverified-figure flag. Named, not counted. */}
      {issues.length > 0 && (
        <div
          className="mt-4 rounded-[10px] border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--status-critical)",
            background: "color-mix(in srgb, var(--status-critical) 8%, transparent)",
            color: "var(--text-secondary)",
          }}
          role="alert"
        >
          <strong style={{ color: "var(--text-primary)" }}>
            {issues.length} figure{issues.length === 1 ? "" : "s"} here {issues.length === 1 ? "does" : "do"} not
            match anything on this page:
          </strong>{" "}
          {issues.map((i, n) => (
            <span key={`${i.token}-${n}`}>
              {n > 0 && "; "}
              <code>{i.token}</code>
              {i.nearest && ` (nearest we hold: ${i.nearest.value} — ${i.nearest.label})`}
            </span>
          ))}
          . Check each one before publishing.
        </div>
      )}

      {error && (
        <p className="mt-4 text-xs" style={{ color: "var(--status-critical)" }} role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 grid gap-2">
        <input
          value={shownHeadline}
          onChange={(e) => {
            setHeadline(e.target.value);
            setBody(shownBody);
            setDirty(true);
          }}
          placeholder="Headline — one line"
          className="w-full rounded-[10px] border px-3 py-2 text-sm"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
        <textarea
          value={shownBody}
          onChange={(e) => {
            setBody(e.target.value);
            setHeadline(shownHeadline);
            setDirty(true);
          }}
          rows={7}
          placeholder="Nothing drafted for this framing yet."
          className="w-full rounded-[10px] border px-3 py-2 text-sm leading-relaxed"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || !configured}
          onClick={() => call("", "POST", {}, "generating")}
          className="rounded-[8px] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
        >
          {busy === "generating"
            ? "Drafting…"
            : current
              ? "Redraft"
              : "Draft with AI"}
        </button>

        <button
          type="button"
          disabled={disabled || !shownBody.trim() || !shownHeadline.trim()}
          onClick={() =>
            call("", "PUT", { headline: shownHeadline, body: shownBody }, "saving")
          }
          className="rounded-[8px] border px-3 py-1.5 text-xs disabled:opacity-50"
          style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
        >
          {busy === "saving" ? "Saving…" : "Save edits"}
        </button>

        <span className="flex-1" />

        {current?.published ? (
          <>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {current.hasUnpublishedChanges
                ? "Edited since publishing — the client still sees the published version."
                : "Published — visible on shared reports."}
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => call("/publish", "POST", { published: true }, "publishing")}
              className="rounded-[8px] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{
                background: current.hasUnpublishedChanges ? "var(--accent)" : "transparent",
                color: current.hasUnpublishedChanges ? "var(--accent-ink)" : "var(--text-muted)",
                border: current.hasUnpublishedChanges ? "none" : "1px solid var(--border)",
              }}
            >
              {current.hasUnpublishedChanges ? "Publish update" : "Republish"}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => call("/publish", "POST", { published: false }, "publishing")}
              className="rounded-[8px] border px-3 py-1.5 text-xs disabled:opacity-50"
              style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
            >
              Withdraw
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled || !current || dirty}
            title={
              dirty
                ? "Save your edits first — publishing sends the saved text, not what is in the box."
                : undefined
            }
            onClick={() => call("/publish", "POST", { published: true }, "publishing")}
            className="flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            <Icon name="check" size={12} />
            {busy === "publishing" ? "Publishing…" : "Publish to client report"}
          </button>
        )}
      </div>

      <p className="mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Drafts are private to the agency. Only a published summary appears on a
        shared report, and republishing is the only way to change what a
        recipient sees.
      </p>
    </section>
  );
}
