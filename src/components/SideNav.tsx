"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/Icon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SignOut } from "@/components/SignOut";

/**
 * The app's primary navigation — a labelled sidebar.
 *
 * ── What this replaces, and why ───────────────────────────────────────
 *
 * Every signed-in page used to carry its destinations as a row of buttons in
 * the header: Users, Audit log, Settings, Add client, Sign out, theme. That
 * row worked at desktop width and wrapped into two ragged lines below it, but
 * the wrapping was the smaller problem. The real one is that a row of buttons
 * cannot show you where you ARE — every destination looked like every other,
 * and the page you were currently on simply was not in the list. You could
 * read the whole header and still not know which of the four pages you had
 * open.
 *
 * A sidebar answers that as a side effect of its shape: the current page is
 * the lime pill, and it is the only lime thing on screen.
 *
 * ── Labels, unlike the rail this also replaced ────────────────────────
 *
 * The client dashboard carried a second navigation: a 72px near-black rail of
 * icon-only destinations, paying for the missing words with tooltips on hover
 * AND focus. That trade is affordable when the list is five fixed items — but
 * the list here mixes destinations of different kinds (a client list, an audit
 * log, settings) where a glyph is a genuinely poor name, and the same page now
 * reaches both sets from one column. So the labels are permanent and the icons
 * are the decoration rather than the other way round; both are `aria-hidden`,
 * and the accessible name comes from the link text itself.
 *
 * ── Active state ──────────────────────────────────────────────────────
 *
 * `aria-current="page"` is what paints the pill — the styling hangs off the
 * accessibility attribute rather than a `className`, so the two cannot drift
 * apart and leave a pill that looks current to a sighted reader and reads as
 * an ordinary link to a screen reader.
 *
 * Matching is prefix-based except where `exact` is set, because `/settings`
 * should stay lit on a sub-route while `/` would otherwise match every page
 * in the app.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Match only this exact path. Set on "/" — a prefix match there lights up
      every page in the app, since every path begins with a slash. */
  exact?: boolean;
  /**
   * The path to highlight on, when `href` is not one.
   *
   * 🔴 The dashboard's Report and Present links carry the current date range as
   * a query string, and `usePathname()` returns the path WITHOUT the query — so
   * comparing against `href` there never matches and those two items would
   * simply never light up. Same bug the old rail had, which is why its
   * `[aria-current]` rule had no effect on any page.
   */
  match?: string;
  /** A red dot on the item — a pipe is down and this is where you look. */
  warn?: boolean;
};

export function SideNav({
  brandMark,
  brandName,
  brandHref = "/",
  items,
  roleLabel,
  action,
}: {
  /** One character. The agency monogram, or the client's initial. */
  brandMark: string;
  brandName: string;
  brandHref?: string;
  items: NavItem[];
  /**
   * What this session IS — "Agency operator", "Client access".
   *
   * 🔴 A role, deliberately, and not a person. The reference design puts a
   * name and a job title here, and there is no name to put: `SessionPayload`
   * carries `userId`, `agencyId`, `role` and `slugs`, and the shared-password
   * bootstrap does not even have a user row behind it. The name would have to
   * come from a lookup against the users table, which is personal data this
   * page has no reason to hold — the roll-up renders for client-role users
   * too. So the slot says what you are signed in AS, which is the thing that
   * actually changes what you can see on the page, and skips the avatar
   * rather than drawing an initial for a name nobody supplied.
   */
  roleLabel?: string | null;
  /** A primary action that belongs with the navigation — "Add client". */
  action?: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="sidenav flex shrink-0 flex-col gap-1 px-3 py-3 lg:sticky lg:top-5 lg:h-[calc(100vh-40px)] lg:w-[232px] lg:px-4 lg:py-5"
    >
      {/*
        The brand row. Below `lg` the column lies down into a bar, and the
        session controls ride up here with it: the identity block at the bottom
        is `display: none` at that width, so leaving Sign out only down there
        would mean a phone could not sign out at all. Same <Session/>, rendered
        in whichever of the two slots is visible — never both at once.
      */}
      <div className="mb-2 flex items-center gap-2">
      <Link
        href={brandHref}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-sm)] px-1 py-1"
      >
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius)] text-[14px] font-bold text-white"
          style={{
            background: "var(--g-primary)",
            boxShadow: "var(--shadow-violet)",
          }}
        >
          {brandMark}
        </span>
        <span
          className="truncate text-[15px] font-semibold tracking-[-0.01em]"
          style={{ color: "var(--text-primary)" }}
        >
          {brandName}
        </span>
      </Link>
        <div className="flex items-center gap-2 lg:hidden">
          <Session />
        </div>
      </div>

      <ul className="flex flex-row gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {items.map((item) => {
          const target = item.match ?? item.href;
          const active = item.exact
            ? pathname === target
            : pathname === target || pathname.startsWith(`${target}/`);
          return (
            <li key={item.href} className="shrink-0 lg:w-full">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className="sidenav-link"
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
                {item.warn && (
                  <span
                    role="img"
                    aria-label={`${item.label} needs attention`}
                    className="ml-auto h-2 w-2 shrink-0 rounded-full"
                    style={{ background: "var(--status-critical)" }}
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Not hidden below `lg`: "Add client" is the one thing an operator opens
          this page to do, and a phone has the same reason to do it. */}
      {action && <div className="mt-2 lg:mt-3">{action}</div>}

      {/* `mt-auto` pins the identity block to the bottom of the column, which
          is where the reference puts it and where a sign-out is least likely
          to be hit by accident on the way to somewhere else. */}
      <div className="mt-auto hidden flex-col gap-2 pt-4 lg:flex">
        {roleLabel && (
          <div className="px-1">
            <span
              className="block text-[11px] font-medium tracking-[0.04em] uppercase"
              style={{ color: "var(--text-faint)" }}
            >
              Signed in as
            </span>
            <span
              className="mt-0.5 block truncate text-[13px] font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              {roleLabel}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Session />
        </div>
      </div>
    </nav>
  );
}

/**
 * Defined once and placed twice — in the brand row below `lg`, in the identity
 * block above it — because exactly one of those two slots is ever displayed.
 * The hidden one is `display: none`, so it is out of the accessibility tree
 * too and a screen reader never meets two Sign out buttons.
 */
function Session() {
  return (
    <>
      <SignOut />
      <ThemeToggle />
    </>
  );
}
