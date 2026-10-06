import { redirect } from "next/navigation";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { listUsersForAgency } from "@/lib/users";
import { assignableRoles } from "@/lib/roles";
import { listClientsForSession } from "@/lib/clients";
import { UsersManager } from "@/components/UsersManager";
import { emailConfig, senderProblem } from "@/lib/reports/email";
import { AgencyShell } from "@/components/AgencyShell";
import { PageTitle } from "@/components/PageTitle";
import { getAgencySettings } from "@/lib/branding-store";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) redirect("/");

  const [users, clientRows, agency] = await Promise.all([
    listUsersForAgency(session!.agencyId),
    listClientsForSession(session),
    // The sidebar wears the agency's own name, as on the client list —
    // without it this page alone read "Dashboard". Never throws.
    getAgencySettings(session!.agencyId),
  ]);

  // Said on the form before anyone presses Send, not discovered afterwards.
  const mail = emailConfig();
  const emailReady = Boolean(mail && !senderProblem(mail.from));

  return (
    <AgencyShell session={session} brandName={agency.agencyName}>
      <main className="mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <PageTitle
          title="Users &amp; access"
          subtitle={`${users.length} ${users.length === 1 ? "person" : "people"} with a login`}
        />

        <UsersManager
          /*
           * 🔴 The form's options come from the SAME rule the API enforces.
           *
           * They used to be hardcoded to `["client", "staff"]`, which for an
           * agency operator meant the only non-client button was a role
           * `assignableRoles` forbids — so it 403'd every time — and the
           * `agency` role they ARE allowed to hand out could not be reached at
           * all. A form that offers a button which always fails is worse than
           * one that omits it.
           */
          assignable={assignableRoles(session!.role)}
          currentUserId={session!.userId}
          emailReady={emailReady}
          users={users.map((u) => ({
            id: u.id,
            email: u.email,
            role: u.role,
            name: u.name,
            status: u.status,
            pending: u.pending,
            lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
            createdAt: u.createdAt.toISOString(),
            clients: u.clients,
          }))}
          clients={clientRows
            .filter((c) => c.status !== "archived")
            .map((c) => ({ id: c.id, name: c.name, slug: c.slug }))}
        />
      </main>
    </AgencyShell>
  );
}
