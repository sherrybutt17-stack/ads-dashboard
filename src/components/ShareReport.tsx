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

const TTL_OPTIONS = [7, 30, 90] as const;

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

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/${clientId}/share`);
      if (!res.ok) return;
      const json = await res.json();
      setLinks(json.links ?? []);
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
          setMinted(null);
          setError(null);
        }}
        busy={busy}
        title="Share this report"
        description="A read-only link to the figures below. No lead names, emails or phone numbers are included."
      >
        <div className="flex flex-col gap-4">
          {minted ? (
            <MintedLink url={minted} copied={copied} onCopy={copy} onNew={() => setMinted(null)} />
          ) : (
            <>
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
                  onClick={() => void create()}
                  disabled={busy}
                  className="rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
                  style={{ background: "var(--brand, var(--series-1))" }}
                >
                  {busy ? "Creating…" : "Create link"}
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
}: {
  url: string;
  copied: boolean;
  onCopy: () => void;
  onNew: () => void;
}) {
  return (
    <div
      className="rounded-[10px] border p-3"
      style={{ borderColor: "var(--border-strong)", background: "var(--surface-2)" }}
    >
      <div
        className="mb-2 flex items-center gap-1.5 text-xs font-medium"
        style={{ color: "var(--status-good)" }}
      >
        <Icon name="check" size={12} /> Link created
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
