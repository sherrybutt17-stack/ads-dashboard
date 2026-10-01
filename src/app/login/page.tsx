"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeNextPath } from "@/lib/safe-next";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Pre-filled after accepting an invite or a password link, which knows it.
  const prefilled = params.get("email") ?? "";
  const [email, setEmail] = useState(prefilled);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email || undefined, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? "Sign in failed");
      }
      // Only follow a same-origin path — never somewhere else, which would turn
      // sign-in into an open-redirect phishing hop. See `safeNextPath` for why
      // a pattern on the string was not enough.
      const safeNext = safeNextPath(params.get("next"), window.location.origin);
      router.push(safeNext || body?.redirect || "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setBusy(false);
    }
  }

  const inputStyle = {
    borderColor: "var(--border-strong)",
    background: "var(--surface-1)",
    color: "var(--text-primary)",
  } as const;

  return (
    <form onSubmit={submit} className="card w-full max-w-sm p-6">
      <div className="mb-5 flex items-center gap-3">
        <div
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] text-[17px] font-bold text-white"
          style={{
            background: "linear-gradient(135deg, #4a97ee 0%, #1c5cab 100%)",
            boxShadow:
              "0 4px 14px -4px rgba(28, 92, 171, 0.6), inset 0 1px 0 rgba(255,255,255,0.28)",
          }}
        >
          ◆
        </div>
        <div className="leading-tight">
          <div
            className="text-[15px] font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            Ads + CRM
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Live pipeline reporting
          </div>
        </div>
      </div>

      <h1
        className="text-base font-semibold"
        style={{ color: "var(--text-primary)" }}
      >
        Sign in
      </h1>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        Sign in with your email and password.
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
          autoFocus={!prefilled}
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
          style={inputStyle}
        />
      </label>

      <label className="mt-3 block">
        <span
          className="text-[11px] font-medium tracking-wider uppercase"
          style={{ color: "var(--text-muted)" }}
        >
          Password
        </span>
        <input
          type="password"
          // Straight to the password when the address came pre-filled.
          autoFocus={Boolean(prefilled)}
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
          style={inputStyle}
        />
      </label>

      {error && (
        <p className="mt-2 text-xs" style={{ color: "var(--status-critical)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !password}
        className="btn-accent mt-4 w-full rounded-[8px] px-3 py-2 text-[13px] font-medium"
      >
        {busy ? "Checking…" : "Sign in"}
      </button>

      <p className="mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
        <Link href="/forgot" className="hover:underline">
          Forgot your password?
        </Link>
      </p>
      <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
        <Link href="/signup" className="hover:underline">
          Create an agency
        </Link>
        {/*
          No hint about the shared admin password here. This page is public —
          it is where Google's OAuth reviewer lands from every "Sign in" link —
          and advertising that a shared credential exists, and how to use it,
          is a note for staff, not for every visitor. The blank-email sign-in
          itself is unchanged; SETUP.md documents it.
        */}
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Suspense fallback={<div className="skeleton h-64 w-full max-w-sm" />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
