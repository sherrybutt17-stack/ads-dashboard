import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pipelineStages } from "@/db/schema";
import { getClientBySlug, webhookUrlFor } from "@/lib/clients";
import { runHealthChecks } from "@/lib/health";
import { getSessionUser, isStaff } from "@/lib/auth";
import { getInstallationForClient, isOauthConfigured } from "@/lib/ghl/oauth";
import { listAdAccounts } from "@/lib/meta/accounts";
import { listGoogleAccounts } from "@/lib/google/accounts";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { HealthChecklist } from "@/components/HealthChecklist";
import { SetupWizard } from "@/components/SetupWizard";
import { LeadSourceSettings } from "@/components/LeadSourceSettings";
import { RemoveClient } from "@/components/RemoveClient";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getLeadAttributionBreakdown } from "@/lib/metrics/queries";
import { trailingWindowInclusive } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function SetupPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Setup is staff-only (token management, health internals). The proxy blocks
  // client users here too; this is defence in depth.
  if (!isStaff(await getSessionUser())) redirect(`/c/${slug}`);

  const client = await getClientBySlug(slug);
  if (!client) notFound();

  const stages = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.clientId, client.id))
    .orderBy(pipelineStages.displayOrder);

  const [health, installation, leadBreakdown, adAccounts, googleAccounts] =
    await Promise.all([
      runHealthChecks(client),
      getInstallationForClient(client.id),
      getLeadAttributionBreakdown(
        client.id,
        trailingWindowInclusive(30, client.timezone),
        { mode: client.paidLeadFilter, tag: client.paidLeadTag },
      ),
      listAdAccounts(client.id),
      listGoogleAccounts(client.id),
    ]);

  return (
    <div className="min-h-full">
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-[900px] items-center gap-3 px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <Link
              href={`/c/${slug}`}
              className="text-xs hover:underline"
              style={{ color: "var(--text-muted)" }}
            >
              ← {client.name}
            </Link>
            <h1
              className="text-lg font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              Setup &amp; connections
            </h1>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex max-w-[900px] flex-col gap-5 px-4 py-6 sm:px-6">
        <HealthChecklist clientId={client.id} initial={health} />

        <LeadSourceSettings
          clientId={client.id}
          initialMode={client.paidLeadFilter}
          initialTag={client.paidLeadTag}
          breakdown={leadBreakdown}
        />

        <SetupWizard
          clientId={client.id}
          slug={client.slug}
          webhookUrl={webhookUrlFor(client)}
          oauthAvailable={isOauthConfigured()}
          installation={
            installation
              ? {
                  locationId: installation.locationId,
                  locationName: installation.locationName,
                  installedAt: installation.installedAt.toISOString(),
                  uninstalledAt:
                    installation.uninstalledAt?.toISOString() ?? null,
                }
              : null
          }
          initial={{
            ghlLocationId: client.ghlLocationId ?? "",
            ghlLocationName: client.ghlLocationName,
            ghlAuthMethod: client.ghlAuthMethod,
            hasGhlToken: Boolean(client.ghlTokenEncrypted),
            clientTimezone: client.timezone,
            firstWebhookAt: client.firstWebhookAt?.toISOString() ?? null,
          }}
          metaAccounts={adAccounts.map((a) => ({
            id: a.id,
            adAccountId: a.adAccountId,
            accountName: a.accountName,
            currency: a.currency,
            timezone: a.timezone,
            isPrimary: a.isPrimary,
            status: a.status,
          }))}
          googleConfigured={isGoogleConfigured()}
          googleAccounts={googleAccounts.map((a) => ({
            id: a.id,
            customerId: a.customerId,
            accountName: a.accountName,
            currency: a.currency,
            timezone: a.timezone,
            isPrimary: a.isPrimary,
            status: a.status,
          }))}
          stages={stages.map((s) => ({
            id: s.id,
            name: s.ghlStageName,
            pipelineName: s.ghlPipelineName,
            canonicalStage: s.canonicalStage,
            discoveredFromWebhook: s.discoveredFromWebhook,
          }))}
        />

        <RemoveClient clientId={client.id} clientName={client.name} />
      </main>
    </div>
  );
}
