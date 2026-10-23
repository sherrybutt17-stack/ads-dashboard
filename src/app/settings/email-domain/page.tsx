import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agencies } from "@/db/schema";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { getAgencySettings } from "@/lib/branding-store";
import { getUserById } from "@/lib/users";
import { agencyEmailConfigured } from "@/lib/reports/email";
import { getAgencyDomain, toDomainView } from "@/lib/email-domains/store";
import { freshenForDisplay } from "@/lib/email-domains/refresh";
import { senderFor } from "@/lib/email-domains/deliver";
import { findDmarc } from "@/lib/email-domains/dmarc";
import type { DnsRecord } from "@/lib/email-domains/identity";
import { AgencyShell } from "@/components/AgencyShell";
import { PageTitle } from "@/components/PageTitle";
import { SettingsTabs } from "@/components/SettingsTabs";
import { EmailDomainSettings } from "@/components/EmailDomainSettings";

export const dynamic = "force-dynamic";

/**
 * Settings → Email domain.
 *
 * Same guards as `/settings`: an agency operator, on a session that has an
 * agency. Everything shown is this agency's own row.
 *
 * ── The status is fresh when the page opens ────────────────────────────
 *
 * An agency adds its records, goes away, and comes back to see whether it
 * worked. So an unverified domain is re-read from Resend as the page renders —
 * bounded at three seconds, never throwing (a slow Resend shows the last known
 * status), and skipped if it was read in the last half-minute, because every
 * agency shares one Resend team and a reload should not spend its rate limit.
 */

const RECHECK_AFTER_MS = 30_000;

export default async function EmailDomainPage() {
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

  const available = agencyEmailConfigured();
  const [settings, me] = await Promise.all([
    getAgencySettings(agencyId),
    getUserById(session!.userId).catch(() => null),
  ]);

  const stored = available ? await getAgencyDomain(agencyId) : null;
  const row = stored
    ? await freshenForDisplay(stored, { afterMs: RECHECK_AFTER_MS, timeoutMs: 3_000 })
    : null;

  const [sender, dmarc] = await Promise.all([
    senderFor(agencyId),
    row && row.status !== "verified" ? findDmarc(row.domain) : Promise.resolve(null),
  ]);

  const view = row ? toDomainView(row) : null;
  /*
   * Named the way Resend names its own records for this domain, so the hint
   * the tab gives about hosts holds for this one too: Resend's DKIM host is
   * `resend._domainkey` plus whatever suffix it uses for a subdomain.
   */
  const dkim = view?.records.find((r) => r.name.startsWith("resend._domainkey"));
  const suggestedDmarc: DnsRecord | null =
    view && dmarc && !dmarc.found
      ? {
          record: "DMARC",
          name: dkim ? dkim.name.replace(/^resend\._domainkey/, "_dmarc") : "_dmarc",
          type: "TXT",
          value: "v=DMARC1; p=none;",
          priority: null,
          ttl: null,
          status: null,
        }
      : null;

  return (
    <AgencyShell session={session} brandName={settings.agencyName ?? agency.name}>
      <main className="mx-auto w-full max-w-[720px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <PageTitle title="Settings" subtitle={agency.name} />
        <SettingsTabs active="email-domain" />

        <EmailDomainSettings
          available={available}
          agencyName={settings.agencyName ?? agency.name}
          supportEmail={settings.supportEmail}
          domain={view}
          currentFrom={sender.from}
          viaDomain={sender.viaDomain}
          testRecipient={me?.email ?? null}
          suggestedDmarc={suggestedDmarc}
        />
      </main>
    </AgencyShell>
  );
}
