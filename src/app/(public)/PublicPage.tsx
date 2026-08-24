import Link from "next/link";

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
    <div className="min-h-full">
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link
            href="/about"
            className="flex items-center gap-2 text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-[9px] text-[13px] font-bold text-white"
              style={{
                background:
                  "linear-gradient(135deg, var(--series-1) 0%, #0d1b30 100%)",
              }}
            >
              ◆
            </span>
            Growth Guild
          </Link>
          <Link
            href="/login"
            className="rounded-[8px] border px-3 py-1.5 text-[13px] font-medium"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[720px] px-4 py-10 sm:px-6">
        <h1
          className="text-[26px] leading-tight font-semibold"
          style={{ color: "var(--text-primary)", letterSpacing: "-0.02em" }}
        >
          {title}
        </h1>
        {updated && (
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
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
        className="mx-auto max-w-[720px] border-t px-4 py-6 text-xs sm:px-6"
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
    </div>
  );
}

/** Section heading, sized to sit under `PublicPage`'s h1. */
export function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="mt-4 text-[15px] font-semibold"
      style={{ color: "var(--text-primary)" }}
    >
      {children}
    </h2>
  );
}
