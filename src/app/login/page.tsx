"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
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
      // Only follow a same-origin path — never an absolute/protocol-relative URL
      // (`//evil.com`, `https://…`, `/\evil`), which would turn login into an
      // open-redirect phishing hop.
      const next = params.get("next");
      const safeNext = next && /^\/(?![/\\])/.test(next) ? next : null;
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
      <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
        Sign in
      </h1>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        Use the email and password you were given.
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
          autoFocus
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
        className="mt-4 w-full rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
        style={{ background: "var(--series-1)" }}
      >
        {busy ? "Checking…" : "Sign in"}
      </button>

      <p className="mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Agency staff: leave email blank to use the shared admin password.
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
