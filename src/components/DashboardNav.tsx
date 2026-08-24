import Link from "next/link";
import { Icon } from "@/components/Icon";
import type { SectionGroup } from "@/lib/dashboard/registry";

/**
 * The dashboard's side navigation.
 *
 * ── Why a sidebar ─────────────────────────────────────────────────────
 *
 * The header had twelve controls in one flex row: sync state, a platform
 * toggle, the range picker, customise, report, present, share, export,
 * branding, setup, sign out and the theme switch. On anything narrower than a
 * wide desktop they wrapped and overlapped each other, and "Setup" — the page
 * that connects Meta, Google and the CRM — was an unlabelled button at the end
 * of that row, which is why it read as missing entirely.
 *
 * Splitting by KIND rather than by frequency is what makes this navigable:
 *
 *   sidebar — where you are and where you can go (tabs, views, connections)
 *   header  — what you are looking AT (date range, platform, this range's
 *             share/export)
 *
 * So the header now holds only controls that change the *data on screen*, and
 * everything that changes *which screen* lives here.
 *
 * ── Naming ────────────────────────────────────────────────────────────
 *
 * "Connections", not "Setup". The page verifies the Meta, Google, TikTok and
 * GoHighLevel links and shows the health checklist; "Setup" reads like a
 * one-time wizard you have already finished, so nobody returns to it when a
 * token dies. It is named for what it holds.
 */

export interface NavGroup {
  id: SectionGroup;
  label: string;
  blurb: string;
}

export function DashboardNav({
  slug,
  brandName,
  logoUrl,
  groups,
  activeGroup,
  hrefForGroup,
  reportHref,
  presentHref,
  staff,
  showBranding,
  connectionsWarning,
}: {
  slug: string;
  brandName: string;
  logoUrl: string | null;
  groups: readonly NavGroup[];
  activeGroup: SectionGroup;
  hrefForGroup: (g: SectionGroup) => string;
  reportHref: string;
  presentHref: string;
  staff: boolean;
  showBranding: boolean;
  /** Something is wrong with a pipe — surfaced ON the Connections link. */
  connectionsWarning?: boolean;
}) {
  return (
    <aside
      className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col gap-1 overflow-y-auto border-r px-3 py-4 lg:flex"
      style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
    >
      <Link
        href={`/c/${slug}`}
        className="mb-1 flex min-w-0 items-center gap-2.5 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-[var(--surface-2)]"
      >
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt={brandName}
            className="h-8 w-auto max-w-[150px] shrink-0 object-contain"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[14px] font-bold text-white"
            style={{
              background:
                "linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 50%, #0d1b30) 100%)",
            }}
          >
            {brandName.trim().charAt(0).toUpperCase() || "•"}
          </div>
        )}
        {!logoUrl && (
          <span
            className="min-w-0 truncate text-[14px] font-semibold"
            style={{ color: "var(--text-primary)", letterSpacing: "-0.01em" }}
          >
            {brandName}
          </span>
        )}
      </Link>

      <NavLink href="/" label="All clients" muted />

      <Heading>Dashboard</Heading>
      {groups.map((g) => (
        <NavLink
          key={g.id}
          href={hrefForGroup(g.id)}
          label={g.label}
          hint={g.blurb}
          active={g.id === activeGroup}
        />
      ))}

      <Heading>This range</Heading>
      <NavLink href={reportHref} label="Report" hint="A page you can send" />
      <NavLink href={presentHref} label="Present" hint="Full screen, one number at a time" />

      {(staff || showBranding) && <Heading>Manage</Heading>}
      {staff && (
        <NavLink
          href={`/c/${slug}/setup`}
          label="Connections"
          hint="Meta, Google, TikTok and the CRM"
          warn={connectionsWarning}
        />
      )}
      {showBranding && (
        <NavLink
          href={`/c/${slug}/branding`}
          label="Branding"
          hint="Logo, colour and display name"
        />
      )}

    </aside>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mt-4 mb-1 px-2 text-[10.5px] font-semibold tracking-[0.07em] uppercase"
      style={{ color: "var(--text-muted)" }}
    >
      {children}
    </p>
  );
}

function NavLink({
  href,
  label,
  hint,
  active,
  muted,
  warn,
}: {
  href: string;
  label: string;
  hint?: string;
  active?: boolean;
  muted?: boolean;
  warn?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={hint}
      className="group flex items-center gap-2 rounded-[9px] px-2.5 py-2 text-[13.5px] font-medium transition-colors hover:bg-[var(--surface-2)]"
      style={{
        background: active ? "var(--surface-2)" : "transparent",
        color: active
          ? "var(--text-primary)"
          : muted
            ? "var(--text-muted)"
            : "var(--text-secondary)",
        boxShadow: active ? "inset 2px 0 0 var(--accent)" : "none",
      }}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/*
        A red dot on Connections when a pipe is down. The whole product exists
        because a broken feed went unnoticed for months; the navigation is where
        someone looks before they know to look at anything.
      */}
      {warn && (
        <span
          aria-label="needs attention"
          className="inline-flex shrink-0 items-center"
          style={{ color: "var(--status-critical)" }}
        >
          <Icon name="alert" className="h-3.5 w-3.5" />
        </span>
      )}
    </Link>
  );
}
