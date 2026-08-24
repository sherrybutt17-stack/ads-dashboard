import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agencies } from "@/db/schema";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { getAgencySettings } from "@/lib/branding-store";
import { AgencySettingsForm } from "@/components/AgencySettingsForm";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";

/**
 * The agency's own settings.
 *
 * Distinct from `/c/[slug]/branding`, which is one CLIENT's brand on their own
 * dashboard. This is the mark that goes on the work — and until now it had no
 * screen at all: the fields were stored, rendered on every report, and settable
 * only by editing Postgres by hand.
 */
export default async function AgencySettingsPage() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) redirect("/");

  /*
   * The shared-password bootstrap has a role but no tenant, so there is no row
   * to edit. Sent home rather than shown an empty form that cannot save —
   * see `shared-password` in `lib/auth.ts`.
   */
  if (!session!.agencyId) redirect("/");

  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, session!.agencyId))
    .limit(1);
  if (!agency) redirect("/");

  const settings = await getAgencySettings(session!.agencyId);

  return (
    <div className="min-h-full">
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-[720px] items-center gap-3 px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <Link
              href="/"
              className="inline-flex items-center gap-1 text-xs hover:underline"
              style={{ color: "var(--text-muted)" }}
            >
              <Icon name="arrowLeft" size={12} /> Clients
            </Link>
            <h1
              className="text-lg font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              {agency.name}
            </h1>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex max-w-[720px] flex-col gap-5 px-4 py-6 sm:px-6">
        <AgencySettingsForm tenantName={agency.name} initial={settings} />

        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          A client&rsquo;s own logo and colour are set per client, on that
          client&rsquo;s branding page. This is the mark that identifies{" "}
          <strong style={{ color: "var(--text-secondary)" }}>you</strong> on the
          reports you send them.
        </p>
      </main>
    </div>
  );
}
