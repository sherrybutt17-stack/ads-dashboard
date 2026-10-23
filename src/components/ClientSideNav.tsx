import { SideNav, type NavItem } from "@/components/SideNav";
import { roleLabel } from "@/lib/roles";
import type { SessionPayload } from "@/lib/session";

/**
 * The sidebar for one client's pages — Overview, Board, Report, Present,
 * Connections, Branding, and the way back out.
 *
 * ── Why this is not built at each call site ───────────────────────────
 *
 * It was, once, and only the Overview page had it. Connections and Branding
 * are two of the items in this very list, yet opening either of them replaced
 * the column with a back arrow — the reader was inside the navigation and
 * could no longer see it. That is the same drift `AgencyShell` was written to
 * stop on the agency side, arriving from the other direction: not four pages
 * each inventing a header, but three pages where one had a sidebar and two
 * quietly did not.
 *
 * ── The three hrefs that are not fixed ────────────────────────────────
 *
 * Board, Report and Present carry the open date range as a query string, so
 * that moving between them keeps the window the reader chose. Only the
 * Overview and Board pages HAVE an open range, so the other pages leave these
 * to their defaults and link bare — every one of them falls back to a
 * trailing 30 days when the parameters are absent, which is the same window
 * the dashboard opens on.
 *
 * Either way the highlight is computed from `match`, never from `href`:
 * `usePathname()` returns the path without the query, so an href carrying one
 * can never equal it. See `NavItem`.
 */
export function ClientSideNav({
  slug,
  brandName,
  session,
  staff,
  brandingEditable,
  warnConnections = false,
  boardHref = `/c/${slug}/board`,
  reportHref = `/c/${slug}/report`,
  presentHref = `/c/${slug}/present`,
}: {
  slug: string;
  /** The client's display name — their branding's, falling back to the record's. */
  brandName: string;
  session: SessionPayload | null;
  staff: boolean;
  /** Whether the agency has opened the branding page to the client. */
  brandingEditable: boolean;
  /** A dot on Connections when a pipe is broken rather than merely quiet. */
  warnConnections?: boolean;
  boardHref?: string;
  reportHref?: string;
  presentHref?: string;
}) {
  const items: NavItem[] = [
    { href: `/c/${slug}`, exact: true, label: "Overview", icon: "chart" },
    // Prefix-matched, so the editor at /board/edit keeps it lit.
    { href: boardHref, match: `/c/${slug}/board`, label: "Board", icon: "board" },
    {
      href: reportHref,
      match: `/c/${slug}/report`,
      label: "Report",
      icon: "fileText",
    },
    {
      href: presentHref,
      match: `/c/${slug}/present`,
      label: "Present",
      icon: "presentation",
    },
    ...(staff
      ? ([
          {
            href: `/c/${slug}/setup`,
            label: "Connections",
            icon: "plug",
            warn: warnConnections,
          },
        ] as NavItem[])
      : []),
    ...(staff || brandingEditable
      ? ([
          { href: `/c/${slug}/branding`, label: "Branding", icon: "palette" },
        ] as NavItem[])
      : []),
    /*
     * Last, not first. It is the way OUT of this client — every other item is a
     * view of the client whose name is at the top of the column, and putting
     * "All clients" above them would read as the heading for the group.
     */
    { href: "/", exact: true, label: "All clients", icon: "grid" },
  ];

  return (
    <SideNav
      brandMark={brandName.trim().charAt(0).toUpperCase() || "•"}
      brandName={brandName}
      brandHref={`/c/${slug}`}
      items={items}
      roleLabel={roleLabel(session?.role)}
    />
  );
}
