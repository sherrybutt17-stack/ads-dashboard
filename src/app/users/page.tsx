import { redirect } from "next/navigation";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { listUsersForAgency } from "@/lib/users";
import { assignableRoles } from "@/lib/roles";
import { listClientsForSession } from "@/lib/clients";
import { UsersManager } from "@/components/UsersManager";
import { AgencyShell } from "@/components/AgencyShell";
import { PageTitle } from "@/components/PageTitle";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) redirect("/");

  const [users, clientRows] = await Promise.all([
    listUsersForAgency(session!.agencyId),
    listClientsForSession(session),
  ]);

  return (
    <AgencyShell session={session}>
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
          users={users.map((u) => ({
            id: u.id,
            email: u.email,
            role: u.role,
            name: u.name,
            status: u.status,
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
