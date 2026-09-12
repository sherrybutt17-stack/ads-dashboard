"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Let a client go.
 *
 * Two shapes, one implementation. `panel` is the block at the foot of the setup
 * page; `row` is the small control on the client list, added because the only
 * way to remove a client was to open that client's setup page and scroll to the
 * bottom of it — so in practice dead clients simply stayed, reading red on the
 * list forever and training everyone to ignore a red badge.
 *
 * 🔴 It archives, and the copy says so. `stage_transitions` is the append-only
 * system of record and GoHighLevel has no stage-history API, so a hard delete
 * would destroy funnel history nothing can rebuild. Everything that touches the
 * client's systems IS disconnected: the GHL install, every ad account on every
 * platform with its stored credential, and any login left with no dashboard.
 */
export function RemoveClient({
  clientId,
  clientName,
  variant = "panel",
}: {
  clientId: string;
  clientName: string;
  variant?: "panel" | "row";
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
        // From the list we are already where we want to be; pushing "/" again
        // would leave the removed row on screen until something else refreshed.
        if (variant === "panel") router.push("/");
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

  if (variant === "row") {
    return (
      <div className="flex items-center gap-2">
        {msg && (
          <span className="text-xs" style={{ color: "var(--status-critical)" }}>
            {msg}
          </span>
        )}
        <button
          onClick={remove}
          disabled={busy}
          aria-label={`Remove ${clientName}`}
          className="rounded-[7px] border px-2 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
          style={{ color: "var(--status-critical)", borderColor: "var(--border)" }}
        >
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
    );
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
