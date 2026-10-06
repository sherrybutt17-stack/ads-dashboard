"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AuthShell,
  AuthHeading,
  AuthField,
  AuthError,
} from "@/components/AuthShell";

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

  return (
    <form onSubmit={submit}>
      <AuthHeading title="Sign in">
        Use the email and password you were given.
      </AuthHeading>

      <AuthField
        label="Email"
        type="email"
        autoFocus
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />

      <AuthField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      {error && <AuthError>{error}</AuthError>}

      <button
        type="submit"
        disabled={busy || !password}
        className="btn-accent mt-5 w-full"
      >
        {busy ? "Checking…" : "Sign in"}
      </button>

      <p
        className="mt-4 text-[12px]"
        style={{ color: "var(--text-secondary)" }}
      >
        <Link href="/forgot" className="hover:underline">
          Forgot your password?
        </Link>
        {" · "}
        <Link href="/signup" className="hover:underline">
          Create an agency
        </Link>
      </p>
      <p
        className="mt-3 border-t pt-3 text-[11px] leading-relaxed"
        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
      >
        Agency staff: leave email blank to use the shared admin password. It is
        accepted only while this deployment has no user accounts, or when it is
        bound to a named one.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthShell>
      <Suspense fallback={<div className="skeleton h-64 w-full rounded-[var(--radius-lg)]" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
