"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import {
  DEFAULT_FROM_LOCAL,
  DOMAIN_EXPIRY_DAYS,
  cleanDisplayName,
  dnsZoneOf,
  fullHostName,
  normalizeDomain,
  readableFrom,
  normalizeLocalPart,
  statusLabel,
  type DnsRecord,
  type DomainView,
} from "@/lib/email-domains/identity";

/**
 * Settings → Email domain: send the agency's email from its own domain.
 *
 * One component for the whole journey — add the domain, copy the DNS records,
 * check, then live with it (test, rename the sender, remove) — because each
 * state is a few lines different from the next and an agency moves through
 * them in one sitting. Every change goes to `/api/agency/email-domain*` and
 * then `router.refresh()`, so what is shown is always the server's row, never
 * a local guess at it.
 *
 * Written for someone who has never opened a DNS panel: what to add, where,
 * what happens meanwhile, and that their existing email is not touched.
 */

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;
const INPUT_CLASS = "w-full rounded-[var(--radius-sm)] border px-3 py-2 text-[13px]";
const SMALL_BUTTON =
  "btn-ghost inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2.5 py-1 text-[12px]";

type Message = { ok: boolean; text: string } | null;

const BADGE: Record<string, string> = {
  good: "badge badge-good",
  warn: "badge badge-warn",
  bad: "badge badge-bad",
  neutral: "badge badge-neutral",
};

/** "6 Nov 2026" — the same on the server and in the browser, so it hydrates. */
function day(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/**
 * How a recipient's inbox shows the sender: the name, then the address. Not
 * the header itself — `formatFrom` quotes some names for the header, and
 * quote marks on screen would only confuse.
 */
function shownAs(name: string, address: string): string {
  const clean = cleanDisplayName(name);
  return clean ? `${clean} <${address}>` : address;
}

async function call(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  payload?: unknown,
): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(path, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json };
}

