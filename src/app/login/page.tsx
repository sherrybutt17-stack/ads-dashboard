"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeNextPath } from "@/lib/safe-next";
import {
  AuthShell,
  AuthHeading,
  AuthField,
  AuthError,
} from "@/components/AuthShell";

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

  return (
    <form onSubmit={submit}>
      <AuthHeading title="Sign in">
        Sign in with your email and password.
      </AuthHeading>

      <AuthField
        label="Email"
        type="email"
        autoFocus={!prefilled}
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />

      <AuthField
        label="Password"
        type="password"
        // Straight to the password when the address came pre-filled.
        autoFocus={Boolean(prefilled)}
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
    <AuthShell>
      <Suspense fallback={<div className="skeleton h-64 w-full rounded-[var(--radius-lg)]" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
