/**
 * The heading at the top of an agency-side page.
 *
 * ── Why this is not a sticky bar any more ─────────────────────────────
 *
 * Every one of these pages carried a sticky, blurred header, and each one had
 * drifted into its own shape — different max-widths, a back arrow on two of
 * them, a theme toggle on all four and a sign-out on one. The bar was sticky
 * because it held the navigation, and the navigation has moved to the sidebar.
 * What is left is a heading, and a heading has no reason to follow the reader
 * down the page: it costs vertical space on a laptop and says nothing new after
 * the first screen.
 *
 * The back arrow went with it. It pointed at "Clients" from three pages, which
 * is one of the four items now permanently on screen to the left, marked with
 * the lime pill when you are on it.
 */
export function PageTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  /** One line under the heading — a count, a window, a tenant name. */
  subtitle?: string | null;
  /** A control that belongs to the page rather than to the navigation. */
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1
          className="text-[26px] leading-tight font-semibold tracking-[-0.02em] sm:text-[30px]"
          style={{ color: "var(--text-primary)" }}
        >
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
            {subtitle}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
