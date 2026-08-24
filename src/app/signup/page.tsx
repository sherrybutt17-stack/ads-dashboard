"use client";

import Link from "next/link";
import { useState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

/**
 * Create an agency.
 *
 * 🔴 Four fields, and the shortest one is deliberately the agency name rather
 * than anything about clients, platforms or plans. This is the first screen a
 * stranger sees, and every field on it is a reason to leave — the product has
 * an onboarding wizard for the rest, reached once they are inside.
 *
 * Unlike `/forgot`, this screen DOES report a duplicate address. `users.email`
 * is globally unique, so the sign-up genuinely cannot proceed, and a generic
 * "check your inbox" would leave someone who mistyped waiting for an email that
 * is never coming. See the note on the route for the trade being made.
 */
export default function SignupPage() {
  const [agencyName, setAgencyName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<{ sent: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agencyName, name, email, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? "Something went wrong. Try again shortly.");
      }
      setDone({ sent: Boolean(body.verificationSent) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="card w-full max-w-sm p-6">
          <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            {done.sent ? "Check your inbox" : "Account created"}
          </h1>
          <p
            className="mt-2 text-[13px] leading-relaxed"
            style={{ color: "var(--text-secondary)" }}
          >
            {done.sent ? (
              <>
                We sent a confirmation link to <strong>{email}</strong>. Open it
                to finish setting up, then sign in. The link works for 24 hours.
              </>
            ) : (
              /*
               * This deployment cannot send email, so the address was accepted
               * as-is. Saying "check your inbox" would be a lie the user could
               * only discover by waiting.
               */
              <>
                This server has no email configured, so <strong>{email}</strong>{" "}
                was confirmed automatically. You can sign in now.
              </>
            )}
          </p>
          <Link
            href="/login"
            className="btn-accent mt-4 block w-full rounded-[8px] px-3 py-2 text-center text-[13px] font-medium"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          Create your agency
        </h1>
        <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
          Join ad spend to what your CRM actually closed.
        </p>

        <form onSubmit={submit}>
          <Field
            label="Agency name"
            value={agencyName}
            onChange={setAgencyName}
            autoFocus
            placeholder="Growth Guild"
          />
          <Field
            label="Your name"
            value={name}
            onChange={setName}
            required={false}
            placeholder="Optional"
          />
          <Field
            label="Email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
            placeholder="you@agency.com"
          />
          <Field
            label="Password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          />

          {error && (
            <p className="mt-2 text-xs" style={{ color: "var(--status-critical)" }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={
              busy ||
              !agencyName ||
              !email ||
              password.length < MIN_PASSWORD_LENGTH
            }
            className="btn-accent mt-4 w-full rounded-[8px] px-3 py-2 text-[13px] font-medium"
          >
            {busy ? "Creating…" : "Create agency"}
          </button>

          <p className="mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Already have an account?{" "}
            <Link href="/login" className="hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = true,
  autoFocus = false,
  autoComplete,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <label className="mt-4 block">
      <span
        className="text-[11px] font-medium tracking-wider uppercase"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
      <input
        type={type}
        required={required}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--surface-1)",
          color: "var(--text-primary)",
        }}
      />
    </label>
  );
}
