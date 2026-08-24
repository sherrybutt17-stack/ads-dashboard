"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

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

  const inputStyle = {
    borderColor: "var(--border-strong)",
    background: "var(--surface-1)",
    color: "var(--text-primary)",
  } as const;

  if (done) {
    return (
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          Password changed
        </h1>
        <p
          className="mt-2 text-[13px] leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          Sign in with your new password. That link no longer works — using it
          was what expired it.
        </p>
        {/*
          Deliberately not signed in automatically. A link from an inbox should
          not be equivalent to the password, and typing it once confirms it was
          not a typo — which is far cheaper to discover now than at the next
          login, when the reset link is gone.
        */}
        <Link
          href="/login"
          className="btn-accent mt-4 block w-full rounded-[8px] px-3 py-2 text-center text-[13px] font-medium"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          That link is incomplete
        </h1>
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          Some mail clients break long links across lines. Request a fresh one
          and open it in a single click rather than copying it.
        </p>
        <Link
          href="/forgot"
          className="btn-accent mt-4 block w-full rounded-[8px] px-3 py-2 text-center text-[13px] font-medium"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-sm p-6">
      <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        Choose a new password
      </h1>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        At least {MIN_PASSWORD_LENGTH} characters. A passphrase of a few
        unrelated words beats a short one with symbols in it.
      </p>

      <label className="mt-4 block">
        <span
          className="text-[11px] font-medium tracking-wider uppercase"
          style={{ color: "var(--text-muted)" }}
        >
          New password
        </span>
        <input
          type="password"
          autoFocus
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
          style={inputStyle}
        />
      </label>

      <label className="mt-3 block">
        <span
          className="text-[11px] font-medium tracking-wider uppercase"
          style={{ color: "var(--text-muted)" }}
        >
          Confirm
        </span>
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
          style={inputStyle}
        />
      </label>

      {/* Said while it can still be acted on, rather than after a round trip. */}
      {tooShort && (
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
          {MIN_PASSWORD_LENGTH - password.length} more character
          {MIN_PASSWORD_LENGTH - password.length === 1 ? "" : "s"} needed.
        </p>
      )}
      {mismatch && (
        <p className="mt-2 text-xs" style={{ color: "var(--status-warning)" }}>
          The two passwords don&rsquo;t match yet.
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs" style={{ color: "var(--status-critical)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !ready}
        className="btn-accent mt-4 w-full rounded-[8px] px-3 py-2 text-[13px] font-medium"
      >
        {busy ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}

export default function ResetPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Suspense fallback={<div className="skeleton h-64 w-full max-w-sm" />}>
        <ResetForm />
      </Suspense>
    </div>
  );
}
