import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getClientForSession } from "@/lib/clients";
import { getSessionUser, canAccessSlug, isAgencyOperator } from "@/lib/auth";
import { getClientBranding } from "@/lib/branding-store";
import { ClientBrandingForm } from "@/components/ClientBrandingForm";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";

/**
 * A client's own branding page — W3.
 *
 * Reachable by client-role users, unlike `/c/[slug]/setup`, which the proxy
 * bounces them away from. That is the whole point: this is the one settings
 * surface a client owns.
 *
 * The page renders whether or not the agency has enabled editing. A client who
 * cannot find the setting concludes the product does not have it and asks for a
 * feature that already exists; one who can see it greyed out with a sentence
 * explaining why asks the right question instead.
 */
export default async function ClientBrandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  /*
   * Scoped read, then the grant check. `getClientForSession` already applies
   * both the tenant and — for a client-role login — the slug grant, so a
   * client belonging to another agency is `null` here and renders the same
   * 404 as one that does not exist. `canAccessSlug` below is kept as the
   * redirect-to-home behaviour for a signed-in user hitting a slug they do
   * not hold, which is a nicer landing than a bare not-found.
   */
  const client = await getClientForSession(await getSessionUser(), slug);
  if (!client) notFound();

  const session = await getSessionUser();
  if (!canAccessSlug(session, slug)) redirect("/");
  const staff = isAgencyOperator(session);

  const branding = await getClientBranding(client.id);

  return (
    <div className="min-h-full">
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-[720px] items-center gap-3 px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <Link
              href={`/c/${slug}`}
              className="inline-flex items-center gap-1 text-xs hover:underline"
              style={{ color: "var(--text-muted)" }}
            >
              <Icon name="arrowLeft" size={12} /> {branding.displayName ?? client.name}
            </Link>
            <h1
              className="text-lg font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              Branding
            </h1>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex max-w-[720px] flex-col gap-5 px-4 py-6 sm:px-6">
        <ClientBrandingForm
          slug={slug}
          clientName={client.name}
          initial={branding}
          /*
           * Staff are never read-only here — the `clientEditable` switch exists
           * to restrain the client, not the agency, and the server enforces the
           * same rule (see `authorizeClientBrandingWrite`). This flag only
           * decides what the form looks like.
           */
          readOnly={!staff && !branding.clientEditable}
        />

        {staff && (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            You are seeing this as staff. Whether the client can edit it
            themselves is set on{" "}
            <Link
              href={`/c/${slug}/setup`}
              className="underline underline-offset-2"
              style={{ color: "var(--text-secondary)" }}
            >
              the setup page
            </Link>
            .
          </p>
        )}
      </main>
    </div>
  );
}
