"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ClientOpt {
  id: string;
  name: string;
  slug: string;
}

export interface UserRow {
  id: string;
  email: string;
  role: "staff" | "client";
  name: string | null;
  status: "active" | "disabled";
  lastLoginAt: string | null;
  createdAt: string;
  clients: Array<{ id: string; name: string; slug: string }>;
}

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;

export function UsersManager({
  users,
  clients,
}: {
  users: UserRow[];
  clients: ClientOpt[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"staff" | "client">("client");
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function toggleClient(id: string) {
    setClientIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function generate() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    setPassword(
      btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 14),
    );
  }

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name: name || undefined,
          password,
          role,
          clientIds: role === "client" ? clientIds : undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setMsg({
          ok: true,
          text: `Created. Share these credentials — ${email} / ${password}`,
        });
        setEmail("");
        setName("");
        setPassword("");
        setClientIds([]);
        router.refresh();
      } else {
        setMsg({ ok: false, text: body?.error ?? "Failed to create user" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(u: UserRow) {
    const pw = prompt(`New password for ${u.email} (min 8 characters):`);
    if (!pw) return;
    if (pw.length < 8) {
      alert("Password must be at least 8 characters.");
      return;
    }
    const res = await fetch(`/api/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (res.ok) alert(`Password updated. Share: ${u.email} / ${pw}`);
    router.refresh();
  }

  async function toggleStatus(u: UserRow) {
    await fetch(`/api/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: u.status === "active" ? "disabled" : "active" }),
    });
    router.refresh();
  }

  async function remove(u: UserRow) {
    if (!confirm(`Remove ${u.email}? They will lose access immediately.`)) return;
    await fetch(`/api/users/${u.id}`, { method: "DELETE" });
    router.refresh();
  }

  const canCreate =
    email.trim() !== "" &&
    password.length >= 8 &&
    (role === "staff" || clientIds.length > 0);

  return (
    <div className="flex flex-col gap-5">
      {/* Create */}
      <section className="card p-5">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Create a login
        </h2>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
          A client login sees only the dashboards you select. A staff login sees
          everything.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="client@brand.com" />
          <Field label="Name (optional)" value={name} onChange={setName} placeholder="Jane at Brand" />
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <Field
              label="Password"
              value={password}
              onChange={setPassword}
              placeholder="min 8 characters"
            />
          </div>
          <button
            type="button"
            onClick={generate}
            className="rounded-[8px] border px-3 py-2 text-[13px] font-medium"
            style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
          >
            Generate
          </button>
        </div>

        <div className="mt-3">
          <span
            className="text-[11px] font-medium tracking-wider uppercase"
            style={{ color: "var(--text-muted)" }}
          >
            Role
          </span>
          <div className="mt-1 flex gap-2">
            {(["client", "staff"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className="rounded-[8px] border px-3 py-1.5 text-[13px] font-medium capitalize"
                style={{
                  borderColor: role === r ? "var(--series-1)" : "var(--border-strong)",
                  background: role === r ? "var(--series-1)" : "transparent",
                  color: role === r ? "#fff" : "var(--text-secondary)",
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {role === "client" && (
          <div className="mt-3">
            <span
              className="text-[11px] font-medium tracking-wider uppercase"
              style={{ color: "var(--text-muted)" }}
            >
              Dashboards this login can see
            </span>
            {clients.length === 0 ? (
              <p className="mt-1 text-xs" style={{ color: "var(--status-warning)" }}>
                No clients yet — add a client first, then create their login.
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
                      className="rounded-full border px-3 py-1 text-[13px]"
                      style={{
                        borderColor: on ? "var(--series-1)" : "var(--border-strong)",
                        background: on
                          ? "color-mix(in srgb, var(--series-1) 16%, transparent)"
                          : "transparent",
                        color: on ? "var(--text-primary)" : "var(--text-secondary)",
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
          onClick={create}
          disabled={busy || !canCreate}
          className="mt-4 rounded-[8px] px-3 py-2 text-[13px] font-medium btn-accent disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create login"}
        </button>

        {msg && (
          <p
            className="mt-3 text-xs"
            style={{ color: msg.ok ? "var(--delta-good)" : "var(--status-critical)" }}
          >
            {msg.text}
          </p>
        )}
      </section>

      {/* List */}
      <section className="card overflow-hidden">
        <div className="px-5 py-4">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Logins ({users.length})
          </h2>
        </div>
        <div className="table-scroll border-t" style={{ borderColor: "var(--border)" }}>
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Dashboards</Th>
                <Th>Last login</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="px-4 py-2.5">
                    <div style={{ color: "var(--text-primary)" }}>{u.email}</div>
                    {u.name && (
                      <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                        {u.name}
                      </div>
                    )}
                    {u.status === "disabled" && (
                      <span
                        className="mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{
                          background: "color-mix(in srgb, var(--status-critical) 16%, transparent)",
                          color: "var(--status-critical)",
                        }}
                      >
                        disabled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 capitalize" style={{ color: "var(--text-secondary)" }}>
                    {u.role}
                  </td>
                  <td className="px-4 py-2.5" style={{ color: "var(--text-secondary)" }}>
                    {u.role === "staff"
                      ? "All"
                      : u.clients.length === 0
                        ? "—"
                        : u.clients.map((c) => c.name).join(", ")}
                  </td>
                  <td className="px-4 py-2.5" style={{ color: "var(--text-muted)" }}>
                    {u.lastLoginAt
                      ? new Date(u.lastLoginAt).toLocaleDateString("en-US", {
                          timeZone: "UTC",
                          month: "short",
                          day: "numeric",
                        })
                      : "never"}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      <button
                        onClick={() => resetPassword(u)}
                        className="hover:underline"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        Reset password
                      </button>
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
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-sm"
                    style={{ color: "var(--text-muted)" }}
                  >
                    No logins yet. Create one above.
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
