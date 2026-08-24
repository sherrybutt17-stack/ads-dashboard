"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgencySettings } from "@/lib/branding-store";
import { Icon } from "@/components/Icon";

/**
 * The agency's own mark, as it appears on every report it sends.
 *
 * The counterpart to `ClientBrandingForm`: that one is a client's brand on
 * their dashboard, this one is the agency's signature on the document. They
 * stay separate components for the same reason those two do — different
 * audience, different vocabulary, and a shared component with conditionals
 * drifts toward showing each of them the other's controls.
 */

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;
const INPUT_CLASS = "w-full rounded-[8px] border px-3 py-2 text-[13px]";

type MarkMode = AgencySettings["agencyMarkMode"];

const MARK_MODES: Array<{ value: MarkMode; label: string; hint: string }> = [
  {
    value: "prepared_by",
    label: "Prepared by",
    hint: "Signs the work without competing with the client's own brand on their report.",
  },
  { value: "full", label: "Name only", hint: "Your name, without the words “Prepared by”." },
  { value: "none", label: "Unsigned", hint: "No agency mark on the report at all." },
];

export function AgencySettingsForm({
  tenantName,
  initial,
}: {
  /**
   * The agency's own name, from `agencies.name`.
   *
   * Shown as the placeholder for the override field so "leave blank" reads as a
   * choice with a visible result, rather than as an empty box.
   */
  tenantName: string;
  initial: AgencySettings;
}) {
  const router = useRouter();
  /*
   * 🔴 Seeded from the OVERRIDE, not from the resolved name.
   *
   * `initial.agencyName` is already resolved — it falls back to the tenant's
   * name — so pre-filling with it would put "Bright Lane Marketing" in the box,
   * and the next save would write that string into the override column. The
   * agency would then have silently frozen a copy of its own name by touching
   * nothing, and a later rename would stop reaching its reports.
   */
  const [name, setName] = useState(initial.agencyNameOverride ?? "");
  const [markMode, setMarkMode] = useState<MarkMode>(initial.agencyMarkMode);
  const [supportEmail, setSupportEmail] = useState(initial.supportEmail ?? "");
  const [hasLogo, setHasLogo] = useState(initial.hasLogo);
  const [logoVersion, setLogoVersion] = useState(initial.logoVersion);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const printed = name.trim() || tenantName;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/agency/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Sent as "" rather than omitted: empty means "clear the override and
          // go back to following the tenant name", which is a real instruction.
          agencyName: name.trim(),
          agencyMarkMode: markMode,
          supportEmail: supportEmail.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: json.error ?? "Could not save" });
        return;
      }
      setMessage({ ok: true, text: "Saved." });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "Could not reach the server" });
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(file: File | null) {
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      if (file) form.set("logo", file);
      const res = await fetch("/api/agency/settings", { method: "PUT", body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: json.error ?? "Could not upload" });
        return;
      }
      setHasLogo(Boolean(json.logo));
      // Bumped so the cached asset URL changes; otherwise a replaced logo keeps
      // serving from cache and the upload looks like it silently failed.
      setLogoVersion((v) => v + 1);
      setMessage({ ok: true, text: json.logo ? "Logo updated." : "Logo removed." });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "Could not reach the server" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="card flex flex-col gap-5 p-5">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Your mark
        </h2>
        <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
          Printed in the footer of every report, PDF and share link you send.
        </p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          Trading name
        </span>
        <input
          className={INPUT_CLASS}
          style={inputStyle}
          value={name}
          placeholder={tenantName}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Leave blank to use your account name. Reports will read{" "}
          <strong style={{ color: "var(--text-secondary)" }}>{printed}</strong>.
        </span>
      </label>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          How it appears
        </legend>
        <div className="flex flex-col gap-1.5">
          {MARK_MODES.map((m) => (
            <label key={m.value} className="flex items-start gap-2 text-[13px]">
              <input
                type="radio"
                name="markMode"
                className="mt-1"
                checked={markMode === m.value}
                onChange={() => setMarkMode(m.value)}
                disabled={busy}
              />
              <span>
                <span style={{ color: "var(--text-primary)" }}>{m.label}</span>
                <span className="block text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {m.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          Support email
        </span>
        <input
          className={INPUT_CLASS}
          style={inputStyle}
          type="email"
          value={supportEmail}
          placeholder="hello@youragency.com"
          onChange={(e) => setSupportEmail(e.target.value)}
          disabled={busy}
        />
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          Where a client should reply. Optional.
        </span>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          Wordmark
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {hasLogo && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={`/api/agency/logo?v=${logoVersion}`}
              alt="Your wordmark"
              className="h-9 w-auto max-w-[180px] rounded border object-contain px-2 py-1"
              style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
            />
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="text-[12px]"
            style={{ color: "var(--text-secondary)" }}
            onChange={(e) => uploadLogo(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
          {hasLogo && (
            <button
              type="button"
              className="rounded-[8px] border px-2.5 py-1 text-[12px]"
              style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
              onClick={() => uploadLogo(null)}
              disabled={busy}
            >
              Remove
            </button>
          )}
        </div>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          PNG, JPEG or WebP, up to 512 KB. A wide wordmark reads better than a
          square icon at footer size.
        </span>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded-[8px] px-3 py-2 text-[13px] font-medium"
          style={{ background: "var(--series-1)", color: "#fff", opacity: busy ? 0.6 : 1 }}
          onClick={save}
          disabled={busy}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {message && (
          <span
            className="inline-flex items-center gap-1 text-[12px]"
            style={{
              color: message.ok ? "var(--status-good)" : "var(--status-critical)",
            }}
          >
            <Icon name={message.ok ? "check" : "alert"} size={12} />
            {message.text}
          </span>
        )}
      </div>
    </section>
  );
}
