"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";

/**
 * Error boundary for a client dashboard.
 *
 * Without one, a database blip or an unreachable ad platform dropped the user on
 * Next's unstyled default error page — which looks like the product broke rather
 * than like a query failed, and offers nothing to do about it.
 *
 * The copy distinguishes what this product always distinguishes: this screen
 * means "we could not load the numbers", NOT "the numbers are zero". Conflating
 * those is the failure the whole dashboard exists to prevent, and an error page
 * is exactly where a reader is most likely to assume the worse of the two.
 *
 * It sits on the app frame like every other page. A boundary that renders
 * unframed reads as "you have been thrown out of the application"; inside the
 * frame it reads as "this panel failed", which is the truth.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side causes are redacted to a digest in production, so log what we
    // have — otherwise a recurring failure leaves no trace anywhere.
    console.error("dashboard render failed", error);
  }, [error]);

  return (
    <AppShell>
      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center px-4 py-16 sm:px-6">
        <div
          className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-lg)]"
          style={{ background: "var(--bad-bg)", color: "var(--bad-ink)" }}
        >
          <Icon name="alert" size={20} />
        </div>

        <span className="badge badge-bad mt-5 w-fit">Could not load</span>

        <h1
          className="mt-3 text-[26px] leading-tight font-semibold tracking-[-0.02em]"
          style={{ color: "var(--text-primary)" }}
        >
          This dashboard didn&rsquo;t load
        </h1>

        <p
          className="mt-2.5 max-w-[46ch] text-sm leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          Something failed while fetching the numbers. This is a loading problem,
          not a reporting one — your data is intact and nothing has been lost.
        </p>

        {error.digest && (
          <p className="tnum mt-4 text-xs" style={{ color: "var(--text-muted)" }}>
            Reference: {error.digest}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-2.5">
          <button type="button" onClick={reset} className="btn-accent">
            Try again
          </button>
          <Link
            href="/"
            className="rounded-[var(--radius)] border px-3.5 py-2 text-sm font-medium"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            All clients
          </Link>
        </div>
      </main>
    </AppShell>
  );
}
