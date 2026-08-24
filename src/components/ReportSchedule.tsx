"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";

/**
 * Emailing this client their report on a schedule.
 *
 * ── What the panel has to say out loud ────────────────────────────────
 *
 * Three things, because each one is a way this quietly fails:
 *
 *   · **What the next email will cover.** A monthly schedule sends the previous
 *     complete month, not the last thirty days. Someone enabling it on the 15th
 *     is entitled to know that nothing goes out until the 1st.
 *   · **Whether the sender domain will actually deliver.** Mail from an
 *     unauthenticated domain is filed as spam, and a report sitting in a junk
 *     folder is worse than one never sent — the agency believes it arrived and
 *     the client believes it never did.
 *   · **The last failure, if there was one.** A schedule that silently stopped
 *     working is the `SHOWN = 0` failure of this feature.
 */

interface Schedule {
  enabled: boolean;
  cadence: "weekly" | "monthly";
  sendHour: number;
  recipients: string[];
  linkTtlDays: number;
  lastSentPeriod: string | null;
  lastSentAt: string | null;
  lastError: string | null;
}

interface Loaded {
  schedule: Schedule | null;
  configured: boolean;
  senderProblem: string | null;
  nextPeriod: { label: string; startKey: string; endKey: string } | null;
  alreadySent: boolean;
}

const EMPTY: Schedule = {
  enabled: false,
  cadence: "monthly",
  sendHour: 8,
  recipients: [],
  linkTtlDays: 30,
  lastSentPeriod: null,
  lastSentAt: null,
  lastError: null,
};

