"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Common IANA zones for US-based agencies; free text is always allowed. */
const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Phoenix",
  "Europe/London",
  "Australia/Sydney",
];

export function AddClientButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), timezone }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not create client");
      // Straight into the wizard — a client with no connections is useless.
      router.push(`/c/${body.client.slug}/setup`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn-accent rounded-[8px] px-3 py-2 text-[13px] font-medium"
      >
        Add client
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={() => !busy && setOpen(false)}
        >
          <form
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-[14px] p-5"
            style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border-strong)",
            }}
          >
            <h2
              className="text-base font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              Add a client
            </h2>
            <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              You&rsquo;ll connect GoHighLevel and Meta on the next screen.
            </p>

            <label className="mt-4 block">
              <span
                className="text-[11px] font-medium tracking-wider uppercase"
                style={{ color: "var(--text-muted)" }}
              >
                Client name
              </span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Parfaire Medical Aesthetics"
                className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--surface-1)",
                  color: "var(--text-primary)",
                }}
              />
            </label>

            <label className="mt-3 block">
              <span
                className="text-[11px] font-medium tracking-wider uppercase"
                style={{ color: "var(--text-muted)" }}
              >
                Timezone
              </span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--surface-1)",
                  color: "var(--text-primary)",
                }}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
              <span
                className="mt-1 block text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Should match the Meta ad account&rsquo;s timezone — Meta buckets
                daily data in it.
              </span>
            </label>

            {error && (
              <p
                className="mt-3 text-xs"
                style={{ color: "var(--status-critical)" }}
              >
                {error}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-[8px] border px-3 py-2 text-[13px]"
                style={{
                  borderColor: "var(--border-strong)",
                  color: "var(--text-secondary)",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="btn-accent rounded-[8px] px-3 py-2 text-[13px] font-medium"
              >
                {busy ? "Creating…" : "Continue"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
