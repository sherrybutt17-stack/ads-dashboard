"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import {
  AuthShell,
  AuthHeading,
  AuthField,
  AuthError,
} from "@/components/AuthShell";

/**
 * Choose a new password, having arrived from an emailed link.
 *
 * The token is not verified until submit, deliberately. Checking it on load
 * would mean a second endpoint that answers "is this token good", which is a
 * free oracle for anyone brute-forcing signatures — and it buys nothing, since
 * a link that has expired between the page loading and the form being submitted
 * has to be handled on submit anyway.
 */
function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    password.length >= MIN_PASSWORD_LENGTH && confirm === password && Boolean(token);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Could not reset the password.");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset the password.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <span className="badge badge-good mb-4">Password changed</span>
        <AuthHeading title="Password changed">
          Sign in with your new password. That link no longer works — using it
          was what expired it.
        </AuthHeading>
        {/*
          Deliberately not signed in automatically. A link from an inbox should
          not be equivalent to the password, and typing it once confirms it was
          not a typo — which is far cheaper to discover now than at the next
          login, when the reset link is gone.
        */}
        <Link href="/login" className="btn-accent mt-5 w-full">
          Sign in
        </Link>
      </>
    );
  }

  if (!token) {
    return (
      <>
        <AuthHeading title="That link is incomplete">
          Some mail clients break long links across lines. Request a fresh one
          and open it in a single click rather than copying it.
        </AuthHeading>
        <Link href="/forgot" className="btn-accent mt-5 w-full">
          Request a new link
        </Link>
      </>
    );
  }

  return (
    <form onSubmit={submit}>
      <AuthHeading title="Choose a new password">
        At least {MIN_PASSWORD_LENGTH} characters. A passphrase of a few
        unrelated words beats a short one with symbols in it.
      </AuthHeading>

      <AuthField
        label="New password"
        type="password"
        autoFocus
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <AuthField
        label="Confirm"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />

      {/* Said while it can still be acted on, rather than after a round trip. */}
      {tooShort && (
        <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
          {MIN_PASSWORD_LENGTH - password.length} more character
          {MIN_PASSWORD_LENGTH - password.length === 1 ? "" : "s"} needed.
        </p>
      )}
      {mismatch && (
        <p className="mt-3 text-[12px]" style={{ color: "var(--status-warning)" }}>
          The two passwords don&rsquo;t match yet.
        </p>
      )}
      {error && <AuthError>{error}</AuthError>}

      <button
        type="submit"
        disabled={busy || !ready}
        className="btn-accent mt-5 w-full"
      >
        {busy ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}

export default function ResetPage() {
  return (
    <AuthShell pitch="Pick something you'll remember.">
      <Suspense fallback={<div className="skeleton h-64 w-full rounded-[var(--radius-lg)]" />}>
        <ResetForm />
      </Suspense>
    </AuthShell>
  );
}
