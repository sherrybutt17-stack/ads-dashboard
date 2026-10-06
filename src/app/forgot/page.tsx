"use client";

import Link from "next/link";
import { useState } from "react";
import {
  AuthShell,
  AuthHeading,
  AuthField,
  AuthError,
} from "@/components/AuthShell";

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

  if (sent) {
    return (
      <AuthShell pitch="Check your inbox.">
        <span className="badge badge-accent mb-4">Link sent</span>
        <AuthHeading title="Reset your password">
          If <strong>{email}</strong> has an account, a reset link is on its way.
          It works for one hour and once only.
        </AuthHeading>
        <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Nothing arrived? Check spam, then try again — and make sure the address
          is the one your account was created with.
        </p>
        <Link href="/login" className="btn-accent mt-5 w-full">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell pitch="Everyone forgets one eventually.">
      <form onSubmit={submit}>
        <AuthHeading title="Reset your password">
          We&rsquo;ll email you a link to choose a new one.
        </AuthHeading>

        <AuthField
          label="Email"
          type="email"
          required
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />

        {error && <AuthError>{error}</AuthError>}

        <button
          type="submit"
          disabled={busy || !email}
          className="btn-accent mt-5 w-full"
        >
          {busy ? "Sending…" : "Email me a link"}
        </button>

        <p className="mt-4 text-[12px]" style={{ color: "var(--text-secondary)" }}>
          <Link href="/login" className="hover:underline">
            Back to sign in
          </Link>
        </p>
        <p
          className="mt-3 border-t pt-3 text-[11px] leading-relaxed"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          Staff using the shared admin password don&rsquo;t have an account to
          reset.
        </p>
      </form>
    </AuthShell>
  );
}
