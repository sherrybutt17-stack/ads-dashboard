import { listClientsForSession } from "@/lib/clients";
import { listAdAccounts } from "@/lib/meta/accounts";
import { quickHealth } from "@/lib/health";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { AddClientButton } from "@/components/AddClientButton";
import { BookRollupPanel } from "@/components/BookRollup";
import { BookKpis } from "@/components/BookKpis";
import { PageTitle } from "@/components/PageTitle";
import { BookPacingPanel } from "@/components/BookPacing";
import { ChurnRiskPanel } from "@/components/ChurnRisk";
import { ClientCards } from "@/components/ClientCards";
import { getClientBranding } from "@/lib/branding-store";
import { accentFor } from "@/lib/branding";
import { loadBook, loadChurn } from "@/lib/metrics/book";
import { loadBookPacing } from "@/lib/book-pacing-load";
import { AgencyShell } from "@/components/AgencyShell";
import { getAgencySettings } from "@/lib/branding-store";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const session = await getSessionUser();
  const staff = isAgencyOperator(session);
  /*
   * 🔴 Scoped at the QUERY, not only in the filter below.
   *
   * `listClients()` returned every row in the database, and the filter that
   * followed dropped the ones this session may not see. That is safe exactly
   * until someone adds a line above the filter — a count, a "syncing now"
   * banner, a sort — that reads `rows`. The tenant boundary should not depend
   * on nobody ever touching the variable holding the other tenants' data.
   */
  const rows = await listClientsForSession(session);
  /*
   * 🔴 The visible set is computed ONCE and the roll-up is built from it.
   *
   * Totalling `rows` instead would put every tenant's spend behind one number
   * on a page a client-role user can open — the aggregate is not anonymous when
   * the reader knows they are one of three accounts in it.
   */
  const visible = rows.filter((c) => c.status !== "archived");

  /*
   * Both agency-facing, and loaded only when they will be rendered.
   *
   * 🔴 The churn panel is staff-only and must stay that way. Nobody should read
   * "you look like you are about to leave" about their own account, and the
   * whole point of the thing is a conversation that happens before the client
   * has that thought.
   *
   * Loaded together but failing apart: each returns its own error and the client
   * list below works without either.
   */
  const [book, churn, bookPacing] = staff
    ? await Promise.all([
        loadBook(visible),
        loadChurn(visible),
        /*
         * Staff-only for the same reason the per-client panel is: a budget is a
         * commercial term, and which clients are off it is an agency-side
         * conversation.
         */
        loadBookPacing(visible),
      ])
    : [null, null, null];
  const churnLevel = new Map(
    (churn?.report.flagged ?? []).map((c) => [c.slug, c.level]),
  );

  /*
   * The sidebar wears the agency's own name. `getAgencySettings` never throws —
   * branding is chrome and must not be able to take down a page of real numbers
   * — so a settings-table failure costs the word above the nav, nothing else.
   */
  const brandName = session
    ? ((await getAgencySettings(session.agencyId)).agencyName ?? null)
    : null;

  const clients = await Promise.all(
    visible.map(async (c) => {
      const [accounts, branding] = await Promise.all([
        listAdAccounts(c.id),
        /*
         * The card wears the client's OWN accent — the same colour their
         * dashboard is painted in — so a card and the page it opens are
         * recognisably the same place. `getClientBranding` never throws and
         * falls back to `NO_BRANDING`, which `accentFor` turns into the
         * generated accent for this client id: a colour still follows the
         * client, never their position in the list, so archiving one never
         * repaints the rest.
         */
        getClientBranding(c.id),
      ]);
      const label =
        accounts.length === 0
          ? "Meta not connected"
          : accounts.length === 1
            ? (accounts[0].accountName ?? "1 ad account")
            : `${accounts.length} ad accounts`;
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        metaLabel: label,
        ghlLocationName: c.ghlLocationName,
        firstWebhookAt: c.firstWebhookAt,
        // No webhookUrl: this list renders for client-role users too, and the
        // token in it is the GHL shared secret. Nothing here rendered it.
        adAccounts: accounts.length,
        ghlConnected: Boolean(c.ghlLocationId),
        accent: accentFor(c.id, branding),
        health: await quickHealth(c),
        churn: churnLevel.get(c.slug),
      };
    }),
  );

  /*
   * 🔴 One currency, or no cards. `byCurrency` groups the book by the currency
   * spend was priced in, and stacking a headline number on top of two of them
   * would be adding dollars to pounds — the panel below deliberately breaks
   * those out for exactly that reason, and a KPI row that quietly summed them
   * would undo it in the most prominent place on the page.
   */
  const headline =
    book && book.rollup.singleCurrency && book.rollup.byCurrency.length === 1
      ? book.rollup.byCurrency[0]
      : null;

  const subtitle = staff
    ? `${clients.length} active ${clients.length === 1 ? "client" : "clients"}${
        book ? ` · last ${book.days} days` : ""
      }`
    : `${clients.length} ${clients.length === 1 ? "dashboard" : "dashboards"} shared with your account`;

  return (
    <AgencyShell
      session={session}
      brandName={brandName}
      action={<AddClientButton />}
    >
      <main className="mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <PageTitle
          title={staff ? "Clients" : "Your dashboards"}
          subtitle={subtitle}
        />

        {headline && book && <BookKpis t={headline} days={book.days} />}

        {clients.length === 0 ? (
          <EmptyState staff={staff} />
        ) : (
          <>
            {/*
             * `|| book.error` matters: a failed roll-up returns an EMPTY book, so
             * gating on row count alone would hide the very state that explains
             * why the totals are missing — and the panel would simply vanish,
             * which is the silent-omission failure this product exists to replace.
             */}
            {book && (book.rollup.rows.length > 0 || book.error) && (
              <BookRollupPanel
                book={book.rollup}
                days={book.days}
                error={book.error}
              />
            )}
            {bookPacing && (
              <BookPacingPanel
                pacing={bookPacing.pacing}
                error={bookPacing.error}
              />
            )}
            {churn && (
              <ChurnRiskPanel report={churn.report} error={churn.error} />
            )}
            <ClientCards clients={clients} staff={staff} />
          </>
        )}
      </main>
    </AgencyShell>
  );
}