export function EmailDomainSettings({
  available,
  agencyName,
  supportEmail,
  domain,
  currentFrom,
  viaDomain,
  testRecipient,
  suggestedDmarc,
}: {
  /** False when this deployment has no agency-domains key. */
  available: boolean;
  agencyName: string;
  supportEmail: string | null;
  domain: DomainView | null;
  /** What this agency's emails go out as right now. */
  currentFrom: string | null;
  viaDomain: boolean;
  /** The operator's own login address, for the test email. */
  testRecipient: string | null;
  /** A DMARC record to suggest — only when the domain has none at any level. */
  suggestedDmarc: DnsRecord | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  async function run(label: string, path: string, method: "POST" | "PATCH" | "DELETE", payload?: unknown) {
    setBusy(label);
    setMessage(null);
    try {
      const { ok, json } = await call(path, method, payload);
      if (!ok) {
        setMessage({ ok: false, text: typeof json.error === "string" ? json.error : "That didn't work. Try again." });
        return null;
      }
      router.refresh();
      return json;
    } catch {
      setMessage({ ok: false, text: "Couldn't reach the server. Check your connection and try again." });
      return null;
    } finally {
      setBusy(null);
    }
  }

  if (!available) {
    return (
      <section className="card flex flex-col gap-2 p-5">
        <h2 className="text-sm font-semibold" style={{ color: "var(--section-ink, var(--text-primary))" }}>
          Send from your own domain
        </h2>
        <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Custom sending domains aren’t switched on for this dashboard yet. Until they are, emails to
          your clients go from {currentFrom ? <strong>{readableFrom(currentFrom)}</strong> : "our address"}.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Intro currentFrom={currentFrom} viaDomain={viaDomain} />

      {domain ? (
        <>
          <StatusCard
            domain={domain}
            busy={busy}
            onCheck={async () => {
              const json = await run("check", "/api/agency/email-domain/verify", "POST");
              if (json) {
                const status = (json.domain as DomainView | undefined)?.status;
                setMessage({
                  ok: true,
                  text:
                    status === "verified"
                      ? "Verified. Your emails now go from your own domain."
                      : "Checked. DNS changes can take a while to show up — we’ll keep checking every hour.",
                });
              }
            }}
          />
          {domain.status !== "verified" && (
            <RecordsCard records={domain.records} suggestedDmarc={suggestedDmarc} domain={domain.domain} />
          )}
          <SenderCard
            key={`${domain.fromLocal}|${domain.fromName ?? ""}|${domain.replyTo ?? ""}`}
            domain={domain}
            agencyName={agencyName}
            supportEmail={supportEmail}
            busy={busy}
            onSave={async (patch) => {
              const json = await run("save", "/api/agency/email-domain", "PATCH", patch);
              if (json) setMessage({ ok: true, text: "Saved." });
            }}
          />
          {domain.status === "verified" && (
            <details className="card p-5">
              <summary className="cursor-pointer text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                DNS records
              </summary>
              <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                Keep these in your DNS. If they’re removed, your emails start going from our address again.
              </p>
              <RecordList records={domain.records} zone={dnsZoneOf(domain.domain, domain.records)} />
            </details>
          )}
          <TestCard
            recipient={testRecipient}
            busy={busy}
            onTest={async () => {
              const json = await run("test", "/api/agency/email-domain/test", "POST");
              if (json) {
                setMessage({
                  ok: true,
                  text:
                    json.via === "agency_domain"
                      ? `Sent to ${json.to} from ${json.from}.`
                      : `Sent to ${json.to} from our address (${json.from ?? "our sender"}), because your domain isn’t sending yet.`,
                });
              }
            }}
          />
          <RemoveCard
            domain={domain.domain}
            busy={busy}
            onRemove={async () => {
              const json = await run("remove", "/api/agency/email-domain", "DELETE");
              if (json) setMessage({ ok: true, text: `${domain.domain} was removed.` });
            }}
          />
        </>
      ) : (
        <AddCard
          agencyName={agencyName}
          supportEmail={supportEmail}
          busy={busy}
          onAdd={async (payload) => {
            const json = await run("add", "/api/agency/email-domain", "POST", payload);
            if (json) setMessage({ ok: true, text: "Added. Now add the DNS records below." });
          }}
        />
      )}

      <div aria-live="polite" className="min-h-[18px]">
        {message && (
          <span
            className="inline-flex items-start gap-1 text-[12.5px]"
            style={{ color: message.ok ? "var(--status-good)" : "var(--status-critical)" }}
          >
            <Icon name={message.ok ? "check" : "alert"} size={13} className="mt-0.5 shrink-0" />
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card flex flex-col gap-3 p-5">
      <h2 className="text-sm font-semibold" style={{ color: "var(--section-ink, var(--text-primary))" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Intro({ currentFrom, viaDomain }: { currentFrom: string | null; viaDomain: boolean }) {
  return (
    <Card title="Send from your own domain">
      <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        Invites, password resets and reports to your clients can come from your own address, like
        reports@youragency.com, instead of ours. Your existing email keeps working: the records you
        add only allow us to send on your behalf.
      </p>
      {currentFrom && (
        <p className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
          {viaDomain ? "Your emails now go from" : "Right now your emails go from"}{" "}
          <span className="break-words font-medium" style={{ color: "var(--text-primary)" }}>
            {readableFrom(currentFrom)}
          </span>
        </p>
      )}
    </Card>
  );
}

function AddCard({
  agencyName,
  supportEmail,
  busy,
  onAdd,
}: {
  agencyName: string;
  supportEmail: string | null;
  busy: string | null;
  onAdd: (payload: { domain: string; fromLocal: string; fromName: string; replyTo: string }) => void;
}) {
  const [domainInput, setDomainInput] = useState("");
  const [local, setLocal] = useState(DEFAULT_FROM_LOCAL);
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const checked = domainInput.trim() ? normalizeDomain(domainInput) : null;
  const localChecked = normalizeLocalPart(local);
  const preview =
    checked?.ok && localChecked.ok
      ? shownAs(fromName.trim() || agencyName, `${localChecked.local}@${checked.domain}`)
      : null;
  const noReplies = !replyTo.trim() && !supportEmail;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!checked || !checked.ok) {
      setError(checked && !checked.ok ? checked.error : "Enter your domain, like youragency.com.");
      return;
    }
    if (!localChecked.ok) {
      setError(localChecked.error);
      return;
    }
    setError(null);
    onAdd({ domain: checked.domain, fromLocal: localChecked.local, fromName: fromName.trim(), replyTo: replyTo.trim() });
  }

  return (
    <Card title="Add your domain">
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Your domain
          </span>
          <input
            className={INPUT_CLASS}
            style={inputStyle}
            value={domainInput}
            placeholder="youragency.com"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            onChange={(e) => {
              setDomainInput(e.target.value);
              setError(null);
            }}
            disabled={busy !== null}
            aria-invalid={Boolean(checked && !checked.ok)}
          />
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            The part after the @ in your work email.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Send as
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <input
              className={`${INPUT_CLASS} max-w-[200px]`}
              style={inputStyle}
              value={local}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setLocal(e.target.value);
                setError(null);
              }}
              disabled={busy !== null}
              aria-label="The part before the @"
            />
            <span className="min-w-0 break-all text-[13px]" style={{ color: "var(--text-secondary)" }}>
              @{checked?.ok ? checked.domain : "youragency.com"}
            </span>
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Sender name
          </span>
          <input
            className={INPUT_CLASS}
            style={inputStyle}
            value={fromName}
            placeholder={agencyName}
            maxLength={100}
            onChange={(e) => setFromName(e.target.value)}
            disabled={busy !== null}
          />
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Leave blank to use your agency name.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Replies go to
          </span>
          <input
            className={INPUT_CLASS}
            style={inputStyle}
            type="email"
            value={replyTo}
            placeholder={supportEmail ?? "hello@youragency.com"}
            onChange={(e) => setReplyTo(e.target.value)}
            disabled={busy !== null}
          />
          <span className="text-[11px]" style={{ color: noReplies ? "var(--status-warning)" : "var(--text-muted)" }}>
            {noReplies
              ? "Optional — but with no reply address, replies go to the address above, so make sure that mailbox exists."
              : supportEmail
                ? `Optional. Leave blank to use your support email, ${supportEmail}.`
                : "Optional."}
          </span>
        </label>

        {preview && (
          <p className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            Your clients will see:{" "}
            <span className="break-words font-medium" style={{ color: "var(--text-primary)" }}>
              {preview}
            </span>
          </p>
        )}

        {error && (
          <p className="text-[12.5px]" style={{ color: "var(--status-critical)" }} role="alert">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn-lime" disabled={busy !== null}>
            {busy === "add" ? "Adding…" : "Add domain"}
          </button>
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Domains not verified within {DOMAIN_EXPIRY_DAYS} days are removed, and can be added again.
          </span>
        </div>
      </form>
    </Card>
  );
}

function StatusCard({
  domain,
  busy,
  onCheck,
}: {
  domain: DomainView;
  busy: string | null;
  onCheck: () => void;
}) {
  const s = statusLabel(domain.status);
  return (
    <Card title="Your domain">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all text-[15px] font-semibold" style={{ color: "var(--text-primary)" }}>
          {domain.domain}
        </span>
        <span className={BADGE[s.tone]}>{s.label}</span>
      </div>
      {s.hint && (
        <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {s.hint}
        </p>
      )}
      {domain.lastError && domain.status !== "verified" && (
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          Last problem: {domain.lastError}
        </p>
      )}
      {domain.expiresAt && (
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          If it isn’t verified by {day(domain.expiresAt)}, it’s removed automatically and you can add it again.
        </p>
      )}
      {domain.status !== "verified" && (
        <div>
          <button type="button" className="btn-lime" onClick={onCheck} disabled={busy !== null}>
            {busy === "check" ? "Checking…" : "Check now"}
          </button>
        </div>
      )}
    </Card>
  );
}

function RecordsCard({
  records,
  suggestedDmarc,
  domain,
}: {
  records: DnsRecord[];
  suggestedDmarc: DnsRecord | null;
  domain: string;
}) {
  const zone = dnsZoneOf(domain, records);
  return (
    <Card title="Add these DNS records">
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-[12.5px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        <li>
          Sign in where the DNS for {zone} is managed — often where you bought it, or Cloudflare.
        </li>
        <li>Add each record below. Copy the Host and Value exactly.</li>
        <li>Come back and press Check now. It can take from a few minutes to a few hours.</li>
      </ol>
      <p className="text-[11.5px]" style={{ color: "var(--text-muted)" }}>
        Each Host is written the way most DNS providers want it, without {zone} on the end — they
        add that for you. If yours asks for the full name instead, use the one shown under it.
      </p>
      <RecordList records={records} zone={zone} />
      {suggestedDmarc && (
        <>
          <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
            Recommended: {domain} has no DMARC policy yet. This one helps your emails reach inboxes
            and changes nothing else.
          </p>
          <RecordList records={[suggestedDmarc]} zone={zone} />
        </>
      )}
    </Card>
  );
}

function RecordList({ records, zone }: { records: DnsRecord[]; zone: string }) {
  if (records.length === 0) {
    return (
      <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
        The records haven’t loaded yet. Press Check now to fetch them.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2.5">
      {records.map((r, i) => (
        <RecordRow key={`${r.type}-${r.name}-${i}`} record={r} zone={zone} />
      ))}
    </ul>
  );
}

function RecordRow({ record, zone }: { record: DnsRecord; zone: string }) {
  const s = record.status ? statusLabel(record.status) : null;
  return (
    <li
      className="flex flex-col gap-2 rounded-[var(--radius-sm)] border p-3"
      style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-neutral font-mono">{record.type}</span>
        {record.record && (
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            {record.record}
          </span>
        )}
        {record.priority !== null && (
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Priority {record.priority}
          </span>
        )}
        {s && <span className={`${BADGE[s.tone]} ml-auto`}>{s.label}</span>}
      </div>
      <Field label="Host" value={record.name} />
      <p className="-mt-1 pl-14 text-[11px] break-all" style={{ color: "var(--text-muted)" }}>
        Full name: {fullHostName(record.name, zone)}
      </p>
      <Field label="Value" value={record.value} />
    </li>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be refused; the value is on screen and selectable.
    }
  }
  return (
    <div className="flex items-start gap-2">
      <span className="w-12 shrink-0 pt-0.5 text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
      <code
        className="min-w-0 flex-1 break-all text-[12px] leading-relaxed"
        style={{ color: "var(--text-primary)" }}
      >
        {value}
      </code>
      <button type="button" className={SMALL_BUTTON} onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
        <Icon name={copied ? "check" : "copy"} size={12} />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function SenderCard({
  domain,
  agencyName,
  supportEmail,
  busy,
  onSave,
}: {
  domain: DomainView;
  agencyName: string;
  supportEmail: string | null;
  busy: string | null;
  onSave: (patch: { fromLocal: string; fromName: string; replyTo: string }) => void;
}) {
  const [local, setLocal] = useState(domain.fromLocal);
  const [fromName, setFromName] = useState(domain.fromName ?? "");
  const [replyTo, setReplyTo] = useState(domain.replyTo ?? "");
  const [error, setError] = useState<string | null>(null);
  const localChecked = normalizeLocalPart(local);
  const preview = localChecked.ok
    ? shownAs(fromName.trim() || agencyName, `${localChecked.local}@${domain.domain}`)
    : null;
  const changed =
    local.trim().toLowerCase() !== domain.fromLocal ||
    fromName.trim() !== (domain.fromName ?? "") ||
    replyTo.trim() !== (domain.replyTo ?? "");

  return (
    <Card title="How your emails are signed">
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!localChecked.ok) {
            setError(localChecked.error);
            return;
          }
          setError(null);
          onSave({ fromLocal: localChecked.local, fromName: fromName.trim(), replyTo: replyTo.trim() });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Send as
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <input
              className={`${INPUT_CLASS} max-w-[200px]`}
              style={inputStyle}
              value={local}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setLocal(e.target.value);
                setError(null);
              }}
              disabled={busy !== null}
              aria-label="The part before the @"
            />
            <span className="min-w-0 break-all text-[13px]" style={{ color: "var(--text-secondary)" }}>
              @{domain.domain}
            </span>
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Sender name
          </span>
          <input
            className={INPUT_CLASS}
            style={inputStyle}
            value={fromName}
            placeholder={agencyName}
            maxLength={100}
            onChange={(e) => setFromName(e.target.value)}
            disabled={busy !== null}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            Replies go to
          </span>
          <input
            className={INPUT_CLASS}
            style={inputStyle}
            type="email"
            value={replyTo}
            placeholder={supportEmail ?? `${domain.fromLocal}@${domain.domain}`}
            onChange={(e) => setReplyTo(e.target.value)}
            disabled={busy !== null}
          />
        </label>
        {preview && (
          <p className="text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            Your clients see:{" "}
            <span className="break-words font-medium" style={{ color: "var(--text-primary)" }}>
              {preview}
            </span>
          </p>
        )}
        {error && (
          <p className="text-[12.5px]" style={{ color: "var(--status-critical)" }} role="alert">
            {error}
          </p>
        )}
        <div>
          <button type="submit" className="btn-lime" disabled={busy !== null || !changed}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Card>
  );
}

function TestCard({
  recipient,
  busy,
  onTest,
}: {
  recipient: string | null;
  busy: string | null;
  onTest: () => void;
}) {
  return (
    <Card title="Send a test email">
      <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {recipient
          ? `Sends a short test to ${recipient}, the same way your clients’ emails go, so you can see who it’s from.`
          : "Sign in with your own login to send yourself a test."}
      </p>
      <div>
        <button type="button" className={SMALL_BUTTON} onClick={onTest} disabled={busy !== null || !recipient}>
          <Icon name="fileText" size={12} />
          {busy === "test" ? "Sending…" : "Send test email"}
        </button>
      </div>
    </Card>
  );
}

function RemoveCard({
  domain,
  busy,
  onRemove,
}: {
  domain: string;
  busy: string | null;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="card flex flex-col gap-2 p-5">
      <h2 className="text-sm font-semibold" style={{ color: "var(--section-ink, var(--text-primary))" }}>
        Remove domain
      </h2>
      {confirming ? (
        <>
          <p className="text-[12.5px]" style={{ color: "var(--text-secondary)" }}>
            Remove {domain}? Your emails will go from our address under your agency’s name until you
            add a domain again. You can then delete the DNS records too.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={SMALL_BUTTON}
              style={{ color: "var(--status-critical)" }}
              onClick={() => {
                setConfirming(false);
                onRemove();
              }}
              disabled={busy !== null}
            >
              <Icon name="trash" size={12} />
              {busy === "remove" ? "Removing…" : `Remove ${domain}`}
            </button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setConfirming(false)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div>
          <button type="button" className={SMALL_BUTTON} onClick={() => setConfirming(true)} disabled={busy !== null}>
            <Icon name="trash" size={12} />
            Remove
          </button>
        </div>
      )}
    </section>
  );
}
