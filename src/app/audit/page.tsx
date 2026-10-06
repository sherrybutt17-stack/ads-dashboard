import type { CSSProperties } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listAuditEntries, type AuditView } from "@/lib/audit";
import { getSessionUser, isAgencyOperator } from "@/lib/auth";
import { DASH } from "@/lib/metrics/compute";
import { AgencyShell } from "@/components/AgencyShell";
import { PageTitle } from "@/components/PageTitle";
import { getAgencySettings } from "@/lib/branding-store";

export const dynamic = "force-dynamic";

const CATEGORIES = [
  { key: "", label: "All" },
  { key: "auth", label: "Auth" },
  { key: "client", label: "Clients" },
  { key: "meta_account", label: "Meta" },
  { key: "google_account", label: "Google" },
] as const;

/** Map an action to a display label + a severity tone for its pill. */
function eventTone(action: string): {
  tone: "neutral" | "warning" | "critical";
} {
  if (action === "auth.login_failed" || action === "auth.rate_limited") {
    return { tone: "critical" };
  }
  if (
    action === "client.token_change" ||
    action.endsWith(".remove") ||
    action === "client.archive"
  ) {
    return { tone: "warning" };
  }
  return { tone: "neutral" };
}

/**
 * The critical pill is a .tint-badge — critical ink on a wash of itself, which
 * only stays readable because the class derives the ink rather than reusing the
 * raw token. The other two put --text-secondary on their ground, so they are
 * ordinary fills and keep their own styles.
 */
function pill(tone: "neutral" | "warning" | "critical"): {
  className: string;
  style: CSSProperties;
} {
  if (tone === "critical") {
    return {
      className: "tint-badge",
      style: { "--tint": "var(--status-critical)" } as CSSProperties,
    };
  }
  if (tone === "warning") {
    return {
      className: "",
      style: {
        background: "color-mix(in srgb, var(--status-warning) 20%, transparent)",
        color: "var(--text-secondary)",
      },
    };
  }
  return {
    className: "",
    style: { background: "var(--surface-2)", color: "var(--text-secondary)" },
  };
}

function fmtUtc(at: Date): string {
  return (
    at.toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " UTC"
  );
}

function metaSummary(m: unknown): string | null {
  if (!m || typeof m !== "object") return null;
  const obj = m as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(obj.fields) && obj.fields.length) {
    parts.push(obj.fields.join(", "));
  }
  if (obj.hasTokenOverride === true) parts.push("token override");
  if (obj.tokenChanged === true) parts.push("token rotated");
  if (typeof obj.name === "string") parts.push(obj.name);
  if (typeof obj.slug === "string") parts.push(`/${obj.slug}`);
  return parts.length ? parts.join(" · ") : null;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>;
}) {
  /*
   * Open to the agency tier since `audit_log.agency_id` exists (0024).
   *
   * The guard here is only the ROLE test — "does this person run an agency" —
   * and it is deliberately not the whole check. Which rows they see is decided
   * in `listAuditEntries`, from the session, in SQL. A page that filtered by
   * tenant itself would be one copy of the rule per page.
   */
  const session = await getSessionUser();
  if (!isAgencyOperator(session)) redirect("/");

  const { cat } = await searchParams;
  const category = CATEGORIES.some((c) => c.key === cat) ? (cat ?? "") : "";
  const [entries, agency] = await Promise.all([
    listAuditEntries(session, { category: category || undefined }),
    // The sidebar wears the agency's own name, as on the client list.
    getAgencySettings(session!.agencyId),
  ]);

  return (
    <AgencyShell session={session} brandName={agency.agencyName}>
      <main className="mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <PageTitle title="Audit log" subtitle="Times are UTC" />

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {CATEGORIES.map((c) => {
            const active = category === c.key;
            return (
              <Link
                key={c.key || "all"}
                href={c.key ? `/audit?cat=${c.key}` : "/audit"}
                aria-current={active ? "page" : undefined}
                className="chip font-medium"
              >
                {c.label}
              </Link>
            );
          })}
          <span
            className="ml-auto text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            {entries.length} event{entries.length === 1 ? "" : "s"} · newest
            first
          </span>
        </div>

        {entries.length === 0 ? (
          <div
            className="rounded-[var(--radius-lg)] border border-dashed p-10 text-center text-sm"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            No events recorded yet in this category.
          </div>
        ) : (
          <section className="card overflow-hidden">
            <div
              className="table-scroll border-t"
              style={{ borderColor: "var(--border)" }}
            >
              <table className="w-full text-[13px]">
                <thead>
                  <tr
                    style={{
                      background: "var(--surface-2)",
                      color: "var(--text-muted)",
                    }}
                  >
                    <Th>Time</Th>
                    <Th>Event</Th>
                    <Th>Target</Th>
                    <Th>Client</Th>
                    <Th>Source IP</Th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <Row key={e.id} e={e} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
          Times are UTC. Showing the {entries.length} most recent entries.
        </p>
      </main>
    </AgencyShell>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left text-[11px] font-semibold tracking-wider uppercase">
      {children}
    </th>
  );
}

function Row({ e }: { e: AuditView }) {
  const { tone } = eventTone(e.action);
  const meta = metaSummary(e.metadata);
  return (
    <tr className="border-t" style={{ borderColor: "var(--border)" }}>
      <td
        className="px-4 py-2.5 whitespace-nowrap tnum"
        style={{ color: "var(--text-muted)" }}
      >
        {fmtUtc(e.at)}
      </td>
      <td className="px-4 py-2.5">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${pill(tone).className}`}
          style={pill(tone).style}
        >
          {e.action}
        </span>
      </td>
      <td className="px-4 py-2.5" style={{ color: "var(--text-secondary)" }}>
        <div className="truncate">
          {e.targetType ? (
            <span style={{ color: "var(--text-muted)" }}>{e.targetType}: </span>
          ) : null}
          {e.targetId ?? DASH}
        </div>
        {meta && (
          <div
            className="truncate text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            {meta}
          </div>
        )}
      </td>
      <td className="px-4 py-2.5" style={{ color: "var(--text-secondary)" }}>
        {e.clientName ?? DASH}
      </td>
      <td
        className="px-4 py-2.5 tnum whitespace-nowrap"
        style={{ color: "var(--text-muted)" }}
      >
        {e.ip ?? DASH}
      </td>
    </tr>
  );
}
