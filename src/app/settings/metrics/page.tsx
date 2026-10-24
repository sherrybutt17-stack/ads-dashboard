import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agencies } from "@/db/schema";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { getAgencySettings } from "@/lib/branding-store";
import { customMetricUsage, listCustomMetrics } from "@/lib/board/custom-metrics";
import { AgencyShell } from "@/components/AgencyShell";
import { PageTitle } from "@/components/PageTitle";
import { SettingsTabs } from "@/components/SettingsTabs";
import { MetricsSettings } from "@/components/MetricsSettings";

export const dynamic = "force-dynamic";

/**
 * Settings → Metrics.
 *
 * Same guards as `/settings`: an agency operator, on a session that has an
 * agency. Everything shown is this agency's own metrics, each with how many of
 * its clients' boards use it.
 */
export default async function MetricsSettingsPage() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) redirect("/");
  if (!session!.agencyId) redirect("/");
  const agencyId = session!.agencyId;

  const [agency] = await db
    .select({ name: agencies.name })
    .from(agencies)
    .where(eq(agencies.id, agencyId))
    .limit(1);
  if (!agency) redirect("/");

  const [settings, metrics, usage] = await Promise.all([
    getAgencySettings(agencyId),
    listCustomMetrics(agencyId),
    customMetricUsage(agencyId).catch(() => new Map<string, number>()),
  ]);

  return (
    <AgencyShell session={session} brandName={settings.agencyName ?? agency.name}>
      <main className="mx-auto w-full max-w-[880px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <PageTitle title="Settings" subtitle={agency.name} />
        <SettingsTabs active="metrics" />
        <MetricsSettings metrics={metrics.map((m) => ({ ...m, boards: usage.get(m.id) ?? 0 }))} />
      </main>
    </AgencyShell>
  );
}
