"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientBranding } from "@/lib/branding";
import { Icon } from "@/components/Icon";

/** Matches the setup wizard's inputs, so the two panels read as one page. */
const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;

const INPUT_CLASS = "w-full rounded-[8px] border px-3 py-2 text-[13px]";

/**
 * Staff-set per-client branding — W1.
 *
 * Deliberately staff-only. Letting the client edit their own branding is W3,
 * because it is the only part of white-label that changes the security model,
 * and shipping a cosmetic feature and a proxy carve-out for writes in the same
 * change makes both harder to review.
 *
 * The colour input echoes back what the value BECAME rather than what was typed:
 * a brand colour is clamped into a band legible on both the light and dark
 * theme, so the stored hex frequently differs from the pasted one. Showing the
 * result is what stops that being a surprise the client discovers on a report.
 */
export function BrandingSettings({
  clientId,
  slug,
  initial,
  clientName,
}: {
  clientId: string;
  slug: string;
  initial: ClientBranding;
  clientName: string;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initial.displayName ?? "");
  const [brandColor, setBrandColor] = useState(initial.brandColor ?? "");
  const [contactLine, setContactLine] = useState(initial.reportContactLine ?? "");
  const [appliesToDashboard, setAppliesToDashboard] = useState(
    initial.appliesToDashboard,
  );
  const [clientEditable, setClientEditable] = useState(initial.clientEditable);
  const [hasLogo, setHasLogo] = useState(initial.hasLogo);
  const [logoVersion, setLogoVersion] = useState(initial.logoVersion);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/branding`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim() || null,
          brandColor: brandColor.trim() || null,
          reportContactLine: contactLine.trim() || null,
          brandColorAppliesToDashboard: appliesToDashboard,
          clientEditable,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: json.error ?? "Could not save" });
        return;
      }
      // The stored colour, not the typed one.
      if (json.normalizedColor) setBrandColor(json.normalizedColor);
      setMessage({
        ok: true,
        text:
          json.normalizedColor && json.normalizedColor !== brandColor.trim()
            ? `Saved. Colour adjusted to ${json.normalizedColor} so it stays legible on both light and dark.`
            : "Saved.",
      });
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
      else form.set("logo", "");

      const res = await fetch(`/api/clients/${clientId}/branding`, {
        method: "PUT",
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: json.error ?? "Upload failed" });
        return;
      }
      setHasLogo(Boolean(file));
      // Bump locally too, so the preview below updates immediately rather than
      // showing the cached previous logo until the next full navigation.
      setLogoVersion((v) => v + 1);
      setMessage({ ok: true, text: file ? "Logo updated." : "Logo removed." });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "Could not reach the server" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Client branding
      </h2>
      <p className="mt-0.5 mb-4 text-xs" style={{ color: "var(--text-muted)" }}>
        How this client&rsquo;s dashboard and reports are signed. Set here by
        staff — the client cannot change it.
      </p>

      <div className="flex flex-col gap-4">
        <Field
          label="Display name"
          hint={`Shown instead of "${clientName}". Leave blank to use the client's name.`}
        >
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={clientName}
            maxLength={120}
            className={INPUT_CLASS}
            style={inputStyle}
          />
        </Field>

        <Field
          label="Brand colour"
          hint="A single hex. It is adjusted if needed so it stays legible on both the light and the dark theme."
        >
          <div className="flex items-center gap-2">
            <input
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              placeholder="#2aa9b8"
              maxLength={9}
              className={INPUT_CLASS}
              style={{ ...inputStyle, maxWidth: 140 }}
            />
            {brandColor.trim() && (
              <span
                aria-hidden="true"
                className="inline-block h-7 w-7 shrink-0 rounded-md border"
                style={{
                  background: brandColor.trim(),
                  borderColor: "var(--border-strong)",
                }}
              />
            )}
          </div>
        </Field>

        <label className="flex items-start gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
          <input
            type="checkbox"
            checked={appliesToDashboard}
            onChange={(e) => setAppliesToDashboard(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Use the brand colour on the dashboard too
            <span className="block" style={{ color: "var(--text-muted)" }}>
              Off means the colour appears on reports only. Worth turning off for
              a brand red or green, which sits close to the dashboard&rsquo;s own
              status colours.
            </span>
          </span>
        </label>

        {/*
          The per-client kill switch for W3.
          Sits next to the other agency-owned toggle, and is deliberately the
          only place it can be changed: the client's own endpoint parses with a
          schema that does not contain this field, so a client cannot flip it
          for themselves even while editing is enabled.
        */}
        <label className="flex items-start gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
          <input
            type="checkbox"
            checked={clientEditable}
            onChange={(e) => setClientEditable(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Let this client edit their own branding
            <span className="block" style={{ color: "var(--text-muted)" }}>
              They get a Branding page of their own for the name, colour, contact
              line and logo — never the two switches above. Off by default; every
              change either way is recorded in the audit log.
            </span>
          </span>
        </label>

        <Field
          label="Report contact line"
          hint="One line under the agency mark on a report — e.g. “Questions? hello@growthguild.us”."
        >
          <input
            value={contactLine}
            onChange={(e) => setContactLine(e.target.value)}
            maxLength={200}
            className={INPUT_CLASS}
            style={inputStyle}
          />
        </Field>

        <Field label="Logo" hint="PNG, JPEG or WebP, up to 512 KB. Shown in the dashboard header and on reports.">
          <div className="flex flex-wrap items-center gap-3">
            {hasLogo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/c/${slug}/branding/logo?v=${logoVersion}`}
                alt="Current logo"
                className="h-9 w-auto max-w-[180px] rounded border object-contain px-2 py-1"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
              />
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadLogo(f);
              }}
              className="text-xs"
              style={{ color: "var(--text-secondary)" }}
            />
            {hasLogo && (
              <button
                type="button"
                onClick={() => void uploadLogo(null)}
                disabled={busy}
                className="text-xs underline underline-offset-2"
                style={{ color: "var(--text-muted)" }}
              >
                Remove
              </button>
            )}
          </div>
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
            style={{ background: "var(--brand, var(--series-1))" }}
          >
            {busy ? "Saving…" : "Save branding"}
          </button>
          {message && (
            <span
              className="flex items-center gap-1.5 text-xs"
              style={{
                color: message.ok ? "var(--status-good)" : "var(--status-critical)",
              }}
            >
              <Icon name={message.ok ? "check" : "alert"} size={12} />
              {message.text}
            </span>
          )}
        </div>
      </div>
    </section>
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
