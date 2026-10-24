import Link from "next/link";

/**
 * The Settings tabs: the agency's mark, the domain its email comes from, and
 * its own metrics. Plain links with `aria-current`, in the same chip row the
 * Audit page uses for its categories — each tab is its own page, so the
 * browser's back button and a shared link both land where they should.
 */

const TABS = [
  { key: "branding", href: "/settings", label: "Branding" },
  { key: "email-domain", href: "/settings/email-domain", label: "Email domain" },
  { key: "metrics", href: "/settings/metrics", label: "Metrics" },
] as const;

export function SettingsTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="Settings sections" className="mb-5 flex flex-wrap items-center gap-2">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className="chip font-medium"
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
