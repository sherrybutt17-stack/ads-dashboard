import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser, isStaff } from "@/lib/auth";
import { listUsers } from "@/lib/users";
import { listClients } from "@/lib/clients";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UsersManager } from "@/components/UsersManager";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await getSessionUser();
  if (!isStaff(session)) redirect("/");

  const [users, clientRows] = await Promise.all([listUsers(), listClients()]);

  return (
    <div className="min-h-full">
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-[1100px] items-center gap-3 px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <Link
              href="/"
              className="text-xs hover:underline"
              style={{ color: "var(--text-muted)" }}
            >
              ← Clients
            </Link>
            <h1 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
              Users &amp; access
            </h1>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6">
        <UsersManager
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
    </div>
  );
}
