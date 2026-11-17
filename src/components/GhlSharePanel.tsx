"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./Modal";
import { TagPicker } from "./TagMapping";
import type { SharePanelClient, SharePanelState } from "@/lib/ghl/share-panel";
import type { SharePreview } from "@/lib/ghl/share-actions";

/**
 * "Share this sub-account" — on the Connections page of the client that holds
 * a GoHighLevel connection.
 *
 * Growth Guild picks which other clients of the agency this sub-account also
 * feeds; the agency's own logins (and Growth Guild) pick the tag that marks
 * each client's leads. Each lead then counts on ONE dashboard. Nothing changes
 * until the before/after preview has been seen and confirmed, because every
 * past month is recounted too.
 */

interface Rules {
  clients: { clientId: string; tags: string[] }[];
  untagged: string | null;
  keepRemoved: boolean;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const muted: CSSProperties = { color: "var(--text-muted)" };
const secondaryButton: CSSProperties = { borderColor: "var(--border-strong)", color: "var(--text-secondary)" };
const inputStyle: CSSProperties = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
};

const NOT_ANSWERED = "Couldn't reach the server. Reload the page to see whether the change was saved.";

async function call<T>(url: string, method: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: data?.error ?? "That didn't work. Nothing was changed." };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: NOT_ANSWERED };
  }
}

function initialRules(state: SharePanelState): Rules {
  return {
    clients: state.clients.filter((c) => !c.archived).map((c) => ({ clientId: c.id, tags: c.tags })),
    untagged: state.untagged,
    keepRemoved: state.keepRemoved,
  };
}

