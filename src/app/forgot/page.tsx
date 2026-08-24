"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * Request a reset link.
 *
 * 🔴 The confirmation is identical whether or not the address has an account,
 * and it is worded so that a stranger cannot read a membership answer out of
 * it. The API is uniform for the same reason (see `api/auth/forgot`); making the
 * UI helpful here — "no account with that email" — would hand back exactly what
 * the endpoint was careful not to say.
 */
export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // Only a rate limit or an outage can fail here; a missing account cannot.
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Something went wrong. Try again shortly.");
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          Reset your password
        </h1>

        {sent ? (
          <>
            <p
              className="mt-2 text-[13px] leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              If <strong>{email}</strong> has an account, a reset link is on its
              way. It works for one hour and once only.
            </p>
            <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
              Nothing arrived? Check spam, then try again — and make sure the
              address is the one your account was created with.
            </p>
            <Link
              href="/login"
              className="btn-accent mt-4 block w-full rounded-[8px] px-3 py-2 text-center text-[13px] font-medium"
            >
              Back to sign in
            </Link>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              We&rsquo;ll email you a link to choose a new one.
            </p>

            <label className="mt-4 block">
              <span
                className="text-[11px] font-medium tracking-wider uppercase"
                style={{ color: "var(--text-muted)" }}
              >
                Email
              </span>
              <input
                type="email"
                required
                autoFocus
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--surface-1)",
                  color: "var(--text-primary)",
                }}
              />
            </label>

            {error && (
              <p className="mt-2 text-xs" style={{ color: "var(--status-critical)" }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !email}
              className="btn-accent mt-4 w-full rounded-[8px] px-3 py-2 text-[13px] font-medium"
            >
              {busy ? "Sending…" : "Email me a link"}
            </button>

            <p className="mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
              <Link href="/login" className="hover:underline">
                Back to sign in
              </Link>
              {" · "}
              Staff using the shared admin password don&rsquo;t have an account
              to reset.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
