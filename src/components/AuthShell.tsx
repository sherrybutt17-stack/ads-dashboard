import Link from "next/link";

/**
 * The frame every signed-out page sits in: login, signup, forgot, reset, verify.
 *
 * Before this, each of those pages centred its own `.card` on a bare grey
 * background and repeated its own markup for the wordmark, so the five drifted
 * apart — different paddings, two different lock-ups, one of them missing the
 * brand entirely. They are the first screen anyone sees, and the first screen
 * disagreeing with itself is the cheapest possible way to look unfinished.
 *
 * The violet panel is the signed-out counterpart to the app frame: it does the
 * job the pill rail does once you're inside, which is to say "this is the
 * product" without spending a single word of the form's copy on it. It hides
 * below `lg` — on a phone the form is the whole screen and a decorative half
 * would just push it below the fold.
 */
export function AuthShell({
  children,
  pitch,
}: {
  children: React.ReactNode;
  /** The line under the wordmark on the violet panel. Defaults to the product's. */
  pitch?: string;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col lg:p-5">
      <div className="app-frame grid flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <aside
          className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex"
          style={{ background: "var(--g-hero)", color: "#ffffff" }}
        >
          {/*
           * Two soft lights, so the gradient reads as a surface, not a fill.
           * Capped at 0.12: white text sits on whatever these composite to, and
           * the stronger light was 0.14, which put the panel's lightest stop at
           * 4.48:1 — under AA by two hundredths. See gradient-ink.test.ts.
           */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-24 -right-16 h-72 w-72 rounded-full"
            style={{ background: "rgba(255,255,255,0.12)", filter: "blur(40px)" }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-28 -left-20 h-80 w-80 rounded-full"
            style={{ background: "rgba(255,255,255,0.10)", filter: "blur(50px)" }}
          />

          <div className="relative flex items-center gap-3">
            <div
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-[17px] font-bold"
              style={{
                // 0.12, not 0.16: over the panel's lightest stop a 0.16 white
                // put the mark at 4.30:1. The glyph is aria-hidden and a
                // logotype, so AA does not strictly reach it — but the tile is
                // the only thing on the panel that needed an exemption to pass,
                // and four hundredths of alpha is cheaper than the argument.
                background: "rgba(255,255,255,0.12)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3)",
              }}
            >
              ◆
            </div>
            <div className="text-[15px] font-semibold">Ads + CRM</div>
          </div>

          <div className="relative">
            <p className="max-w-[24ch] text-[30px] leading-[1.15] font-semibold tracking-[-0.025em]">
              {pitch ?? "Ad spend and pipeline, on the same page."}
            </p>
            <p
              className="mt-4 max-w-[38ch] text-[13px] leading-relaxed"
            >
              Every client dashboard reads leads, calls and booked revenue back
              against the spend that produced them — so a slow month is a number
              you can point at, not a feeling.
            </p>
          </div>

          <p
            className="relative text-[11px]"
          >
            <Link href="/about" className="hover:underline">
              About
            </Link>
            {" · "}
            <Link href="/legal/privacy" className="hover:underline">
              Privacy
            </Link>
            {" · "}
            <Link href="/legal/terms" className="hover:underline">
              Terms
            </Link>
          </p>
        </aside>

        <main className="flex flex-col justify-center px-4 py-12 sm:px-10 lg:px-14">
          <div className="mx-auto w-full max-w-[380px]">
            {/* The lock-up the violet panel carries at `lg`, for narrow screens. */}
            <div className="mb-7 flex items-center gap-3 lg:hidden">
              <div
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-[17px] font-bold text-white"
                style={{
                  background: "var(--g-primary)",
                  boxShadow: "var(--shadow-violet)",
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
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/** The heading pair every auth page opens with, so the type ramp stays put. */
export function AuthHeading({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <h1
        className="text-[22px] leading-tight font-semibold tracking-[-0.02em]"
        style={{ color: "var(--text-primary)" }}
      >
        {title}
      </h1>
      {children && (
        <p
          className="mt-2 text-[13px] leading-relaxed"
          style={{ color: "var(--text-secondary)" }}
        >
          {children}
        </p>
      )}
    </>
  );
}

/** A labelled input. The label is the eyebrow; the input is the `.field`. */
export function AuthField({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mt-4 block">
      <span className="eyebrow">{label}</span>
      <input {...input} className="field mt-1.5" />
      {hint && (
        <span
          className="mt-1.5 block text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

/** The inline form error. Red type on the page, not a badge — it isn't a status. */
export function AuthError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-3 text-[12px] leading-relaxed"
      style={{ color: "var(--status-critical)" }}
    >
      {children}
    </p>
  );
}
