"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientBranding } from "@/lib/branding";
import { Icon } from "@/components/Icon";

/**
 * A client editing their own brand — W3.
 *
 * Same fields as the staff panel minus the two agency switches, and pointed at
 * the slug-scoped endpoint rather than the id-scoped one. It is a separate
 * component rather than a `mode` prop on `BrandingSettings` because the two have
 * different audiences: this one explains what the settings DO to someone who has
 * never seen the dashboard's internals, and never mentions a field they cannot
 * change. A shared component with conditionals would keep drifting toward
 * showing the client controls they will only be refused.
 */

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;
const INPUT_CLASS = "w-full rounded-[8px] border px-3 py-2 text-[13px]";

export function ClientBrandingForm({
  slug,
  clientName,
  initial,
  readOnly,
}: {
  slug: string;
  clientName: string;
  initial: ClientBranding;
  /**
   * The agency has not enabled editing. Shown rather than hidden: a client who
   * cannot find the setting assumes the product lacks it, and asks for something
   * that already exists.
   */
  readOnly: boolean;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initial.displayName ?? "");
  const [brandColor, setBrandColor] = useState(initial.brandColor ?? "");
  const [contactLine, setContactLine] = useState(initial.reportContactLine ?? "");
  const [hasLogo, setHasLogo] = useState(initial.hasLogo);
  const [logoVersion, setLogoVersion] = useState(initial.logoVersion);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const endpoint = `/api/c/${slug}/branding`;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim() || null,
          brandColor: brandColor.trim() || null,
          reportContactLine: contactLine.trim() || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: json.error ?? "Could not save" });
        return;
      }
      const typed = brandColor.trim();
      if (json.normalizedColor) setBrandColor(json.normalizedColor);
      setMessage({
        ok: true,
        text:
          json.normalizedColor && json.normalizedColor !== typed
            ? `Saved. Your colour was adjusted to ${json.normalizedColor} so it stays readable on both the light and dark view.`
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
      form.set("logo", file ?? "");
      const res = await fetch(endpoint, { method: "PUT", body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: json.error ?? "Upload failed" });
        return;
      }
      setHasLogo(Boolean(file));
      // Bumped locally too, so the preview updates immediately instead of
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

  const disabled = busy || readOnly;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Your branding
      </h2>
      <p className="mt-0.5 mb-4 text-xs" style={{ color: "var(--text-muted)" }}>
        How your dashboard and your reports are signed. Anything you change here
        applies to every report immediately, including ones you have already
        shared.
      </p>

      {readOnly && (
        <div
          className="mb-4 flex items-start gap-2 rounded-[8px] border p-3 text-xs"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-2)",
            color: "var(--text-secondary)",
          }}
        >
          <Icon name="alert" size={13} className="mt-[1px] shrink-0" />
          <span>
            Your agency currently manages these settings. Ask them to enable
            editing if you would like to change them yourself.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Field
          label="Display name"
          hint={`Shown instead of “${clientName}”. Leave blank to use it as-is.`}
        >
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={clientName}
            maxLength={120}
            disabled={disabled}
            className={INPUT_CLASS}
            style={inputStyle}
          />
        </Field>

        <Field
          label="Brand colour"
          hint="One hex value. It may be adjusted slightly so it stays readable on both the light and the dark view."
        >
          <div className="flex items-center gap-2">
            <input
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              placeholder="#2aa9b8"
              maxLength={9}
              disabled={disabled}
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

        <Field
          label="Contact line on reports"
          hint="One line at the foot of every report — e.g. “Questions? hello@yourclinic.com”."
        >
          <input
            value={contactLine}
            onChange={(e) => setContactLine(e.target.value)}
            maxLength={200}
            disabled={disabled}
            className={INPUT_CLASS}
            style={inputStyle}
          />
        </Field>

        <Field label="Logo" hint="PNG, JPEG or WebP, up to 512 KB. Appears in your header and on every report.">
          <div className="flex flex-wrap items-center gap-3">
            {hasLogo && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={`/api/c/${slug}/branding/logo?v=${logoVersion}`}
                alt="Your current logo"
                className="h-9 w-auto max-w-[180px] rounded border object-contain px-2 py-1"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
              />
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={disabled}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadLogo(f);
              }}
              className="text-xs"
              style={{ color: "var(--text-secondary)" }}
            />
            {hasLogo && !readOnly && (
              <button
                type="button"
                onClick={() => void uploadLogo(null)}
                disabled={disabled}
                className="text-xs underline underline-offset-2"
                style={{ color: "var(--text-muted)" }}
              >
                Remove
              </button>
            )}
          </div>
        </Field>

        {!readOnly && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={disabled}
              className="rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
              style={{ background: "var(--brand, var(--series-1))" }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            {message && (
              <span
                className="flex items-start gap-1.5 text-xs"
                style={{
                  color: message.ok ? "var(--status-good)" : "var(--status-critical)",
                }}
              >
                <Icon
                  name={message.ok ? "check" : "alert"}
                  size={12}
                  className="mt-[2px] shrink-0"
                />
                {message.text}
              </span>
            )}
          </div>
        )}
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
