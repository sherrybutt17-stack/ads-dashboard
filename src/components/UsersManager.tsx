"use client";

import type { UserRole } from "@/db/schema";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { DASH } from "@/lib/metrics/compute";

interface ClientOpt {
  id: string;
  name: string;
  slug: string;
}

export interface UserRow {
  id: string;
  email: string;
  /**
   * Type-only import, which the bundler erases — so this stays tied to the
   * database enum without dragging the schema into the browser. See
   * `client-bundle.test.ts`, which enforces exactly that distinction.
   */
  role: UserRole;
  name: string | null;
  status: "active" | "disabled";
  /** Invited and not yet set up. */
  pending: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  clients: Array<{ id: string; name: string; slug: string }>;
}

/** What `/api/users` and `/api/users/[id]/invite` hand back — `IssuedLink`. */
interface IssuedLink {
  kind: "invite" | "password";
  url: string;
  expiresAt: string;
  /** "7 days", "24 hours" — from the server, so it matches the email. */
  lifetime: string;
  emailed: boolean;
  emailProblem: string | null;
}

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;

/**
 * The roles the invite form offers, narrowest first.
 *
 * A constant rather than the enum's own order, because the enum is ordered by
 * when each value was added and the form should read from least to most
 * privilege. Roles the caller may not assign are filtered out, never disabled —
 * a greyed button invites a support question about a permission the operator
 * cannot be granted.
 *
 * `staff` is left out on purpose. It is the pre-tenancy name for exactly what
 * `superadmin` means today — every check treats the two alike — and it is on
 * its way out of the codebase. Offering both asks the operator a question with
 * no answer. Existing `staff` logins still show and work.
 */
const ROLE_ORDER: UserRole[] = ["client", "agency", "superadmin"];

const ROLE_HELP: Record<UserRole, string> = {
  client: "Sees only the dashboards you pick. Can't change any setup.",
  agency:
    "Runs your agency: every client, connections, setup and the client logins.",
  superadmin:
    "Everything, for every agency on this deployment, including the audit log and other admins.",
  staff: "Legacy full access — the same as Superadmin.",
};

/** Only a `client` login is scoped to named dashboards; every other role is not. */
function needsClients(role: UserRole): boolean {
  return role === "client";
}

