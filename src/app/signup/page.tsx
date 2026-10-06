"use client";

import Link from "next/link";
import { useState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import {
  AuthShell,
  AuthHeading,
  AuthField,
  AuthError,
} from "@/components/AuthShell";

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
      <AuthShell pitch="Welcome aboard.">
        <span className="badge badge-accent mb-4">
          {done.sent ? "Confirmation sent" : "Ready"}
        </span>
        <AuthHeading title={done.sent ? "Check your inbox" : "Account created"}>
          {done.sent ? (
            <>
              We sent a confirmation link to <strong>{email}</strong>. Open it to
              finish setting up, then sign in. The link works for 24 hours.
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
        </AuthHeading>
        <Link href="/login" className="btn-accent mt-5 w-full">
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell pitch="Join ad spend to what your CRM actually closed.">
      <form onSubmit={submit}>
        <AuthHeading title="Create your agency">
          Four fields. The rest is set up once you&rsquo;re inside.
        </AuthHeading>

        <AuthField
          label="Agency name"
          required
          autoFocus
          value={agencyName}
          onChange={(e) => setAgencyName(e.target.value)}
          placeholder="Growth Guild"
        />
        <AuthField
          label="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Optional"
        />
        <AuthField
          label="Email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@agency.com"
        />
        <AuthField
          label="Password"
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
        />

        {error && <AuthError>{error}</AuthError>}

        <button
          type="submit"
          disabled={
            busy || !agencyName || !email || password.length < MIN_PASSWORD_LENGTH
          }
          className="btn-accent mt-5 w-full"
        >
          {busy ? "Creating…" : "Create agency"}
        </button>

        <p className="mt-4 text-[12px]" style={{ color: "var(--text-secondary)" }}>
          Already have an account?{" "}
          <Link href="/login" className="hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
