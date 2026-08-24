"use client";

import { useEffect } from "react";
import Link from "next/link";

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
    <div className="mx-auto flex min-h-full max-w-[560px] flex-col justify-center px-4 py-16">
      <div className="card p-7">
        <div
          className="mb-3 inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{
            background: "color-mix(in srgb, var(--status-critical) 16%, transparent)",
            color: "var(--status-critical)",
          }}
        >
          <span aria-hidden>●</span> Could not load
        </div>

        <h1
          className="text-lg font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          This dashboard didn&rsquo;t load
        </h1>

        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          Something failed while fetching the numbers. This is a loading problem,
          not a reporting one — your data is intact and nothing has been lost.
        </p>

        {error.digest && (
          <p className="mt-3 text-xs tnum" style={{ color: "var(--text-muted)" }}>
            Reference: {error.digest}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2.5">
          <button type="button" onClick={reset} className="btn-accent">
            Try again
          </button>
          <Link
            href="/"
            className="rounded-[9px] border px-3 py-2 text-sm font-medium"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            All clients
          </Link>
        </div>
      </div>
    </div>
  );
}
