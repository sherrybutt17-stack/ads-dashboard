import { AppShell } from "@/components/AppShell";
import { SideNav, type NavItem } from "@/components/SideNav";
import type { SessionPayload } from "@/lib/session";
import { isAgencyOperator } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";

/**
 * The frame plus the sidebar, for the agency-side pages.
 *
 * The roll-up, Settings, Users and Audit all want the same navigation, and
 * before this each one built its own header row — which is how they drifted:
 * the roll-up offered Users / Audit log / Settings, Settings offered a back
 * arrow, and Audit offered nothing at all, so the only reliable way to reach
 * Users from Audit was the browser's back button. One definition here is what
 * stops that happening again.
 *
 * ── What appears, and for whom ────────────────────────────────────────
 *
 * 🔴 The item list is derived from the session, not filtered in the markup.
 * Users, Audit log and Settings are agency-operator pages; a client-role user
 * who reaches them is redirected, so offering them the links would be showing
 * someone four doors and then locking three. They get the client list alone,
 * which for them is the list of dashboards shared with their account.
 */


export function AgencyShell({
  session,
  brandName,
  action,
  children,
}: {
  session: SessionPayload | null;
  /** The agency's own name, from `agencies.name`. Falls back to the product. */
  brandName?: string | null;
  /** "Add client" — a primary action that belongs beside the destinations. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const staff = isAgencyOperator(session);
  const name = brandName?.trim() || "Dashboard";

  const items: NavItem[] = [
    {
      href: "/",
      // Exact: every path in the app starts with a slash, so a prefix match
      // here would light this pill up on every page at once.
      exact: true,
      label: staff ? "Clients" : "Dashboards",
      icon: "grid",
    },
    ...(staff
      ? ([
          { href: "/users", label: "Users", icon: "users" },
          { href: "/audit", label: "Audit log", icon: "shield" },
          { href: "/settings", label: "Settings", icon: "settings" },
        ] as NavItem[])
      : []),
  ];

  return (
    <AppShell
      nav={
        <SideNav
          brandMark="◆"
          brandName={name}
          items={items}
          roleLabel={roleLabel(session?.role)}
          action={staff ? action : undefined}
        />
      }
    >
      {children}
    </AppShell>
  );
}
