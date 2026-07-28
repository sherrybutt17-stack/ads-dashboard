"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RemoveClient({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function remove() {
    if (
      !confirm(
        `Remove ${clientName}?\n\nThis disconnects GoHighLevel and all ad accounts, and disables any client login that only had this dashboard. Funnel history is kept. The client is archived, not deleted.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        router.push("/");
        router.refresh();
      } else {
        setMsg(body?.error ?? "Failed to remove client");
        setBusy(false);
      }
    } catch {
      setMsg("Failed to remove client");
      setBusy(false);
    }
  }

  return (
    <section
      className="card p-5"
      style={{
        borderColor: "color-mix(in srgb, var(--status-critical) 40%, var(--border))",
      }}
    >
      <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        Remove this client
      </h2>
      <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
        Disconnects GoHighLevel and ad accounts, disables its client logins, and
        archives the client. Funnel history is retained — GoHighLevel cannot
        supply it again, so this is archive, not delete.
      </p>
      <button
        onClick={remove}
        disabled={busy}
        className="mt-3 rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
        style={{ background: "var(--status-critical)" }}
      >
        {busy ? "Removing…" : "Remove client"}
      </button>
      {msg && (
        <p className="mt-2 text-xs" style={{ color: "var(--status-critical)" }}>
          {msg}
        </p>
      )}
    </section>
  );
}
