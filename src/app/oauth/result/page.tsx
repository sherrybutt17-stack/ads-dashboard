import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pipelineStages } from "@/db/schema";
import { getClientBySlug } from "@/lib/clients";
import { ThemeToggle } from "@/components/ThemeToggle";

export const dynamic = "force-dynamic";

/**
 * Post-OAuth landing page.
 *
 * The install callback redirects here so the operator always sees a clear
 * success/failure state with next steps — never a bare redirect or a blank
 * screen, which is exactly how a failed install used to present.
 */
export default async function OAuthResultPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    slug?: string;
    location?: string;
    message?: string;
  }>;
}) {
  const sp = await searchParams;
  const ok = sp.status === "success";
  const slug = sp.slug || null;
  const location = sp.location || null;
  const message =
    sp.message || "The connection didn’t complete. No changes were saved.";

  let clientName: string | null = null;
  let stageCount = 0;
  let unmapped = 0;
  if (ok && slug) {
    const client = await getClientBySlug(slug);
    if (client) {
      clientName = client.name;
      const stages = await db
        .select({ canonical: pipelineStages.canonicalStage })
        .from(pipelineStages)
        .where(eq(pipelineStages.clientId, client.id));
      stageCount = stages.length;
      unmapped = stages.filter((s) => !s.canonical).length;
    }
  }

  const accent = ok ? "var(--status-good)" : "var(--status-critical)";

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--surface-page)" }}
    >
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-[900px] items-center justify-end px-4 py-4 sm:px-6">
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex max-w-[520px] flex-col items-center px-4 pt-16 sm:pt-24">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-full"
          style={{
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 45%, transparent)`,
          }}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
            {ok ? (
              <path
                d="M5 12.5l4.2 4.2L19 7"
                stroke={accent}
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <>
                <path
                  d="M12 7v6"
                  stroke={accent}
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="17" r="1.4" fill={accent} />
              </>
            )}
          </svg>
        </div>

        <h1
          className="mt-6 text-center text-[22px] font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          {ok ? "GoHighLevel connected" : "Connection didn’t finish"}
        </h1>

        {ok ? (
          <div className="mt-2 text-center">
            <p style={{ color: "var(--text-secondary)" }}>
              {clientName ?? "This client"} is now wired to GoHighLevel. New
              leads and stage changes will stream in from here.
            </p>
            {location && (
              <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
                Sub-account: <strong>{location}</strong>
              </p>
            )}
          </div>
        ) : (
          <p
            className="mt-2 max-w-[420px] text-center"
            style={{ color: "var(--text-secondary)" }}
          >
            {message}
          </p>
        )}

        {/* Detail card */}
        <div
          className="card mt-8 w-full p-5"
          style={{ borderColor: "var(--border)" }}
        >
          {ok ? (
            <ul className="flex flex-col gap-3 text-sm">
              <Row label="Pipeline stages imported" value={`${stageCount}`} />
              {unmapped > 0 && (
                <Row
                  label="Stages still needing a mapping"
                  value={`${unmapped}`}
                  warn
                />
              )}
              <Row label="Live webhook" value="Receiving events" good />
            </ul>
          ) : (
            <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
              <p
                className="mb-2 font-medium"
                style={{ color: "var(--text-primary)" }}
              >
                What to try
              </p>
              <ul className="flex list-disc flex-col gap-1.5 pl-4">
                <li>
                  Make sure you’re logged into your GoHighLevel agency account in
                  this browser, then start the install again.
                </li>
                <li>
                  Start it from <strong>Setup → Install on a sub-account</strong>{" "}
                  in this app (not from GHL’s marketplace) so the secure hand-off
                  matches.
                </li>
                <li>
                  If the app is still in draft, add the sub-account as a test
                  location in the GHL app settings, then retry.
                </li>
              </ul>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row">
          {ok && slug ? (
            <>
              <Link
                href={`/c/${slug}/setup`}
                className="flex-1 rounded-[10px] px-4 py-2.5 text-center text-[14px] font-medium text-white"
                style={{ background: "var(--accent)" }}
              >
                {unmapped > 0 ? "Map stages & finish setup" : "Finish setup"}
              </Link>
              <Link
                href={`/c/${slug}`}
                className="flex-1 rounded-[10px] border px-4 py-2.5 text-center text-[14px] font-medium"
                style={{
                  borderColor: "var(--border-strong)",
                  color: "var(--text-secondary)",
                }}
              >
                Go to dashboard
              </Link>
            </>
          ) : ok ? (
            <Link
              href="/"
              className="flex-1 rounded-[10px] px-4 py-2.5 text-center text-[14px] font-medium text-white"
              style={{ background: "var(--accent)" }}
            >
              Back to clients
            </Link>
          ) : (
            <>
              <Link
                href={slug ? `/c/${slug}/setup` : "/"}
                className="flex-1 rounded-[10px] px-4 py-2.5 text-center text-[14px] font-medium text-white"
                style={{ background: "var(--accent)" }}
              >
                Back to setup
              </Link>
              <Link
                href="/"
                className="flex-1 rounded-[10px] border px-4 py-2.5 text-center text-[14px] font-medium"
                style={{
                  borderColor: "var(--border-strong)",
                  color: "var(--text-secondary)",
                }}
              >
                All clients
              </Link>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Row({
  label,
  value,
  good,
  warn,
}: {
  label: string;
  value: string;
  good?: boolean;
  warn?: boolean;
}) {
  const color = good
    ? "var(--status-good)"
    : warn
      ? "var(--status-warning)"
      : "var(--text-primary)";
  return (
    <li className="flex items-center justify-between">
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="font-semibold tabular-nums" style={{ color }}>
        {value}
      </span>
    </li>
  );
}
