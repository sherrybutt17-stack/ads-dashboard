import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pipelineStages } from "@/db/schema";
import { getClientForSession, webhookUrlFor } from "@/lib/clients";
import { runHealthChecks } from "@/lib/health";
import { getSessionUser, isAgencyOperator, isSuperadmin } from "@/lib/auth";
import { getInstallationForClient, isOauthConfigured } from "@/lib/ghl/oauth";
import { listAdAccounts } from "@/lib/meta/accounts";
import { listGoogleAccounts } from "@/lib/google/accounts";
import { isGoogleConfigured } from "@/lib/google/oauth";
import { HealthChecklist } from "@/components/HealthChecklist";
import { SetupWizard } from "@/components/SetupWizard";
import { BrandingSettings } from "@/components/BrandingSettings";
import { getClientBranding } from "@/lib/branding-store";
import { LeadSourceSettings } from "@/components/LeadSourceSettings";
import { AlertSettings } from "@/components/AlertSettings";
import { ReportSchedule } from "@/components/ReportSchedule";
import { BudgetSettings } from "@/components/BudgetSettings";
import { describeDestination } from "@/lib/alerts/send";
import { RemoveClient } from "@/components/RemoveClient";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getLeadAttributionBreakdown } from "@/lib/metrics/queries";
import { trailingWindowInclusive } from "@/lib/dates";
import { isMetaConnectConfigured } from "@/lib/meta/oauth";
import { isTiktokConnectConfigured } from "@/lib/tiktok/oauth";
import { activeTiktokAccountsForDisplay } from "@/lib/tiktok/accounts";

export const dynamic = "force-dynamic";

export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    metaStash?: string;
    googleStash?: string;
    tiktokStash?: string;
  }>;
}) {
  const { slug } = await params;
  /*
   * Set when Facebook, Google or TikTok has just redirected back here after
   * consent; each opens its own account picker. Bounded and character-checked
   * because they reach a fetch URL — the server re-verifies each against this
   * client regardless, so this is defence in depth rather than the check itself.
   */
  const sp = await searchParams;
  const validStash = (v: unknown) =>
    typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
  const stash = validStash(sp.metaStash);
  const googleStash = validStash(sp.googleStash);
  const tiktokStash = validStash(sp.tiktokStash);
  /*
   * Setup belongs to whoever runs the account — an agency owner for their own
   * clients, and us for anyone's. It is closed to the client-role viewer, who
   * would find token management and health internals here. The proxy blocks
   * them too; this is defence in depth.
   */
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) redirect(`/c/${slug}`);

  /*
   * Scoped read, then the grant check. `getClientForSession` already applies
   * both the tenant and — for a client-role login — the slug grant, so a
   * client belonging to another agency is `null` here and renders the same
   * 404 as one that does not exist. `canAccessSlug` below is kept as the
   * redirect-to-home behaviour for a signed-in user hitting a slug they do
   * not hold, which is a nicer landing than a bare not-found.
   */
  const client = await getClientForSession(session, slug);
  if (!client) notFound();

  const stages = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.clientId, client.id))
    .orderBy(pipelineStages.displayOrder);

  const [
    health,
    installation,
    leadBreakdown,
    adAccounts,
    googleAccounts,
    tiktokAccounts,
    branding,
    alertDestination,
  ] = await Promise.all([
    // Raw upstream errors are superadmin-only — an agency owner legitimately
    // reads this page and still must not read our infrastructure back off it.
    runHealthChecks(client, { superadmin: isSuperadmin(session) }),
    getInstallationForClient(client.id),
    getLeadAttributionBreakdown(
      client.id,
      trailingWindowInclusive(30, client.timezone),
      { mode: client.paidLeadFilter, tag: client.paidLeadTag },
    ),
    listAdAccounts(client.id),
    listGoogleAccounts(client.id),
    // Returns `{ accounts, error }` rather than throwing — its table arrives by
    // migration, and a deploy landing ahead of one must not take the whole
    // setup page down over a platform this client may not even use.
    activeTiktokAccountsForDisplay(client.id),
    getClientBranding(client.id),
    describeDestination(client.id),
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

        <BrandingSettings
          clientId={client.id}
          slug={client.slug}
          clientName={client.name}
          initial={branding}
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
          metaConnectConfigured={isMetaConnectConfigured()}
          metaStash={stash}
          googleConfigured={isGoogleConfigured()}
          googleStash={googleStash}
          googleAccounts={googleAccounts.map((a) => ({
            id: a.id,
            customerId: a.customerId,
            accountName: a.accountName,
            currency: a.currency,
            timezone: a.timezone,
            isPrimary: a.isPrimary,
            status: a.status,
          }))}
          tiktokConfigured={isTiktokConnectConfigured()}
          tiktokStash={tiktokStash}
          tiktokAccounts={tiktokAccounts.accounts.map((a) => ({
            id: a.id,
            advertiserId: a.advertiserId,
            advertiserName: a.advertiserName,
            currency: a.currency,
            timezone: a.timezone,
            status: a.status as "active" | "paused" | "removed",
          }))}
          stages={stages.map((s) => ({
            id: s.id,
            name: s.ghlStageName,
            pipelineName: s.ghlPipelineName,
            canonicalStage: s.canonicalStage,
            discoveredFromWebhook: s.discoveredFromWebhook,
          }))}
        />

        <AlertSettings clientId={client.id} initial={alertDestination} />

        {/*
          Below the alerts, because both are outbound and they read as a pair:
          one fires the moment a lead lands, the other summarises a period. The
          schedule needs the client's timezone — the send hour is theirs, not
          the server's.
        */}
        <ReportSchedule clientId={client.id} timezone={client.timezone} />

        {/*
          The commercial term the dashboard's pacing is measured against. Sits
          with the other per-client settings rather than on the dashboard
          itself: it is agreed once and changed rarely, and an editable target
          beside the panel judging performance against it invites the target to
          move instead of the spend.
        */}
        {/*
          Currency comes from the primary ad account, not from the client: a
          budget is compared against that account's spend, so labelling it with
          anything else would be a wrong answer wearing a correct symbol.
        */}
        <BudgetSettings
          clientId={client.id}
          currency={
            adAccounts.find((a) => a.isPrimary)?.currency ??
            adAccounts[0]?.currency ??
            "USD"
          }
        />

        <RemoveClient clientId={client.id} clientName={client.name} />
      </main>
    </div>
  );
}
