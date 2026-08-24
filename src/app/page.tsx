import Link from "next/link";
import { listClientsForSession } from "@/lib/clients";
import { listAdAccounts } from "@/lib/meta/accounts";
import { quickHealth } from "@/lib/health";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { HealthBadge } from "@/components/HealthChecklist";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AddClientButton } from "@/components/AddClientButton";
import { SignOut } from "@/components/SignOut";
import { BookRollupPanel } from "@/components/BookRollup";
import { BookPacingPanel } from "@/components/BookPacing";
import { ChurnChip, ChurnRiskPanel } from "@/components/ChurnRisk";
import { loadBook, loadChurn } from "@/lib/metrics/book";
import { loadBookPacing } from "@/lib/book-pacing-load";

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

  const clients = await Promise.all(
    visible.map(async (c) => {
      const accounts = await listAdAccounts(c.id);
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
        health: await quickHealth(c),
        churn: churnLevel.get(c.slug),
      };
    }),
  );

  return (
    <div className="min-h-full">
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-[1100px] items-center gap-3 px-4 py-4 sm:px-6">
          <div className="flex flex-1 items-center gap-2.5">
            <div
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[13px] font-bold text-white"
              style={{
                background: "linear-gradient(135deg, #4a97ee 0%, #1c5cab 100%)",
                boxShadow:
                  "0 2px 8px -2px rgba(28, 92, 171, 0.5), inset 0 1px 0 rgba(255,255,255,0.25)",
              }}
            >
              ◆
            </div>
            <h1
              className="text-lg font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              {staff ? "Clients" : "Your dashboards"}
            </h1>
          </div>
          {staff && (
            <>
              <Link
                href="/users"
                className="btn-ghost rounded-[9px] px-3 py-2 text-[13px] font-medium"
              >
                Users
              </Link>
              <Link
                href="/audit"
                className="btn-ghost rounded-[9px] px-3 py-2 text-[13px] font-medium"
              >
                Audit log
              </Link>
              <Link
                href="/settings"
                className="btn-ghost rounded-[9px] px-3 py-2 text-[13px] font-medium"
              >
                Settings
              </Link>
              <AddClientButton />
            </>
          )}
          <SignOut />
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6">
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
            <ul className="flex flex-col gap-3">
              {clients.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/c/${c.slug}`}
                    className="card card-interactive flex flex-wrap items-center gap-4 p-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate font-semibold"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {c.name}
                      </div>
                      <div
                        className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <span>{c.ghlLocationName ?? "GHL not connected"}</span>
                        <span aria-hidden="true">·</span>
                        <span>{c.metaLabel}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {/* Mirrors the panel above, so a flagged client is
                        findable in the list without scrolling back up. */}
                      <ChurnChip level={c.churn} />
                      {!c.firstWebhookAt && (
                        <span
                          className="text-xs font-medium"
                          style={{ color: "var(--status-critical)" }}
                        >
                          No events yet
                        </span>
                      )}
                      <HealthBadge level={c.health} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

function EmptyState({ staff }: { staff: boolean }) {
  if (!staff) {
    return (
      <div
        className="rounded-[14px] border border-dashed p-10 text-center"
        style={{ borderColor: "var(--border-strong)" }}
      >
        <h2
          className="text-base font-semibold"
          style={{ color: "var(--text-primary)" }}
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
  return (
    <div
      className="rounded-[14px] border border-dashed p-10 text-center"
      style={{ borderColor: "var(--border-strong)" }}
    >
      <h2
        className="text-base font-semibold"
        style={{ color: "var(--text-primary)" }}
      >
        No clients yet
      </h2>
      <p
        className="mx-auto mt-2 max-w-md text-sm"
        style={{ color: "var(--text-secondary)" }}
      >
        Add your first client to connect their GoHighLevel sub-account and Meta
        ad account. The setup wizard verifies each connection before saving it.
      </p>
      <div className="mt-5 flex justify-center">
        <AddClientButton />
      </div>
    </div>
  );
}
