import Link from "next/link";
import { AppShell } from "@/components/AppShell";

/**
 * Shell for the three pages Google's OAuth verification requires to be publicly
 * reachable: an application home page, a privacy policy, and terms of service.
 *
 * They exist because the rest of this app sits behind `proxy.ts`, and a
 * reviewer who cannot load the home page cannot approve the consent screen. So
 * these are the only pages here with no session — which is exactly why they
 * carry no client data, no client names, and no links into the app beyond a
 * sign-in.
 *
 * Written as real policy rather than filler. A reviewer reads them, and so may a
 * client's lawyer; a page that obviously says nothing is a page that invites a
 * second round of review.
 */
export function PublicPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated?: string;
  children: React.ReactNode;
}) {
  return (
    <AppShell>
      {/* See the glass block in globals.css. `.glass-bar` owns the bottom
          hairline, so there is no `border-b` here. */}
      <header className="glass-bar sticky top-0 z-20">
        <div className="mx-auto flex max-w-[760px] items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link
            href="/about"
            className="flex items-center gap-2 text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-[var(--radius)] text-[13px] font-bold text-white"
              style={{
                background: "var(--g-primary)",
                boxShadow: "var(--shadow-violet)",
              }}
            >
              ◆
            </span>
            Growth Guild
          </Link>
          <Link
            href="/login"
            className="rounded-[var(--radius)] border px-3.5 py-2 text-[13px] font-medium"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[760px] flex-1 px-4 py-12 sm:px-6">
        <h1
          className="text-[30px] leading-tight font-semibold tracking-[-0.025em]"
          style={{ color: "var(--text-primary)" }}
        >
          {title}
        </h1>
        {updated && (
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Last updated {updated}
          </p>
        )}
        <div
          className="mt-6 flex flex-col gap-4 text-[14px] leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          {children}
        </div>
      </main>

      <footer
        className="mx-auto w-full max-w-[760px] border-t px-4 py-7 text-xs sm:px-6"
        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
      >
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Link href="/about" className="hover:underline">
            Home
          </Link>
          <Link href="/legal/privacy" className="hover:underline">
            Privacy policy
          </Link>
          <Link href="/legal/terms" className="hover:underline">
            Terms of service
          </Link>
        </div>
      </footer>
    </AppShell>
  );
}

/** Section heading, sized to sit under `PublicPage`'s h1. */
export function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="mt-4 text-[15px] font-semibold"
      style={{ color: "var(--section-ink, var(--text-primary))" }}
    >
      {children}
    </h2>
  );
}
