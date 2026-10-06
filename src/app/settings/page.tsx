import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agencies } from "@/db/schema";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { getAgencySettings } from "@/lib/branding-store";
import { AgencySettingsForm } from "@/components/AgencySettingsForm";
import { AgencyShell } from "@/components/AgencyShell";
import { PageTitle } from "@/components/PageTitle";

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
    <AgencyShell session={session} brandName={agency.name}>
      <main className="mx-auto w-full max-w-[720px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <PageTitle title="Settings" subtitle={agency.name} />

        <AgencySettingsForm tenantName={agency.name} initial={settings} />

        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          A client&rsquo;s own logo and colour are set per client, on that
          client&rsquo;s branding page. This is the mark that identifies{" "}
          <strong style={{ color: "var(--text-secondary)" }}>you</strong> on the
          reports you send them.
        </p>
      </main>
    </AgencyShell>
  );
}