export function ReportSchedule({
  clientId,
  platform = "meta",
  timezone,
}: {
  clientId: string;
  platform?: "meta" | "google";
  timezone: string;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Schedule>(EMPTY);
  const [recipientText, setRecipientText] = useState("");
  const [busy, setBusy] = useState<null | "save" | "send">(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  /*
   * 🔴 A failed load must not look like "no schedule here".
   *
   * This used to be `.then(r => r.json()).catch(() => {})`, which produced two
   * silent failures and no visible one. A network error left `loaded` null and
   * the `if (!loaded) return null` below made the entire panel VANISH — so the
   * operator concludes the feature does not exist rather than that a request
   * failed, and there is nothing to retry. A non-OK response was worse: an
   * error body parses perfectly well as JSON, so `loaded` became
   * `{ error: "..." }`, every field it reads came back undefined, and the panel
   * rendered a confident empty schedule for a client that has one.
   *
   * This screen decides whether a real person receives an email. An empty state
   * has to name its own cause here, exactly as the dashboard's do.
   */
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`/api/clients/${clientId}/reports?platform=${platform}`)
      .then(async (r) => {
        // Checked BEFORE parsing: a 403 or 500 carries a JSON body too.
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as Loaded;
      })
      .then((json: Loaded) => {
        if (!live) return;
        // Cleared here rather than in the effect body: a synchronous setState
        // during an effect cascades a render, and this is the only path that
        // can legitimately clear the error anyway.
        setLoadError(false);
        setLoaded(json);
        const s = json.schedule ?? EMPTY;
        setDraft(s);
        setRecipientText((s.recipients ?? []).join(", "));
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [clientId, platform, reloadKey]);

  const recipients = recipientText
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  async function submit(sendNow: boolean) {
    setBusy(sendNow ? "send" : "save");
    setNote(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/reports`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          enabled: draft.enabled,
          cadence: draft.cadence,
          sendHour: draft.sendHour,
          recipients,
          linkTtlDays: draft.linkTtlDays,
          ...(sendNow ? { sendNow: true } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote({ kind: "bad", text: json.error ?? "Could not save." });
        return;
      }
      if (json.schedule) setDraft(json.schedule);
      if (sendNow) {
        setNote(
          json.sent
            ? {
                kind: "ok",
                text: `Sent ${json.period} to ${json.recipients} recipient${json.recipients === 1 ? "" : "s"}.`,
              }
            : { kind: "bad", text: json.error ?? "Nothing to send." },
        );
      } else {
        setNote({ kind: "ok", text: "Saved." });
      }
    } catch {
      setNote({ kind: "bad", text: "Could not reach the server." });
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <section className="card p-5" aria-label="Scheduled report">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Email this report on a schedule
        </h2>
        <p className="mt-2 text-[13px]" style={{ color: "var(--status-critical)" }}>
          Could not load the schedule for this client. Any existing schedule is
          unchanged and still running — this is a problem reading it, not a
          problem with the schedule itself.
        </p>
        <button
          type="button"
          className="btn mt-3"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          Try again
        </button>
      </section>
    );
  }

  if (!loaded) return null;

  const blocked = !loaded.configured || Boolean(loaded.senderProblem);

  return (
    <section className="card p-5" aria-label="Scheduled report">
      <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Email this report on a schedule
      </h2>
      <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
        Sends a link to the report, not an attachment — so it expires, can be
        revoked, and shows corrected figures if Meta restates them.
      </p>

      {blocked && (
        <p
          className="mt-3 rounded-[10px] border px-3 py-2.5 text-[12.5px] leading-relaxed"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: "var(--text-secondary)",
          }}
        >
          {!loaded.configured ? (
            <>
              <strong style={{ color: "var(--text-primary)" }}>
                Email is not configured.
              </strong>{" "}
              Set <code>RESEND_API_KEY</code> and <code>REPORT_FROM</code> to
              enable this. Everything else on this page works without it.
            </>
          ) : (
            <>
              <strong style={{ color: "var(--status-critical)" }}>
                This sender will not deliver.
              </strong>{" "}
              {loaded.senderProblem}
            </>
          )}
        </p>
      )}

      <div className="mt-4 grid gap-3">
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={blocked || busy !== null}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="mt-0.5"
          />
          <span style={{ color: "var(--text-primary)" }}>
            Send automatically
            <span className="block text-[11.5px]" style={{ color: "var(--text-muted)" }}>
              {loaded.nextPeriod ? (
                <>
                  {/*
                    Naming the period is the point. A monthly schedule covers the
                    previous COMPLETE month — someone switching this on mid-month
                    should not be waiting for an email that is not due yet.
                  */}
                  Next email covers <strong>{loaded.nextPeriod.label}</strong>
                  {loaded.alreadySent && " — already sent"}
                </>
              ) : (
                "Save to see what the next email will cover."
              )}
            </span>
          </span>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
            How often
            <select
              value={draft.cadence}
              disabled={busy !== null}
              onChange={(e) =>
                setDraft({ ...draft, cadence: e.target.value as Schedule["cadence"] })
              }
              className="mt-1 w-full rounded-[8px] border px-2.5 py-2 text-[13px]"
              style={{
                borderColor: "var(--border-strong)",
                background: "var(--surface-1)",
                color: "var(--text-primary)",
              }}
            >
              <option value="monthly">Monthly — the previous calendar month</option>
              <option value="weekly">Weekly — the previous Monday to Sunday</option>
            </select>
          </label>

          <label className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
            Sent at
            <select
              value={draft.sendHour}
              disabled={busy !== null}
              onChange={(e) => setDraft({ ...draft, sendHour: Number(e.target.value) })}
              className="mt-1 w-full rounded-[8px] border px-2.5 py-2 text-[13px]"
              style={{
                borderColor: "var(--border-strong)",
                background: "var(--surface-1)",
                color: "var(--text-primary)",
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
            <span className="mt-0.5 block text-[11px]" style={{ color: "var(--text-muted)" }}>
              {/* The client's own clock, not the server's. */}
              {timezone}
            </span>
          </label>
        </div>

        <label className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
          Send to
          <input
            type="text"
            value={recipientText}
            disabled={busy !== null}
            onChange={(e) => setRecipientText(e.target.value)}
            placeholder="owner@example.com, partner@example.com"
            className="mt-1 w-full rounded-[8px] border px-2.5 py-2 text-[13px]"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--surface-1)",
              color: "var(--text-primary)",
            }}
          />
          <span className="mt-0.5 block text-[11px]" style={{ color: "var(--text-muted)" }}>
            {recipients.length === 0
              ? "Comma separated. Nothing sends without at least one."
              : `${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`}
          </span>
        </label>

        <label className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
          Link stays open for
          <select
            value={draft.linkTtlDays}
            disabled={busy !== null}
            onChange={(e) => setDraft({ ...draft, linkTtlDays: Number(e.target.value) })}
            className="mt-1 w-full rounded-[8px] border px-2.5 py-2 text-[13px] sm:w-48"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--surface-1)",
              color: "var(--text-primary)",
            }}
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
      </div>

      {draft.lastError && (
        <p
          className="mt-3 flex items-start gap-1.5 text-[12px]"
          style={{ color: "var(--status-critical)" }}
        >
          <Icon name="alert" size={12} className="mt-[2px] shrink-0" />
          {/* A schedule that stopped working silently is this feature's version
              of the empty spreadsheet block. */}
          Last send failed: {draft.lastError}
        </p>
      )}

      {draft.lastSentAt && !draft.lastError && (
        <p className="mt-3 text-[11.5px]" style={{ color: "var(--text-muted)" }}>
          Last sent {draft.lastSentPeriod} on{" "}
          {new Date(draft.lastSentAt).toISOString().slice(0, 10)}.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void submit(false)}
          disabled={busy !== null}
          className="rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
          style={{ background: "var(--brand, var(--series-1))" }}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => void submit(true)}
          disabled={busy !== null || blocked || recipients.length === 0}
          className="rounded-[8px] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {busy === "send" ? "Sending…" : "Send now"}
        </button>
        {note && (
          <span
            role="status"
            className="text-[12px]"
            style={{
              color: note.kind === "ok" ? "var(--status-good)" : "var(--status-critical)",
            }}
          >
            {note.text}
          </span>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {/*
          "Send now" is not a separate path — it claims the period the same way
          the schedule does, so pressing it twice sends once.
        */}
        &ldquo;Send now&rdquo; sends the same period the schedule would, and will
        not resend one that has already gone out.
      </p>
    </section>
  );
}
