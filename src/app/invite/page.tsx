"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

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

  const inputStyle = {
    borderColor: "var(--border-strong)",
    background: "var(--surface-1)",
    color: "var(--text-primary)",
  } as const;

  if (doneEmail !== null) {
    const href = doneEmail
      ? `/login?email=${encodeURIComponent(doneEmail)}`
      : "/login";
    return (
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          You&rsquo;re all set
        </h1>
        <p
          className="mt-2 text-[13px] leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          Your password is saved.
          {doneEmail ? (
            <>
              {" "}Sign in as <strong>{doneEmail}</strong> with the password you
              just chose.
            </>
          ) : (
            " Sign in with the password you just chose."
          )}
        </p>
        {/*
          Not signed in automatically, matching /reset: typing it once proves
          it was not a typo, which is far cheaper to find out now than at the
          next login, when this link is already dead.
        */}
        <Link
          href={href}
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
          Some apps break long links in two. Open the link from the original
          message with a single tap, or ask whoever invited you to send it again.
        </p>
        <Link
          href="/login"
          className="mt-4 block w-full rounded-[8px] border px-3 py-2 text-center text-[13px] font-medium"
          style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-sm p-6">
      <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        Choose your password
      </h1>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        At least {MIN_PASSWORD_LENGTH} characters. A few unrelated words make a
        stronger password than a short one with symbols in it. Only you will
        know it.
      </p>

      <label className="mt-4 block">
        <span
          className="text-[11px] font-medium tracking-wider uppercase"
          style={{ color: "var(--text-muted)" }}
        >
          Password
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
        {busy ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}

export default function InvitePage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Suspense fallback={<div className="skeleton h-64 w-full max-w-sm" />}>
        <InviteForm />
      </Suspense>
    </div>
  );
}
