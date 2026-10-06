"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthShell, AuthHeading, AuthError } from "@/components/AuthShell";
import { Icon } from "@/components/Icon";

/**
 * Confirm an email address.
 *
 * 🔴 A button, not an automatic submit on mount.
 *
 * Auto-submitting would put the write back on the URL in everything but name:
 * link-preview scanners, corporate mail gateways and antivirus proxies all
 * fetch the page, React hydrates, and the address is confirmed by a machine
 * that merely followed a link. A deliberate click is the only signal that a
 * person is actually here — which is the entire thing this page verifies.
 */
export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyForm />
    </Suspense>
  );
}

function VerifyForm() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setState("busy");
    setError(null);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => null);
      /*
       * `already` comes back 200 with `ok: false` — the address IS confirmed,
       * just not by this click. Treating it as success is correct rather than
       * generous: the state the user wanted holds.
       */
      if (body?.ok || body?.reason === "already") {
        setState("done");
        return;
      }
      throw new Error(body?.error ?? "That link could not be confirmed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <AuthShell pitch="You're in. Let's set up your first client.">
        <div
          className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-lg)]"
          style={{ background: "var(--good-bg)", color: "var(--good-ink)" }}
        >
          <Icon name="check" size={20} />
        </div>
        <div className="mt-5">
          <AuthHeading title="Email confirmed">
            Your address is confirmed. Sign in to set up your first client.
          </AuthHeading>
        </div>
        <Link href="/login" className="btn-accent mt-5 w-full">
          Sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell pitch="One click and you're done.">
      <AuthHeading title="Confirm your email">
        {token
          ? "One click and you're done."
          : "This page needs the link from your confirmation email. Open that link directly rather than typing the address."}
      </AuthHeading>

      {token && (
        <>
          {error && <AuthError>{error}</AuthError>}
          <button
            type="button"
            onClick={confirm}
            disabled={state === "busy"}
            className="btn-accent mt-5 w-full"
          >
            {state === "busy" ? "Confirming…" : "Confirm my email"}
          </button>
        </>
      )}

      <p className="mt-4 text-[12px]" style={{ color: "var(--text-secondary)" }}>
        <Link href="/login" className="hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
