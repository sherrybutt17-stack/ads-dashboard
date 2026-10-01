"use client";

import { useCallback, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";

/**
 * Create and manage share links for one client.
 *
 * The design follows from one property of the thing being made: **a share URL
 * is a bearer credential that cannot be recalled once sent.** So the UI is
 * arranged to make the consequences visible at the moment of the decision
 * rather than in a settings page nobody opens:
 *
 *   · The period is shown, fixed, and stated as permanent — this is not a live
 *     link, and someone expecting one would otherwise find out next quarter.
 *   · Expiry is a required choice, not a default hidden behind "advanced".
 *   · The token appears exactly once and says so. It is not recoverable,
 *     because only its hash was ever stored.
 *   · Existing links list their view count, so "did they ever open it?" and
 *     "why was this opened three weeks after the meeting?" are both answerable.
 */

interface ShareLinkView {
  id: string;
  label: string | null;
  rangeStart: string;
  rangeEnd: string;
  platform: string;
  hasPassword: boolean;
  expiresAt: string;
  revokedAt: string | null;
  /** Decided by the SERVER clock — see the GET handler for why. */
  active: boolean;
  createdAt: string;
  viewCount: number;
  lastViewedAt: string | null;
}

/** Whether this deployment can send mail, as the share GET reports it. */
interface EmailConfigView {
  configured: boolean;
  /** A sentence written for an operator, or null when the sender is fine. */
  senderProblem: string | null;
}

const TTL_OPTIONS = [7, 30, 90] as const;

/** Matches the server's `z.string().email()` closely enough to gate a button. */
const LOOKS_LIKE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;
const INPUT_CLASS = "w-full rounded-[8px] border px-3 py-2 text-[13px]";

export function ShareReport({
  clientId,
  rangeStart,
  rangeEnd,
  rangeText,
  platform,
}: {
  clientId: string;
  rangeStart: string;
  rangeEnd: string;
  /** The human range label, so the modal and the header agree exactly. */
  rangeText: string;
  platform: string;
}) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<ShareLinkView[] | null>(null);
  const [label, setLabel] = useState("");
  const [ttlDays, setTtlDays] = useState<number>(30);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * 🔴 Defaults to "copy", and switching is an explicit act.
   *
   * This dialog mints a bearer credential that cannot be recalled. A mode the
   * operator did not notice they were in is the one way this UI could send a
   * link to a client that was meant to be pasted into an internal channel —
   * so the existing behaviour stays the default and email is a deliberate tab.
   */
  const [mode, setMode] = useState<"copy" | "email">("copy");
  const [recipientText, setRecipientText] = useState("");
  const [message, setMessage] = useState("");
  const [sentCount, setSentCount] = useState<number | null>(null);
  const [emailCfg, setEmailCfg] = useState<EmailConfigView | null>(null);

  /*
   * Split on commas OR whitespace — the same expression `ReportSchedule` uses
   * for its recipient field, because an operator who learns one should not
   * discover the other behaves differently. Parsed on every keystroke so the
   * chips below act as the confirmation that two addresses were actually read
   * as two.
   */
  const recipients = [
    // De-duplicated case-insensitively, exactly as the server does, so the
    // chips and the "Send to N" count agree with what is actually sent — and
    // two identical chips no longer share a React key.
    ...new Set(
      recipientText
        .split(/[,\s]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/${clientId}/share`);
      if (!res.ok) return;
      const json = await res.json();
      setLinks(json.links ?? []);
      setEmailCfg(json.email ?? null);
    } catch {
      /* the list is supporting detail; a failure to load it must not block
         creating a link, which is what the operator came here to do */
    }
  }, [clientId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rangeStart,
          rangeEnd,
          platform,
          label: label.trim() || null,
          ttlDays,
          password: password.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not create the link");
        return;
      }
      setMinted(json.url);
      setSentCount(null);
      setCopied(false);
      setLabel("");
      setPassword("");
      void load();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  async function sendByEmail() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/share/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: recipients,
          rangeStart,
          rangeEnd,
          platform,
          label: label.trim() || undefined,
          ttlDays,
          password: password.trim() || undefined,
          message: message.trim() || undefined,
        }),
      });
      /*
       * Tolerant of a body that is not JSON — a proxy's HTML error page, a
       * timeout. Parsing it used to throw into the catch below, which reported
       * "Could not reach the server" for a request that HAD reached it and
       * may well have minted a link.
       */
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Refresh on every failure: a link may exist even if the body is lost.
        void load();
        /*
         * The route returns the URL alongside the error when the link was
         * minted but the send failed. Showing it means the operator still has
         * something to paste rather than starting over — and the link exists
         * either way, so hiding it would only make it invisible, not absent.
         */
        setError(json.error ?? `Could not send the report (HTTP ${res.status}).`);
        if (json.url) {
          setMinted(json.url);
          setCopied(false);
        }
        return;
      }
      setMinted(json.url);
      setSentCount(json.recipients ?? recipients.length);
      setCopied(false);
      setLabel("");
      setPassword("");
      setRecipientText("");
      setMessage("");
      void load();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/clients/${clientId}/share/${id}`, { method: "DELETE" });
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted);
      setCopied(true);
    } catch {
      // Clipboard is permission-gated and blocked outright in some contexts.
      // The URL is on screen and selectable, so this is a convenience failing,
      // not the feature failing — say nothing rather than raise an error.
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // Fetched on the click that opens the dialog rather than from an
          // effect watching `open`: the list is only ever needed as a result of
          // this interaction, and an effect would additionally re-fire on every
          // change to its dependencies.
          void load();
        }}
        className="inline-flex items-center gap-1.5 rounded-[9px] border px-3 py-1.5 text-[13px] font-medium transition-colors hover:opacity-80"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--surface-2)",
          color: "var(--text-secondary)",
        }}
      >
        <Icon name="link" size={13} />
        Share
      </button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          /*
           * A full reset, not a partial one. `sentCount` surviving a close made
           * the next COPIED link read "Sent to 1 recipient"; `mode` surviving
           * it reopened the dialog on "Email it", contradicting the rule that
           * copying is the default and emailing is a deliberate choice.
           */
          setMinted(null);
          setError(null);
          setSentCount(null);
          setMode("copy");
        }}
        busy={busy}
        title="Share this report"
        description="A read-only link to the figures below. No lead names, emails or phone numbers are included."
      >
        <div className="flex flex-col gap-4">
          {/*
           * 🔴 Rendered ABOVE the branch, so it survives the switch to the
           * minted screen.
           *
           * It used to live inside the form only. When a send failed AFTER the
           * link was minted — an unverified sending domain is the common case —
           * the route answers with both an error and the url, the url flipped
           * this to the minted screen, and the error was rendered by the branch
           * that had just been replaced. The operator saw a green "Link
           * created" and no indication whatsoever that the email had not gone.
           * That is the worst possible failure for this feature: silent, and
           * indistinguishable from success.
           */}
          {error && minted && (
            <p
              className="rounded-[8px] border px-3 py-2 text-[12px] leading-snug"
              style={{
                borderColor: "var(--danger, #b3261e)",
                color: "var(--danger, #b3261e)",
              }}
            >
              {error}
            </p>
          )}
          {minted ? (
            <MintedLink
              url={minted}
              copied={copied}
              onCopy={copy}
              onNew={() => {
                setMinted(null);
                setSentCount(null);
                setError(null);
              }}
              sentCount={sentCount}
              /* Green tick only when nothing went wrong. */
              failed={Boolean(error)}
            />
          ) : (
            <>
              {/*
                Two ways to deliver the same link. Rendered as tabs rather than
                a checkbox so the active mode is legible at a glance — the
                button at the bottom changes what it does, and a control that
                changes an action's meaning should not be a detail.
              */}
              <div
                className="flex gap-1 rounded-[9px] border p-1"
                style={{ borderColor: "var(--border)" }}
                role="tablist"
                aria-label="How to share"
              >
                {(
                  [
                    ["copy", "Copy a link"],
                    ["email", "Email it"],
                  ] as const
                ).map(([m, text]) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => {
                      setMode(m);
                      setError(null);
                    }}
                    className="flex-1 rounded-[7px] px-3 py-1.5 text-[12.5px] font-medium transition-colors"
                    style={{
                      background:
                        mode === m ? "var(--surface-2)" : "transparent",
                      color:
                        mode === m
                          ? "var(--text-primary)"
                          : "var(--text-muted)",
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>

              {mode === "email" && emailCfg && !emailCfg.configured && (
                <p
                  className="rounded-[8px] border px-3 py-2 text-[12px] leading-snug"
                  style={{
                    borderColor: "var(--border-strong)",
                    background: "var(--surface-2)",
                    color: "var(--text-muted)",
                  }}
                >
                  Email is not configured on this deployment, so nothing can be
                  sent from here. Set <code>RESEND_API_KEY</code> and{" "}
                  <code>RESEND_FROM</code>, then reload. You can still create a
                  link and send it yourself.
                </p>
              )}
              {mode === "email" && emailCfg?.senderProblem && (
                /* Shown verbatim — it is already a sentence for an operator. */
                <p
                  className="rounded-[8px] border px-3 py-2 text-[12px] leading-snug"
                  style={{
                    borderColor: "var(--border-strong)",
                    background: "var(--surface-2)",
                    color: "var(--text-muted)",
                  }}
                >
                  {emailCfg.senderProblem}
                </p>
              )}

              {mode === "email" && (
                <>
                  <Field
                    label="Send to"
                    hint="Up to five addresses, separated by commas or spaces. They receive the link — never an attachment, so the figures stay correctable."
                  >
                    <input
                      type="text"
                      value={recipientText}
                      onChange={(e) => setRecipientText(e.target.value)}
                      placeholder="finance@client.com, cfo@client.com"
                      className={INPUT_CLASS}
                      style={inputStyle}
                    />
                    {recipients.length > 0 && (
                      /*
                         The parsed result, shown back. "Typed two addresses
                         with no separator" is otherwise invisible until the
                         send fails or, worse, succeeds to one wrong address.
                      */
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {recipients.map((r) => {
                          const ok = LOOKS_LIKE_EMAIL.test(r);
                          return (
                            <span
                              key={r}
                              className="rounded-[5px] border px-1.5 py-0.5 text-[11px]"
                              style={{
                                borderColor: ok
                                  ? "var(--border-strong)"
                                  : "var(--danger, #b3261e)",
                                color: ok
                                  ? "var(--text-secondary)"
                                  : "var(--danger, #b3261e)",
                              }}
                            >
                              {r}
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </Field>

                  <Field
                    label="Message (optional)"
                    hint="Added above the link. Plain text — it is never read as HTML."
                  >
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Here's the July report ahead of Thursday's call."
                      maxLength={500}
                      rows={3}
                      className={INPUT_CLASS}
                      style={inputStyle}
                    />
                    <span
                      className="mt-1 block text-right text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {message.length}/500
                    </span>
                  </Field>
                </>
              )}

              <Field
                label="Period"
                hint="Fixed permanently. The link will always show this period, not whatever is current when it is opened."
              >
                <div
                  className="tnum rounded-[8px] border px-3 py-2 text-[13px]"
                  style={{
                    borderColor: "var(--border)",
                    background: "var(--surface-2)",
                    color: "var(--text-primary)",
                  }}
                >
                  {rangeText}
                </div>
              </Field>

              <Field label="Label" hint="Your own note. The recipient never sees it.">
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="July board pack"
                  maxLength={80}
                  className={INPUT_CLASS}
                  style={inputStyle}
                />
              </Field>

              <Field
                label="Access expires after"
                hint="A forwarded URL cannot be recalled, so every link is time-limited."
              >
                <div className="flex gap-1.5">
                  {TTL_OPTIONS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setTtlDays(d)}
                      aria-pressed={ttlDays === d}
                      className="rounded-[8px] border px-3 py-1.5 text-[12px] font-medium"
                      style={{
                        borderColor:
                          ttlDays === d ? "var(--accent)" : "var(--border-strong)",
                        background:
                          ttlDays === d ? "var(--surface-1)" : "transparent",
                        color:
                          ttlDays === d
                            ? "var(--text-primary)"
                            : "var(--text-muted)",
                      }}
                    >
                      {d} days
                    </button>
                  ))}
                </div>
              </Field>

              <Field
                label="Password (optional)"
                hint="Raises the link from “anyone with the URL” to “anyone with the URL and the phrase”. Send it separately from the link."
              >
                <input
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave blank for no password"
                  maxLength={64}
                  className={INPUT_CLASS}
                  style={inputStyle}
                />
              </Field>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void (mode === "email" ? sendByEmail() : create())}
                  /*
                   * In email mode the button stays disabled until every parsed
                   * chip is a plausible address and the deployment can actually
                   * send — a send that 400s after the operator has typed a
                   * message is a worse experience than a button that explains
                   * itself by being unavailable.
                   */
                  disabled={
                    busy ||
                    (mode === "email" &&
                      (recipients.length === 0 ||
                        recipients.length > 5 ||
                        !recipients.every((r) => LOOKS_LIKE_EMAIL.test(r)) ||
                        emailCfg?.configured === false ||
                        Boolean(emailCfg?.senderProblem)))
                  }
                  className="rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
                  style={{ background: "var(--brand, var(--series-1))" }}
                >
                  {busy
                    ? mode === "email"
                      ? "Sending…"
                      : "Creating…"
                    : mode === "email"
                      ? `Send${recipients.length > 1 ? ` to ${recipients.length}` : ""}`
                      : "Create link"}
                </button>
                {error && (
                  <span
                    className="flex items-center gap-1.5 text-xs"
                    style={{ color: "var(--status-critical)" }}
                  >
                    <Icon name="alert" size={12} />
                    {error}
                  </span>
                )}
              </div>
            </>
          )}

          <ExistingLinks links={links} busy={busy} onRevoke={revoke} />
        </div>
      </Modal>
    </>
  );
}

/**
 * The one and only time the URL is visible.
 *
 * Stated plainly rather than left to be discovered: the server stored a hash,
 * not the token, so there is no screen anywhere that can show this again. An
 * operator who closes this dialog without copying has to create a new link —
 * which is a mild annoyance, and is the direct consequence of the property that
 * a database leak does not hand over every client's live report.
 */
function MintedLink({
  url,
  copied,
  onCopy,
  onNew,
  sentCount,
  failed,
}: {
  url: string;
  copied: boolean;
  onCopy: () => void;
  onNew: () => void;
  /**
   * True when the link exists but the SEND failed.
   *
   * The link is still shown — it was created and is revocable, so hiding it
   * would only make it invisible, not absent — but the heading must not read
   * as success.
   */
  failed?: boolean;
  /**
   * How many addresses it went to, or null when the link was only created.
   *
   * The URL is shown either way: after a send the operator often still wants
   * to paste it somewhere, and offering it here avoids minting a second link
   * with its own separate expiry to revoke later.
   */
  sentCount: number | null;
}) {
  return (
    <div
      className="rounded-[10px] border p-3"
      style={{ borderColor: "var(--border-strong)", background: "var(--surface-2)" }}
    >
      <div
        className="mb-2 flex items-center gap-1.5 text-xs font-medium"
        style={{ color: failed ? "var(--danger, #b3261e)" : "var(--status-good)" }}
      >
        <Icon name={failed ? "alert" : "check"} size={12} />{" "}
        {failed
          ? "Link created — but the email was NOT sent"
          : sentCount === null
            ? "Link created"
            : `Sent to ${sentCount} ${sentCount === 1 ? "recipient" : "recipients"}`}
      </div>
      <code
        className="block break-all rounded-[6px] px-2 py-1.5 text-[11px]"
        style={{
          background: "var(--surface-1)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-geist-mono), monospace",
        }}
      >
        {url}
      </code>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          /*
           * The minted view REPLACES the form, unmounting whatever had focus,
           * and the dialog no longer re-seats focus on every render (that was
           * the one-character-then-focus-lost bug). So focus is placed here,
           * on the thing the operator does next, instead of falling to <body>.
           */
          autoFocus
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1 text-[12px] font-medium"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-1)",
            color: "var(--text-secondary)",
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={onNew}
          className="text-[12px] underline underline-offset-2"
          style={{ color: "var(--text-muted)" }}
        >
          Create another
        </button>
      </div>
      <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Copy it now — only a hash of this link was stored, so it cannot be shown
        again.
      </p>
    </div>
  );
}

function ExistingLinks({
  links,
  busy,
  onRevoke,
}: {
  links: ShareLinkView[] | null;
  busy: boolean;
  onRevoke: (id: string) => void;
}) {
  if (!links) return null;
  const live = links.filter((l) => l.active);
  if (live.length === 0) {
    return (
      <p
        className="border-t pt-3 text-[11px]"
        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
      >
        No links are currently active for this client.
      </p>
    );
  }

  return (
    <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
      <div
        className="mb-2 text-xs font-medium"
        style={{ color: "var(--text-secondary)" }}
      >
        Active links
      </div>
      <ul className="flex flex-col gap-1.5">
        {live.map((l) => (
          <li
            key={l.id}
            className="flex items-start justify-between gap-3 text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="min-w-0">
              <span
                className="block truncate"
                style={{ color: "var(--text-secondary)" }}
              >
                {l.label || "Untitled link"}
                {l.hasPassword && " · password"}
              </span>
              <span className="tnum">
                {l.rangeStart} → {l.rangeEnd} · expires {l.expiresAt.slice(0, 10)} ·{" "}
                {l.viewCount === 0
                  ? "never opened"
                  : `${l.viewCount} view${l.viewCount === 1 ? "" : "s"}`}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onRevoke(l.id)}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1 underline underline-offset-2 disabled:opacity-50"
              style={{ color: "var(--status-critical)" }}
            >
              <Icon name="trash" size={11} />
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      {children}
      {hint && (
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {hint}
        </span>
      )}
    </div>
  );
}
