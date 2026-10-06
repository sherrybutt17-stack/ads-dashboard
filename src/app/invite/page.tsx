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
 * Accept an invite: choose the password for a login someone made for you.
 *
 * Also where an operator-sent "set a new password" link lands — the token is
 * the same kind, and so is the job.
 *
 * Like `/reset`, the token is not checked until submit. A load-time check would
 * be a second endpoint answering "is this token good" and buys nothing: a link
 * that expires between load and submit has to be handled on submit anyway.
 */
function InviteForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [doneEmail, setDoneEmail] = useState<string | null>(null);
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
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Could not set the password.");
      setDoneEmail(typeof body?.email === "string" ? body.email : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set the password.");
    } finally {
      setBusy(false);
    }
  }

  if (doneEmail !== null) {
    const href = doneEmail
      ? `/login?email=${encodeURIComponent(doneEmail)}`
      : "/login";
    return (
      <>
        <span className="badge badge-good mb-4">Password saved</span>
        <AuthHeading title="You’re all set">
          {doneEmail ? (
            <>
              Sign in as <strong>{doneEmail}</strong> with the password you just
              chose.
            </>
          ) : (
            "Sign in with the password you just chose."
          )}
        </AuthHeading>
        {/*
          Not signed in automatically, matching /reset: typing it once proves
          it was not a typo, which is far cheaper to find out now than at the
          next login, when this link is already dead.
        */}
        <Link href={href} className="btn-accent mt-5 w-full">
          Sign in
        </Link>
      </>
    );
  }

  if (!token) {
    return (
      <>
        <AuthHeading title="That link is incomplete">
          Some apps break long links in two. Open the link from the original
          message with a single tap, or ask whoever invited you to send it again.
        </AuthHeading>
        <Link href="/login" className="btn-ghost mt-5 w-full">
          Go to sign in
        </Link>
      </>
    );
  }

  return (
    <form onSubmit={submit}>
      <AuthHeading title="Choose your password">
        At least {MIN_PASSWORD_LENGTH} characters. A few unrelated words make a
        stronger password than a short one with symbols in it. Only you will
        know it.
      </AuthHeading>

      <AuthField
        label="Password"
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
        {busy ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}

export default function InvitePage() {
  return (
    <AuthShell pitch="Your login, your password.">
      <Suspense fallback={<div className="skeleton h-64 w-full rounded-[var(--radius-lg)]" />}>
        <InviteForm />
      </Suspense>
    </AuthShell>
  );
}
