"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Where a client's alerts go — new leads, and budget pacing warnings.
 *
 * One destination, two rhythms: a lead alert is seconds old and can arrive ten
 * times an hour; a pacing warning is a slow fact about a whole month, capped at
 * one a week per direction. They share a channel because they share an
 * audience, and the panel says so rather than letting the second kind arrive
 * unannounced.
 *
 * Two things this form has to get right, and neither is the happy path.
 *
 * **A destination has to be provable before it is saved.** Pasting a webhook,
 * switching alerts on, and only discovering weeks later that the channel was
 * deleted is how this setting ends up looking live and doing nothing — the
 * exact silent failure this product exists to replace. So the test send happens
 * against the URL in the box, before it is stored.
 *
 * **The saved URL is never shown back.** A Slack incoming-webhook URL IS the
 * credential; anyone with it can post into the channel. The form reports which
 * service is configured and nothing more, which is why replacing it means
 * pasting a new one rather than editing the old.
 */

interface Props {
  clientId: string;
  initial: { configured: boolean; target: string | null; enabled: boolean };
}

const TARGET_LABEL: Record<string, string> = {
  slack: "Slack",
  discord: "Discord",
};

export function AlertSettings({ clientId, initial }: Props) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<null | "save" | "test" | "toggle">(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const call = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/clients/${clientId}/alerts`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, json: await res.json().catch(() => ({})) };
  };

  const save = async () => {
    setBusy("save");
    setMessage(null);
    const { res, json } = await call({ url });
    setBusy(null);
    if (!res.ok) {
      setMessage({ ok: false, text: json.error ?? "Could not save." });
      return;
    }
    setState(json);
    setUrl("");
    setMessage({ ok: true, text: "Saved." });
    router.refresh();
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    const { res, json } = await call({ url, test: true });
    setBusy(null);
    setMessage(
      res.ok
        ? { ok: true, text: "Sent — check the channel." }
        : {
            ok: false,
            // The destination's own words. "Failed" tells nobody whether the
            // URL is wrong, the channel is gone, or Slack is down.
            text: json.error ? `Rejected: ${json.error}` : "Could not send.",
          },
    );
  };

  const toggle = async () => {
    setBusy("toggle");
    setMessage(null);
    const { res, json } = await call({ enabled: !state.enabled });
    setBusy(null);
    if (!res.ok) {
      setMessage({ ok: false, text: json.error ?? "Could not change that." });
      return;
    }
    setState(json);
    router.refresh();
  };

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Alerts
      </h2>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Posts to Slack or Discord about a second after a paid lead arrives, with
        the campaign, the lead&rsquo;s place in the day and their phone number.
        {/*
         * Said plainly rather than buried: names, phone numbers and email
         * addresses leave this system when the switch is on.
         */}{" "}
        <strong>Lead names and contact details are sent to that channel</strong>,
        so pick one only the right people can read.
      </p>

      <div
        className="mt-4 flex flex-wrap items-center gap-3 rounded-[10px] p-3"
        style={{ background: "var(--surface-2)" }}
      >
        <span className="text-[13px]" style={{ color: "var(--text-primary)" }}>
          {state.configured ? (
            <>
              {TARGET_LABEL[state.target ?? ""] ?? "A destination"} is configured
              {/*
               * A destination that no longer passes the allowlist is reported
               * rather than left looking healthy — the send path refuses it, so
               * the form must not disagree.
               */}
              {state.target === null && (
                <span style={{ color: "var(--status-critical)" }}>
                  {" "}
                  but is no longer an accepted destination
                </span>
              )}
              .
            </>
          ) : (
            <>No destination set, so nothing is being sent.</>
          )}
        </span>
        {state.configured && (
          <button
            type="button"
            onClick={toggle}
            disabled={busy !== null}
            className="btn-ghost rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium"
            style={{ color: state.enabled ? "var(--status-warning)" : "var(--accent)" }}
          >
            {busy === "toggle" ? "…" : state.enabled ? "Mute alerts" : "Switch alerts on"}
          </button>
        )}
        <span
          className="tnum text-[11.5px]"
          style={{
            color: state.enabled ? "var(--status-good)" : "var(--text-muted)",
          }}
        >
          {state.enabled ? "● live" : "○ off"}
        </span>
      </div>

      <label
        className="mt-4 block text-[12.5px] font-medium"
        htmlFor="alert-url"
        style={{ color: "var(--text-secondary)" }}
      >
        {state.configured ? "Replace the webhook URL" : "Webhook URL"}
      </label>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input
          id="alert-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.slack.com/services/…"
          className="min-w-[260px] flex-1 rounded-[9px] border px-3 py-2 text-[13px]"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
          }}
        />
        <button
          type="button"
          onClick={test}
          disabled={busy !== null || url.trim() === ""}
          className="btn-ghost rounded-[9px] px-3 py-2 text-[13px] font-medium"
        >
          {busy === "test" ? "Sending…" : "Send a test"}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy !== null || url.trim() === ""}
          className="btn-primary rounded-[9px] px-3 py-2 text-[13px] font-medium"
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </div>

      {message && (
        <p
          className="mt-2 text-[12.5px]"
          style={{
            color: message.ok ? "var(--status-good)" : "var(--status-critical)",
          }}
        >
          {message.text}
        </p>
      )}

      {/*
        Said here rather than left for someone to discover: this destination
        carries two different kinds of message with very different rhythms, and
        an operator who set it up for lead pings deserves to know before a
        budget warning appears in the same channel.
      */}
      <p className="mt-3 text-[11.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        This destination also receives <strong>budget pacing</strong> warnings —
        a client projected to finish the month materially under or over the
        budget on their setup page, or one whose budget is spent with days still
        to run. Those are capped at one a week per direction and only go out
        during the client&rsquo;s working hours, so they cannot flood a channel
        the way a lead burst can.
      </p>
      <p className="mt-3 text-[11.5px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {/*
         * 🔴 The restriction is stated with its reason. "Invalid URL" for a
         * perfectly good Zapier hook reads as a bug; the actual rule is a
         * deliberate trade and takes one sentence to explain.
         */}
        Only Slack and Discord webhook URLs are accepted — a URL this server can
        be made to fetch is a way into the network it runs on, so the hosts are
        fixed rather than filtered. Alerts cover leads that count as paid under
        the lead filter above, are capped at ten an hour, and never fire for
        leads that arrived more than six hours ago, so reconnecting a client
        cannot flood the channel with its whole history.
        {/*
         * SMS is not offered, and the reason belongs where somebody would look
         * for it rather than in a commit message.
         */}{" "}
        For SMS, use a GoHighLevel workflow — it can text from the number the
        lead already recognises.
      </p>
    </section>
  );
}