function EmptyState({ staff }: { staff: boolean }) {
  if (!staff) {
    return (
      <div
        className="rounded-[var(--radius-lg)] border border-dashed p-10 text-center"
        style={{ borderColor: "var(--border-strong)" }}
      >
        <h2
          className="text-base font-semibold"
          style={{ color: "var(--section-ink, var(--text-primary))" }}
        >
          No dashboards yet
        </h2>
        <p
          className="mx-auto mt-2 max-w-md text-sm"
          style={{ color: "var(--text-secondary)" }}
        >
          No dashboards have been shared with your account yet. Contact your
          agency to get access.
        </p>
      </div>
    );
  }
  /*
   * The staff version is a pitch, so it gets the hero panel; the viewer version
   * above is a dead end they cannot act on, and dressing "ask someone else" up
   * as an offer would be the wrong tone entirely.
   */
  return (
    <div className="card-hero flex flex-col items-start gap-1 px-8 py-10 sm:px-10">
      <span className="eyebrow" style={{ color: "rgba(255,255,255,0.72)" }}>
        Get started
      </span>
      <h2 className="text-[24px] leading-tight font-semibold tracking-[-0.02em]">
        No clients yet
      </h2>
      <p
        className="mt-2 max-w-[52ch] text-sm leading-relaxed"
        style={{ color: "rgba(255,255,255,0.82)" }}
      >
        Add your first client to connect their GoHighLevel sub-account and Meta
        ad account. The setup wizard verifies each connection before saving it.
      </p>
      <div className="mt-6">
        <AddClientButton />
      </div>
    </div>
  );
}