export function GhlSharePanel({ clientId, state }: { clientId: string; state: SharePanelState }) {
  const router = useRouter();
  const shared = state.role === "holder";
  const [adding, setAdding] = useState<string>("");
  const [rules, setRules] = useState<Rules>(() => initialRules(state));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<{ kind: "link" | "tags"; data: SharePreview } | null>(null);
  const [stopping, setStopping] = useState<SharePanelClient | null>(null);

  const candidate = state.candidates.find((c) => c.id === adding && !c.blocked) ?? null;
  const live = state.clients.filter((c) => !c.archived);
  const holderName = state.holder?.name ?? "this client";

  /** Everyone the rules cover: the share's live clients, plus the one being added. */
  const people = useMemo(() => {
    const list = live.map((c) => ({ id: c.id, name: c.name, isHolder: c.isHolder }));
    if (candidate) list.push({ id: candidate.id, name: candidate.name, isHolder: false });
    return list;
  }, [live, candidate]);

  const tagsOf = (id: string) => rules.clients.find((c) => c.clientId === id)?.tags ?? [];
  const used = new Set(rules.clients.flatMap((c) => c.tags));
  const counts = new Map(state.tags.map((t) => [t.tag, t.contacts]));
  const available = state.tags.filter((t) => !used.has(t.tag));
  const edited = () => {
    setPreview(null);
    setMsg(null);
  };
  const setTags = (id: string, tags: string[]) => {
    edited();
    setRules((r) => {
      const others = r.clients.filter((c) => c.clientId !== id);
      return { ...r, clients: [...others, { clientId: id, tags }] };
    });
  };

  // The rules sent: only the people in this proposal.
  const proposal: Rules = {
    clients: people.map((p) => ({ clientId: p.id, tags: tagsOf(p.id) })),
    untagged: rules.untagged && people.some((p) => p.id === rules.untagged) ? rules.untagged : null,
    keepRemoved: rules.keepRemoved,
  };
  const wouldCount = (id: string) => tagsOf(id).length > 0 || proposal.untagged === id;

  /* ---------------- warnings, in place ---------------- */
  const warnings: string[] = [];
  for (const p of people) {
    for (const t of tagsOf(p.id)) {
      const share = state.totalContacts > 0 ? (counts.get(t) ?? 0) / state.totalContacts : 0;
      if (share >= 0.6) {
        warnings.push(
          `“${t}” is on ${Math.round(share * 100)}% of this sub-account's contacts, so almost every lead would count for ${p.name}.`,
        );
      }
      const marksPaid = state.clients.find(
        (c) => c.paidLeadTag.trim().toLowerCase() === t && (c.paidLeadFilter === "tagged" || c.paidLeadFilter === "either"),
      );
      if (marksPaid) {
        warnings.push(`“${t}” is the tag that marks paid leads for ${marksPaid.name}, so both businesses' leads probably carry it.`);
      }
    }
    if (!wouldCount(p.id)) warnings.push(`${p.name} has no tag yet, so no lead will count for it.`);
    const c = state.clients.find((x) => x.id === p.id);
    if (c?.alertsOn && tagsOf(p.id).length === 0) {
      warnings.push(
        `${p.name} has new-lead alerts on but no tag here, so its leads won't send alerts. Add the tag its leads carry.`,
      );
    }
  }
  if (proposal.untagged === null && rules.keepRemoved) {
    warnings.push(
      "Leads with no client's tag count for no one. For a lead hub, switch off “Keep a lead with its client after its tag is removed”.",
    );
  }

  /* ---------------- actions ---------------- */
  async function previewIt() {
    setBusy(true);
    setMsg(null);
    const r = candidate
      ? await call<{ preview: SharePreview }>(`/api/clients/${clientId}/ghl-share`, "POST", {
          targetId: candidate.id,
          rules: proposal,
          preview: true,
        })
      : await call<{ preview: SharePreview }>(`/api/clients/${clientId}/ghl-share/tags`, "POST", { rules: proposal });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setPreview({ kind: candidate ? "link" : "tags", data: r.data.preview });
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    if (preview.kind === "link" && candidate) {
      setProgress(`Copying leads to ${candidate.name}… this can take a minute.`);
      const r = await call<{ leads: number }>(`/api/clients/${clientId}/ghl-share`, "POST", {
        targetId: candidate.id,
        rules: proposal,
      });
      setProgress(null);
      setBusy(false);
      setPreview(null);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setMsg({
        ok: true,
        text: `Shared. ${candidate.name} now counts ${fmt(r.data.leads)} lead${r.data.leads === 1 ? "" : "s"} from the last 30 days.`,
      });
      setAdding("");
      router.refresh();
      return;
    }
    const r = await call<{ changed: number }>(`/api/clients/${clientId}/ghl-share/tags`, "PUT", {
      rules: proposal,
      version: state.version,
    });
    setBusy(false);
    setPreview(null);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setMsg({
      ok: true,
      text:
        r.data.changed > 0
          ? `Saved. ${fmt(r.data.changed)} lead${r.data.changed === 1 ? "" : "s"} changed client.`
          : "Saved. No lead changed client.",
    });
    router.refresh();
  }

  async function resplit() {
    setBusy(true);
    setMsg(null);
    const r = await call<{ changed: number }>(`/api/clients/${clientId}/ghl-share/tags`, "PATCH");
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setMsg({ ok: true, text: `Re-split done. ${fmt(r.data.changed)} lead${r.data.changed === 1 ? "" : "s"} changed client.` });
    router.refresh();
  }

  async function stop(member: SharePanelClient) {
    setBusy(true);
    const r = await call<{ holderOnly: boolean }>(`/api/clients/${clientId}/ghl-share`, "DELETE", { memberId: member.id });
    setBusy(false);
    setStopping(null);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setMsg({
      ok: true,
      text: r.data.holderOnly
        ? `Stopped sharing. ${holderName} counts every lead from this sub-account again.`
        : `Stopped sharing with ${member.name}.`,
    });
    router.refresh();
  }

  /* ---------------- not shared, agency login ---------------- */
  if (!shared && !state.canManage) {
    return (
      <p className="mt-4 text-xs" style={muted}>
        Does this sub-account also hold another client&apos;s leads? Ask Growth Guild to share it.
      </p>
    );
  }

  const editable = state.canEditTags && !busy;
  const showRules = shared || Boolean(candidate);
  const canAddMore = state.canManage && live.length < state.maxClients;

  return (
    <section className="mt-5 border-t pt-4" style={{ borderColor: "var(--border)" }} aria-label="Share this sub-account">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
          Share this sub-account
        </h3>
        {state.canManage && (
          <span
            className="tint-badge rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ "--tint": "var(--accent)" } as CSSProperties}
          >
            Growth Guild only
          </span>
        )}
      </div>

      {!shared && (
        <p className="mt-1 text-xs" style={muted}>
          Use this when this GoHighLevel sub-account also holds another client&apos;s leads. You pick the tag each
          client&apos;s leads carry, and each lead then counts for one client only.
        </p>
      )}

      {shared && (
        <div className="mt-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={muted}>
            Shared with
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {state.clients.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <span style={{ color: "var(--text-primary)" }}>
                  {c.name}
                  <span style={muted}>
                    {c.isHolder
                      ? " · holds the connection"
                      : c.archived
                        ? " · archived"
                        : c.since
                          ? ` · added ${new Date(c.since).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`
                          : ""}
                  </span>
                </span>
                {state.canManage && !c.isHolder && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setStopping(c)}
                    className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-[12px] font-medium disabled:opacity-50"
                    style={secondaryButton}
                  >
                    Stop sharing
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs" style={muted}>
            New contacts in the last 30 days:{" "}
            {live.map((c, i) => (
              <span key={c.id}>
                {i > 0 ? ", " : ""}
                {fmt(c.counted30)} count for {c.name}
              </span>
            ))}
            .
          </p>
          {!state.canManage && (
            <p className="mt-1 text-xs" style={muted}>
              Growth Guild manages which clients share this sub-account. You can change the tags.
            </p>
          )}
        </div>
      )}

      {(canAddMore || !shared) && state.canManage && (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          <span style={{ color: "var(--text-secondary)" }}>{shared ? "Add another client" : "Add a client"}</span>
          <select
            value={adding}
            disabled={busy}
            onChange={(e) => {
              edited();
              setAdding(e.target.value);
            }}
            className="min-w-[220px] max-w-full rounded-[var(--radius-sm)] border px-2 py-1.5 text-[13px]"
            style={inputStyle}
          >
            <option value="">Choose a client</option>
            {state.candidates.map((c) => (
              <option key={c.id} value={c.id} disabled={Boolean(c.blocked)}>
                {c.name}
                {c.blocked === "own_ghl" ? " (has its own GoHighLevel connection)" : ""}
                {c.blocked === "in_share" ? " (already shares a sub-account)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {showRules && (
        <div className="mt-4">
          <div className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
            Which client each lead counts for
          </div>
          <p className="text-xs" style={muted}>
            Pick the GoHighLevel tag that each client&apos;s leads carry. Each lead counts for one client, on that
            client&apos;s dashboard only.
          </p>

          <div className="mt-2 flex flex-col divide-y rounded-[var(--radius)] border" style={{ borderColor: "var(--border)" }}>
            {people.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="w-full min-w-0 text-[13px] font-medium sm:w-[190px] sm:shrink-0" style={{ color: "var(--text-primary)" }}>
                  {p.name}
                  {p.isHolder && <span className="block text-[11px] font-normal" style={muted}>holds the connection</span>}
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  {tagsOf(p.id).map((t) => (
                    <span
                      key={t}
                      className="tint-badge inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-[12px] font-medium"
                      style={{ "--tint": "var(--accent)" } as CSSProperties}
                    >
                      <span className="truncate">{t}</span>
                      <span className="tabular-nums" style={{ opacity: 0.75 }}>
                        {fmt(counts.get(t) ?? 0)}
                      </span>
                      {state.canEditTags && (
                        <button
                          type="button"
                          disabled={!editable}
                          onClick={() => setTags(p.id, tagsOf(p.id).filter((x) => x !== t))}
                          aria-label={`Remove ${t} from ${p.name}`}
                          className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  {state.canEditTags && (
                    <TagPicker
                      stageLabel={p.name}
                      tags={available}
                      disabled={!editable}
                      onPick={(tag) => setTags(p.id, [...tagsOf(p.id), tag])}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          <label className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <span style={{ color: "var(--text-secondary)" }}>Leads with no client&apos;s tag count for:</span>
            <select
              value={proposal.untagged ?? ""}
              disabled={!editable}
              onChange={(e) => {
                edited();
                setRules((r) => ({ ...r, untagged: e.target.value || null }));
              }}
              className="max-w-full rounded-[var(--radius-sm)] border px-2 py-1.5 text-[13px]"
              style={inputStyle}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="">No one (leave them off every dashboard)</option>
            </select>
          </label>

          <label className="mt-3 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={rules.keepRemoved}
              disabled={!editable}
              onChange={(e) => {
                edited();
                setRules((r) => ({ ...r, keepRemoved: e.target.checked }));
              }}
              className="mt-0.5"
            />
            <span>
              <span className="block text-[13px]" style={{ color: "var(--text-primary)" }}>
                Keep a lead with its client after its tag is removed
              </span>
              <span className="block text-xs" style={muted}>
                Leave this on if GoHighLevel workflows remove tags as leads move along. For a lead hub, switch it off,
                so a lead whose tag is removed goes back to the line above.
              </span>
            </span>
          </label>

          <ul className="mt-3 flex list-disc flex-col gap-0.5 pl-5 text-xs" style={muted}>
            <li>A lead counts for the client whose tag it has.</li>
            <li>
              A lead with two clients&apos; tags stays with the client it already counts for. A new lead with two tags
              counts for the client whose tag came first. If both came at once, it counts on the line above.
            </li>
            <li>
              With the switch on, a lead whose client&apos;s tag is removed stays with that client. To move a lead,
              replace its tag in GoHighLevel with the other client&apos;s tag.
            </li>
            <li>A person counts for one client, so all their cards and bookings count there, including older ones.</li>
            <li>New-lead alerts go out when a lead&apos;s tag arrives. Leads with no client&apos;s tag don&apos;t send an alert.</li>
            <li>Pipeline stages on this page also count for every client here, so they&apos;re mapped once, here.</li>
          </ul>

          {warnings.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-xs" style={{ color: "var(--status-warning)" }}>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          {state.canEditTags && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={previewIt}
                disabled={busy || (Boolean(candidate) ? !wouldCount(candidate!.id) : false)}
                className="btn-accent disabled:opacity-50"
              >
                {busy && !preview ? "Counting…" : "Preview the split"}
              </button>
              {shared && !candidate && (
                <button
                  type="button"
                  onClick={resplit}
                  disabled={busy}
                  className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
                  style={secondaryButton}
                >
                  Re-split now
                </button>
              )}
            </div>
          )}
          {candidate && !wouldCount(candidate.id) && (
            <p className="mt-2 text-xs" style={{ color: "var(--status-warning)" }}>
              Pick {candidate.name}&apos;s tag first, or give it the leads with no client&apos;s tag.
            </p>
          )}
        </div>
      )}

      {progress && (
        <p className="mt-3 text-xs" style={muted} role="status">
          {progress}
        </p>
      )}
      {msg && (
        <p
          className="mt-3 flex items-start gap-2 text-xs"
          style={{ color: msg.ok ? "var(--delta-good)" : "var(--status-critical)" }}
          role="status"
        >
          <span aria-hidden="true">{msg.ok ? "✓" : "✕"}</span>
          <span>{msg.text}</span>
        </p>
      )}

      {preview && (
        <PreviewDialog
          kind={preview.kind}
          data={preview.data}
          holderName={holderName}
          adding={candidate?.name ?? null}
          totalContacts={state.totalContacts}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPreview(null)}
        />
      )}

      {stopping && (
        <Modal
          open
          busy={busy}
          onClose={() => setStopping(null)}
          title={`Stop sharing with ${stopping.name}?`}
        >
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            {stopping.name} stops getting leads from this sub-account, and its copy of them is removed.{" "}
            {live.length > 2
              ? `The ${fmt(stopping.counted30)} new contacts it counts now go to the client their tags point to, or to the no-tag choice.`
              : `The ${fmt(stopping.counted30)} new contacts it counts now go back to ${holderName}.`}{" "}
            Past months are recounted. {holderName} keeps every lead.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn-accent disabled:opacity-50" disabled={busy} onClick={() => stop(stopping)}>
              {busy ? "Stopping…" : "Stop sharing"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setStopping(null)}
              className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium"
              style={secondaryButton}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function PreviewDialog({
  kind,
  data,
  holderName,
  adding,
  totalContacts,
  busy,
  onConfirm,
  onCancel,
}: {
  kind: "link" | "tags";
  data: SharePreview;
  holderName: string;
  adding: string | null;
  totalContacts: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const b = data.breakdown;
  const name = (id: string) => data.clients.find((c) => c.id === id)?.name ?? "another client";
  const tagged = b.byClient.filter((c) => c.tagged > 0);
  return (
    <Modal
      open
      busy={busy}
      onClose={onCancel}
      size="lg"
      title={kind === "link" && adding ? `Share ${holderName}'s sub-account with ${adding}?` : "Save these tags?"}
      description={kind === "link" ? `Sub-account: ${holderName} · ${fmt(totalContacts)} contacts` : undefined}
    >
      {kind === "link" && adding && (
        <p className="text-xs" style={muted}>
          {adding} starts with {holderName}&apos;s lead settings: the same pipeline stages, tag mapping and paid-lead rule.
        </p>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[13px]">
          <caption className="pb-1 text-left text-xs" style={muted}>
            Paid leads in the last {data.days} days, as each dashboard counts them
          </caption>
          <thead>
            <tr style={muted} className="text-left text-[11px] uppercase tracking-wide">
              <th className="py-1 pr-3 font-medium">Client</th>
              <th className="py-1 pr-3 text-right font-medium">Now</th>
              <th className="py-1 text-right font-medium">After</th>
            </tr>
          </thead>
          <tbody>
            {data.clients.map((c) => (
              <tr key={c.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                <td className="py-1.5 pr-3" style={{ color: "var(--text-primary)" }}>
                  {c.name}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(c.now)}</td>
                <td className="py-1.5 text-right font-medium tabular-nums">{fmt(c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="mt-3 flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
        <li>
          Of these {fmt(b.total)} lead{b.total === 1 ? "" : "s"},{" "}
          {tagged.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? (i === tagged.length - 1 && b.untagged === 0 ? " and " : ", ") : ""}
              {fmt(c.tagged)} {c.tagged === 1 ? "has" : "have"} {c.name}&apos;s tag
            </span>
          ))}
          {b.untagged > 0 && (
            <span>
              {tagged.length > 0 ? " and " : ""}
              {fmt(b.untagged)} {b.untagged === 1 ? "has" : "have"} no client&apos;s tag, so{" "}
              {b.untagged === 1 ? "it counts" : "they count"} for {b.untaggedTo?.name ?? "no one"}
            </span>
          )}
          .
        </li>
        {(data.twoTags.stays > 0 || data.twoTags.atOnce > 0) && (
          <li>
            {fmt(data.twoTags.stays + data.twoTags.atOnce)} have tags of two clients: {fmt(data.twoTags.stays)} stay
            with the client {data.twoTags.stays === 1 ? "it already counts" : "they already count"} for, and{" "}
            {fmt(data.twoTags.atOnce)} got both at once, so {data.twoTags.atOnce === 1 ? "it counts" : "they count"} for{" "}
            {b.untaggedTo?.name ?? "no one"}.
          </li>
        )}
        {data.kept > 0 && (
          <li>
            {fmt(data.kept)} lost their client’s tag and stay with that client.
          </li>
        )}
        {data.movedLate > 0 && (
          <li>
            {fmt(data.movedLate)} lead{data.movedLate === 1 ? "" : "s"} that arrived more than 30 days ago change
            client, and past bookings move with {data.movedLate === 1 ? "it" : "them"}.
          </li>
        )}
        {data.adMismatch.map((m) => (
          <li key={`${m.clientId}-${m.fromClientId}`}>
            {fmt(m.count)} of the leads that will count for {name(m.clientId)} came from {name(m.fromClientId)}&apos;s
            ads. Check their tags in GoHighLevel.
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs" style={muted}>
        Past months are recounted the same way, so reports you&apos;ve already sent won&apos;t match the dashboards.
        Nothing is deleted.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} disabled={busy} className="btn-accent disabled:opacity-50">
          {busy ? "Working…" : kind === "link" ? "Share and split leads" : "Save tags"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium"
          style={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