export function UsersManager({
  users,
  clients,
  assignable,
  currentUserId,
  emailReady,
}: {
  users: UserRow[];
  clients: ClientOpt[];
  /**
   * Which roles this operator may hand out — from `assignableRoles`. Also who
   * they may MANAGE: the server applies the same rule (`mayAdminister`), so a
   * row whose role is not in here gets no action buttons that would only 403.
   */
  assignable: UserRole[];
  /** To mark "you" and withhold the buttons that would lock you out. */
  currentUserId: string;
  /** Whether invites can go by email at all, so the form can say so up front. */
  emailReady: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const roleOptions = ROLE_ORDER.filter((r) => assignable.includes(r));
  /*
   * On the shared password, nobody on the team has a login yet — and until one
   * does, any invite but your own is a step towards being locked out (see
   * `countActivatedOperators`). So that session starts on the WIDEST role, the
   * one you need for yourself. Everyone else starts on the narrowest, so the
   * safest option is the one a distracted operator submits.
   */
  const firstRun = currentUserId === "shared";
  const defaultRole: UserRole =
    (firstRun ? roleOptions[roleOptions.length - 1] : roleOptions[0]) ?? "client";
  const [role, setRole] = useState<UserRole>(defaultRole);
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Errors from a row's buttons, shown beside the list rather than in the form.
  const [rowMsg, setRowMsg] = useState<string | null>(null);
  // The row whose link is being made. One at a time: a second click would
  // rotate the invite again and kill the link the first click is fetching.
  const [linking, setLinking] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; link: IssuedLink } | null>(
    null,
  );

  function toggleClient(id: string) {
    setClientIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function invite() {
    setBusy(true);
    setMsg(null);
    setIssued(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name: name || undefined,
          role,
          clientIds: needsClients(role) ? clientIds : undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.link) {
        setIssued({ email: body.user?.email ?? email, link: body.link });
        setEmail("");
        setName("");
        setClientIds([]);
        // Back to the narrowest role, or the next invite inherits "Superadmin".
        setRole(roleOptions[0] ?? "client");
        router.refresh();
      } else if (res.ok) {
        setMsg({ ok: false, text: "The login was made, but no link came back. Use “New invite link” on it below." });
        router.refresh();
      } else {
        setMsg({ ok: false, text: body?.error ?? "Couldn't send the invite." });
      }
    } catch {
      setMsg({ ok: false, text: "Couldn't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  async function sendLink(u: UserRow) {
    if (linking) return;
    if (
      !u.pending &&
      !confirm(
        `Send ${u.email} a link to choose a new password? Their current password keeps working until they use it.`,
      )
    )
      return;
    setRowMsg(null);
    setIssued(null);
    setLinking(u.id);
    try {
      const res = await fetch(`/api/users/${u.id}/invite`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.link) {
        setIssued({ email: u.email, link: body.link });
        // Scrolled to, because the panel renders above the list the click was in.
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        setRowMsg(body?.error ?? "Couldn't create a link.");
      }
      router.refresh();
    } catch {
      setRowMsg("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setLinking(null);
    }
  }

  async function toggleStatus(u: UserRow) {
    const res = await fetch(`/api/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: u.status === "active" ? "disabled" : "active",
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setRowMsg(body?.error ?? "Couldn't change that login.");
    }
    router.refresh();
  }

  async function remove(u: UserRow) {
    if (!confirm(`Remove ${u.email}? They will lose access immediately.`))
      return;
    const res = await fetch(`/api/users/${u.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setRowMsg(body?.error ?? "Couldn't remove that login.");
    }
    router.refresh();
  }

  const canInvite =
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) &&
    // Only a client login needs dashboards picked. Keying this off `!== "staff"`
    // made the agency and superadmin roles unsubmittable, because there is no
    // client list to satisfy for a role that is not scoped to one.
    (!needsClients(role) || clientIds.length > 0);

  return (
    <div className="flex flex-col gap-5">
      {issued && (
        <LinkPanel
          email={issued.email}
          link={issued.link}
          onClose={() => setIssued(null)}
        />
      )}

      {firstRun && (
        <section
          className="card p-4 text-[13px] leading-relaxed"
          style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
        >
          <strong style={{ color: "var(--text-primary)" }}>
            You&rsquo;re signed in with the temporary shared password.
          </strong>{" "}
          Invite yourself first as <strong>Superadmin</strong>, open your link and
          choose your password. The shared password stops working as soon as
          someone on the team has set up a login — so do yours before anyone
          else&rsquo;s, and keep your link until you have used it.
        </section>
      )}

      {/* Invite */}
      <section className="card p-5">
        <h2
          className="text-sm font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          Invite someone
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
          They get a link to choose their own password, so you never send or see
          one.{" "}
          {emailReady
            ? "We email them the link, and show it here too in case the email doesn't arrive."
            : "Email isn't set up yet, so you'll get the link here to send them yourself."}
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="name@company.com"
          />
          <Field
            label="Name (optional)"
            value={name}
            onChange={setName}
            placeholder="Jane Smith"
          />
        </div>

        <div className="mt-3">
          <span
            className="text-[11px] font-medium tracking-wider uppercase"
            style={{ color: "var(--text-muted)" }}
          >
            Role
          </span>
          <div className="mt-1 flex flex-wrap gap-2">
            {roleOptions.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                aria-pressed={role === r}
                className="rounded-[8px] border px-3 py-1.5 text-[13px] font-medium capitalize"
                style={{
                  borderColor:
                    role === r ? "var(--series-1)" : "var(--border-strong)",
                  background: role === r ? "var(--series-1)" : "transparent",
                  color: role === r ? "#fff" : "var(--text-secondary)",
                }}
              >
                {r}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
            {ROLE_HELP[role]}
          </p>
        </div>

        {needsClients(role) && (
          <div className="mt-3">
            <span
              className="text-[11px] font-medium tracking-wider uppercase"
              style={{ color: "var(--text-muted)" }}
            >
              Dashboards this login can see
            </span>
            {clients.length === 0 ? (
              <p
                className="mt-1 text-xs"
                style={{ color: "var(--status-warning)" }}
              >
                No clients yet — add a client first, then invite their login.
              </p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-2">
                {clients.map((c) => {
                  const on = clientIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleClient(c.id)}
                      aria-pressed={on}
                      className="rounded-full border px-3 py-1 text-[13px]"
                      style={{
                        borderColor: on
                          ? "var(--series-1)"
                          : "var(--border-strong)",
                        background: on
                          ? "color-mix(in srgb, var(--series-1) 16%, transparent)"
                          : "transparent",
                        color: on
                          ? "var(--text-primary)"
                          : "var(--text-secondary)",
                      }}
                    >
                      {on ? "✓ " : ""}
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={invite}
          disabled={busy || !canInvite}
          className="mt-4 rounded-[8px] px-3 py-2 text-[13px] font-medium btn-accent disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send invite"}
        </button>

        {msg && (
          <p
            className="mt-3 text-xs"
            style={{
              color: msg.ok ? "var(--delta-good)" : "var(--status-critical)",
            }}
          >
            {msg.text}
          </p>
        )}
      </section>

      {/* List */}
      <section className="card overflow-hidden">
        <div className="px-5 py-4">
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            Logins ({users.length})
          </h2>
          {rowMsg && (
            <p className="mt-1 text-xs" style={{ color: "var(--status-critical)" }}>
              {rowMsg}
            </p>
          )}
        </div>
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
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Dashboards</Th>
                <Th>Last login</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === currentUserId;
                const manageable = assignable.includes(u.role);
                return (
                  <tr
                    key={u.id}
                    className="border-t"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <td className="px-4 py-2.5">
                      <div style={{ color: "var(--text-primary)" }}>
                        {u.email}
                        {self && (
                          <span
                            className="ml-1.5 text-[11px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            (you)
                          </span>
                        )}
                      </div>
                      {u.name && (
                        <div
                          className="text-[11px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {u.name}
                        </div>
                      )}
                      {u.pending && u.status === "active" && (
                        <Badge tone="var(--status-warning)">invited — not set up yet</Badge>
                      )}
                      {u.status === "disabled" && (
                        <Badge tone="var(--status-critical)">disabled</Badge>
                      )}
                    </td>
                    <td
                      className="px-4 py-2.5 capitalize"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {u.role}
                    </td>
                    <td
                      className="px-4 py-2.5"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {/*
                        An operator role is not scoped to named dashboards, so it
                        sees the whole book. Reading `=== "staff"` showed an
                        agency admin a bare dash here — which renders as "access
                        to nothing" for someone who in fact sees everything.
                      */}
                      {!needsClients(u.role)
                        ? "All"
                        : u.clients.length === 0
                          ? DASH
                          : u.clients.map((c) => c.name).join(", ")}
                    </td>
                    <td
                      className="px-4 py-2.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {u.lastLoginAt
                        ? new Date(u.lastLoginAt).toLocaleDateString("en-US", {
                            timeZone: "UTC",
                            month: "short",
                            day: "numeric",
                          })
                        : "never"}
                    </td>
                    <td className="px-4 py-2.5">
                      {manageable ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                          {u.status === "active" && (
                            <button
                              onClick={() => sendLink(u)}
                              disabled={linking !== null}
                              className="hover:underline disabled:opacity-50"
                              style={{ color: "var(--text-secondary)" }}
                            >
                              {linking === u.id
                                ? "Creating…"
                                : u.pending
                                  ? "New invite link"
                                  : "Send password link"}
                            </button>
                          )}
                          {/* Nobody disables or removes themselves — see the route. */}
                          {!self && (
                            <>
                              <button
                                onClick={() => toggleStatus(u)}
                                className="hover:underline"
                                style={{ color: "var(--text-secondary)" }}
                              >
                                {u.status === "active" ? "Disable" : "Enable"}
                              </button>
                              <button
                                onClick={() => remove(u)}
                                className="hover:underline"
                                style={{ color: "var(--status-critical)" }}
                              >
                                Remove
                              </button>
                            </>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                          {DASH}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-sm"
                    style={{ color: "var(--text-muted)" }}
                  >
                    No logins yet. Invite yourself first, above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/**
 * The link just minted, to copy — and whether the email went.
 *
 * Shown even when the email was sent: the invitee may say it never arrived,
 * and the operator can then paste the same link into a chat. It carries no
 * password, works once, and expires, which is the whole difference from what
 * used to be pasted there.
 */
function LinkPanel({
  email,
  link,
  onClose,
}: {
  email: string;
  link: IssuedLink;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const what = link.kind === "invite" ? "invite" : "password link";

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      // Clipboard is permission-gated in some contexts. The URL is on screen
      // and selectable, so this is a convenience failing, not the feature.
    }
  }

  return (
    <section
      className="card p-5"
      style={{
        borderColor: link.emailed ? "var(--delta-good)" : "var(--status-warning)",
      }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {link.emailed
              ? `${link.kind === "invite" ? "Invite" : "Password link"} emailed to ${email}`
              : `Send this ${what} to ${email}`}
          </h2>
          {link.emailProblem && (
            <p className="mt-1 text-xs" style={{ color: "var(--status-warning)" }}>
              {link.emailProblem} Copy the link below and send it to them on
              WhatsApp, Slack or your own email.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs hover:underline"
          style={{ color: "var(--text-muted)" }}
        >
          Done
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          readOnly
          value={link.url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Invite link"
          className="min-w-0 flex-1 rounded-[8px] border px-3 py-2 font-mono text-[12px]"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={copy}
          className="btn-accent rounded-[8px] px-3 py-2 text-[13px] font-medium"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
        Works once, for {link.lifetime}. It lets them choose their own password — you
        never see it. Anyone holding the link can use it, so send it only to{" "}
        {email}.
        {link.kind === "invite" && " Sending a new invite link kills this one."}
      </p>
    </section>
  );
}

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className="mt-0.5 mr-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        background: `color-mix(in srgb, ${tone} 16%, transparent)`,
        color: tone,
      }}
    >
      {children}
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span
        className="text-[11px] font-medium tracking-wider uppercase"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
        style={inputStyle}
      />
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left text-[11px] font-semibold tracking-wider uppercase">
      {children}
    </th>
  );
}
