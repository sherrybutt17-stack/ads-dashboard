"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

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

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
          {state === "done" ? "Email confirmed" : "Confirm your email"}
        </h1>

        {state === "done" ? (
          <>
            <p
              className="mt-2 text-[13px] leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              Your address is confirmed. Sign in to set up your first client.
            </p>
            <Link
              href="/login"
              className="btn-accent mt-4 block w-full rounded-[8px] px-3 py-2 text-center text-[13px] font-medium"
            >
              Sign in
            </Link>
          </>
        ) : !token ? (
          <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            This page needs the link from your confirmation email. Open that link
            directly rather than typing the address.
          </p>
        ) : (
          <>
            <p
              className="mt-2 text-[13px] leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              One click and you&rsquo;re done.
            </p>

            {error && (
              <p className="mt-2 text-xs" style={{ color: "var(--status-critical)" }}>
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={confirm}
              disabled={state === "busy"}
              className="btn-accent mt-4 w-full rounded-[8px] px-3 py-2 text-[13px] font-medium"
            >
              {state === "busy" ? "Confirming…" : "Confirm my email"}
            </button>
          </>
        )}

        <p className="mt-3 text-[11px]" style={{ color: "var(--text-muted)" }}>
          <Link href="/login" className="hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
