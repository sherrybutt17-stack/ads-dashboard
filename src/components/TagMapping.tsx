"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { CANONICAL_STAGES, STAGE_LABELS, type CanonicalStage } from "@/lib/stages";

/**
 * "Map by tag" — the Connections page controls for counting a client's leads
 * from GoHighLevel tags instead of pipeline stages.
 *
 * Offered only where the server says (`tagMappingAllowed`: Reflexion Digital,
 * and test clients). Nothing here changes a number until the operator has seen
 * the before/after lead count and confirmed, because saving recounts every past
 * figure as well as future ones.
 */

export type CrmMode = "pipeline" | "tags";

interface TagCount {
  tag: string;
  contacts: number;
}

interface Mapping {
  tag: string;
  canonicalStage: CanonicalStage;
}

type PaidRule = { mode: "all" | "attributed" | "tagged" | "either"; tag: string };

interface Loaded {
  mode: CrmMode;
  everyContact: boolean;
  mappings: Mapping[];
  tags: TagCount[];
  paidRule: PaidRule;
}

interface Preview {
  days: number;
  pipeline: number;
  /** What the mapping on screen would count. */
  tags: number;
  /** What the saved tag mapping counts now — only for a client already on tags. */
  current: number | null;
}

/** What each step means, in the operator's words. */
const STEP_HINT: Partial<Record<CanonicalStage, string>> = {
  new_lead: "Any of these tags makes a contact a lead.",
  disqualified: "Still counted as a lead, then shown as not a real one.",
};

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;

const secondaryButton = {
  borderColor: "var(--border-strong)",
  color: "var(--text-secondary)",
} as const;

const fmt = (n: number) => n.toLocaleString("en-US");

/** The request never got an answer, so whether it saved is unknown. */
const NO_ANSWER =
  "Couldn't reach the server. Reload the page to see whether the change was saved.";

function errorText(body: unknown, fallback: string): string {
  const b = body as { error?: string } | null;
  return b?.error ?? fallback;
}

function paidRuleText(rule: PaidRule): string {
  const tag = `“${rule.tag}”`;
  switch (rule.mode) {
    case "either":
      return `For cost per lead, a lead counts as paid when it carries ${tag} or a Facebook campaign ID.`;
    case "attributed":
      return "For cost per lead, a lead counts as paid only when it carries a Facebook campaign ID.";
    case "tagged":
      return `For cost per lead, a lead counts as paid only when it carries ${tag}.`;
    default:
      return "For cost per lead, every lead counts as paid.";
  }
}

/* ------------------------------------------------------------------ */

/** "Count leads by: Pipeline stages | Tags" — which editor is showing. */
export function CountByControl({
  value,
  saved,
  onChange,
}: {
  value: CrmMode;
  saved: CrmMode;
  onChange: (mode: CrmMode) => void;
}) {
  const options: { id: CrmMode; label: string }[] = [
    { id: "pipeline", label: "Pipeline stages" },
    { id: "tags", label: "Tags" },
  ];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <span
        id="count-by-label"
        className="text-[11px] font-medium tracking-wider uppercase"
        style={{ color: "var(--text-muted)" }}
      >
        Count leads by
      </span>
      <div
        role="radiogroup"
        aria-labelledby="count-by-label"
        className="inline-flex rounded-[var(--radius-sm)] border p-0.5"
        style={{ borderColor: "var(--border-strong)" }}
      >
        {options.map((o) => {
          const on = value === o.id;
          return (
            <button
              key={o.id}
              id={`count-by-${o.id}`}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.id)}
              className={`rounded-[var(--radius-xs)] px-3 py-1.5 text-[13px] font-medium ${on ? "tint-badge" : ""}`}
              style={
                on
                  ? ({ "--tint": "var(--accent)" } as CSSProperties)
                  : { color: "var(--text-secondary)" }
              }
            >
              {o.label}
              {saved === o.id && (
                <span className="ml-1.5 text-[11px] font-normal" style={{ opacity: 0.8 }}>
                  · in use
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The before/after shown before anything is saved: paid leads over the last
 * 30 days, the way the dashboard counts them now and the way it would.
 */
function ConfirmSwitch({
  preview,
  target,
  savedMode,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: Preview;
  target: CrmMode;
  savedMode: CrmMode;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  /*
   * "Before" is always what the dashboard shows today. For a client already on
   * tags that is its saved tag count, not the pipeline's — otherwise removing
   * a lead tag could read as 5 → 12 while the dashboard really drops 92 → 12.
   */
  const editingTags = target === "tags" && savedMode === "tags";
  const tagsNow = preview.current ?? preview.tags;
  const from = target === "tags" ? (editingTags ? tagsNow : preview.pipeline) : tagsNow;
  const to = target === "tags" ? preview.tags : preview.pipeline;
  const fromLabel = target === "tags" ? (editingTags ? "by tags now" : "by pipeline stages") : "by tags";
  const toLabel = target === "tags" ? (editingTags ? "with this mapping" : "by tags") : "by pipeline stages";
  return (
    <div
      role="alertdialog"
      aria-labelledby="confirm-switch-title"
      className="mt-4 rounded-[var(--radius)] border p-4"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface-2)",
      }}
    >
      <p
        id="confirm-switch-title"
        className="text-[13px] font-semibold"
        style={{ color: "var(--text-primary)" }}
      >
        Paid leads in the last {preview.days} days
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums">
        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
          <strong className="text-[18px] font-semibold" style={{ color: "var(--text-primary)" }}>
            {fmt(from)}
          </strong>{" "}
          {fromLabel}
        </span>
        <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>
          →
        </span>
        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
          <strong className="text-[18px] font-semibold" style={{ color: "var(--text-primary)" }}>
            {fmt(to)}
          </strong>{" "}
          {toLabel}
        </span>
      </div>
      {editingTags && (
        <p className="mt-1 text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
          By pipeline stages it would be {fmt(preview.pipeline)}.
        </p>
      )}
      <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
        Past months are recounted the same way, so reports you have already sent
        won&apos;t match the dashboard. Share links show the new numbers straight away.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          id="confirm-switch"
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="btn-accent disabled:opacity-50"
        >
          {busy ? "Saving…" : target === "tags" ? "Count by tags" : "Count by pipeline stages"}
        </button>
        <button
          id="cancel-switch"
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Message({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="mt-3 flex items-start gap-2 text-xs"
      style={{ color: ok ? "var(--delta-good)" : "var(--status-critical)" }}
    >
      <span aria-hidden="true">{ok ? "✓" : "✕"}</span>
      <span>{children}</span>
    </p>
  );
}

async function fetchPreview(
  clientId: string,
  everyContact: boolean,
  tags: string[],
): Promise<Preview> {
  const res = await fetch(`/api/clients/${clientId}/tag-mapping/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ everyContact, tags }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(body, "Couldn't count the leads. Try again."));
  return body as Preview;
}

/* ------------------------------------------------------------------ */

/**
 * Shown above the pipeline mapping while the client is counted by tags: the
 * way back, with the same before/after confirmation.
 */
export function SwitchToPipeline({
  clientId,
  onSaved,
}: {
  clientId: string;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function ask() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/tag-mapping`);
      const loaded = await res.json().catch(() => null);
      if (!res.ok || !loaded?.allowed) {
        throw new Error(errorText(loaded, "Couldn't load this client's tag mapping. Try again."));
      }
      const tags = ((loaded.mappings ?? []) as Mapping[]).map((m) => m.tag);
      setPreview(await fetchPreview(clientId, Boolean(loaded.everyContact), tags));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Couldn't count the leads." });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/tag-mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "pipeline" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg({ ok: false, text: errorText(body, "Couldn't save. Nothing was changed.") });
        return;
      }
      setPreview(null);
      setMsg({ ok: true, text: "Saved. This client's leads are counted by pipeline stages again." });
      onSaved();
    } catch {
      setMsg({ ok: false, text: NO_ANSWER });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mb-4 rounded-[var(--radius)] border p-3"
      style={{
        borderColor: "var(--border)",
        background: "color-mix(in srgb, var(--accent) 6%, transparent)",
      }}
    >
      <p className="text-[13px]" style={{ color: "var(--text-primary)" }}>
        This client&apos;s leads are counted by tags right now. The pipeline mapping
        below is kept for when you switch back.
      </p>
      {!preview && (
        <button
          id="switch-to-pipeline"
          type="button"
          onClick={ask}
          disabled={busy}
          className="mt-2 rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={secondaryButton}
        >
          {busy ? "Counting…" : "Count by pipeline stages instead"}
        </button>
      )}
      {preview && (
        <ConfirmSwitch
          preview={preview}
          target="pipeline"
          savedMode="tags"
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPreview(null)}
        />
      )}
      {msg && <Message ok={msg.ok}>{msg.text}</Message>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** The tag editor: which tags mean which step, and "every new contact". */
/**
 * "+ Add tag" for one step: a search box over the client's tags.
 *
 * A sub-account can carry hundreds of tags (the list holds up to 1,000, most
 * used first), and a plain dropdown of them can only be scrolled. Typing a few
 * letters narrows it instead: tags that START with what was typed come first,
 * then tags that contain it, each group still most used first.
 *
 * Arrow keys move through the list, Enter adds the highlighted tag, Escape or a
 * click elsewhere closes it. Picking a tag, or Escape, hands focus back to the
 * button, so a keyboard user can add the next tag straight away.
 */
function TagPicker({
  stageLabel,
  tags,
  disabled,
  onPick,
}: {
  stageLabel: string;
  /** Tags not yet used by any step, most used first. */
  tags: readonly TagCount[];
  disabled: boolean;
  onPick: (tag: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const backToButton = useRef(false);
  const id = useId();
  const listId = `${id}-tags`;
  const optionId = (i: number) => `${id}-tag-${i}`;

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return tags;
    const starts: TagCount[] = [];
    const contains: TagCount[] = [];
    for (const t of tags) {
      const name = t.tag.toLowerCase();
      if (name.startsWith(q)) starts.push(t);
      else if (name.includes(q)) contains.push(t);
    }
    return [...starts, ...contains];
  }, [tags, q]);

  const close = (focusButton: boolean) => {
    backToButton.current = focusButton;
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  // Opening puts the cursor in the search box; closing by Escape or a pick
  // returns it to the button.
  useEffect(() => {
    if (open) {
      input.current?.focus();
    } else if (backToButton.current) {
      backToButton.current = false;
      button.current?.focus();
    }
  }, [open]);

  // A click anywhere outside closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        setActive(0);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted tag in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const pick = (tag: string) => {
    onPick(tag);
    close(true);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = matches[active];
      if (t) pick(t.tag);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
  };

  if (!open) {
    return (
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || tags.length === 0}
        aria-haspopup="listbox"
        aria-label={`Add a tag to ${stageLabel}`}
        className="max-w-full rounded-[var(--radius-sm)] border px-2 py-1 text-[12px] disabled:opacity-50"
        style={inputStyle}
      >
        + Add tag
      </button>
    );
  }

  return (
    <div ref={root} className="relative w-[17rem] max-w-full">
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={matches[active] ? optionId(active) : undefined}
        aria-label={`Search tags to add to ${stageLabel}`}
        placeholder="Search tags…"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
        onBlur={(e) => {
          // Tabbing away closes it; a click inside the list never blurs (below).
          if (!root.current?.contains(e.relatedTarget as Node | null)) close(false);
        }}
        className="w-full rounded-[var(--radius-sm)] border px-2 py-1 text-[12px]"
        style={inputStyle}
      />
      <div
        // Keeps the cursor in the search box while the list, or its scrollbar, is clicked.
        onMouseDown={(e) => e.preventDefault()}
        className="absolute left-0 top-full z-30 mt-1 w-full rounded-[var(--radius-sm)] border"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--surface-raised)",
          boxShadow: "var(--shadow-overlay)",
        }}
      >
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label={`Tags you can add to ${stageLabel}`}
          className="max-h-64 overflow-y-auto py-1"
        >
          {matches.map((t, i) => (
            <li
              key={t.tag}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              title={t.tag}
              onClick={() => pick(t.tag)}
              onMouseMove={() => {
                if (i !== active) setActive(i);
              }}
              className="flex cursor-pointer items-baseline justify-between gap-3 px-2.5 py-1.5 text-[12px]"
              style={{
                color: "var(--text-primary)",
                background: i === active ? "var(--surface-2)" : undefined,
              }}
            >
              <span className="min-w-0 truncate">{t.tag}</span>
              <span className="shrink-0 tabular-nums" style={{ color: "var(--text-muted)" }}>
                {fmt(t.contacts)} contact{t.contacts === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
        {matches.length === 0 && (
          <p role="status" className="px-2.5 py-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
            No tags match “{query.trim()}”.
          </p>
        )}
      </div>
    </div>
  );
}

export function TagMappingPanel({
  clientId,
  savedMode,
  onSaved,
}: {
  clientId: string;
  savedMode: CrmMode;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [everyContact, setEveryContact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/clients/${clientId}/tag-mapping`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!live) return;
        if (!res.ok || !body?.allowed) {
          setLoadError(errorText(body, "Couldn't load this client's tags."));
          return;
        }
        setLoaded(body as Loaded);
        setMappings((body as Loaded).mappings);
        setEveryContact((body as Loaded).everyContact);
      })
      .catch(() => live && setLoadError("Couldn't load this client's tags."));
    return () => {
      live = false;
    };
  }, [clientId]);

  const counts = useMemo(
    () => new Map((loaded?.tags ?? []).map((t) => [t.tag, t.contacts])),
    [loaded],
  );
  const used = new Set(mappings.map((m) => m.tag));
  const available = (loaded?.tags ?? []).filter((t) => !used.has(t.tag));
  const hasLeadRule = everyContact || mappings.length > 0;

  // Any edit voids the confirmation and any earlier "Saved." beside it.
  const edited = () => {
    setPreview(null);
    setMsg(null);
  };
  const add = (stage: CanonicalStage, tag: string) => {
    if (!tag) return;
    edited();
    setMappings((prev) => [...prev.filter((m) => m.tag !== tag), { tag, canonicalStage: stage }]);
  };
  const remove = (tag: string) => {
    edited();
    setMappings((prev) => prev.filter((m) => m.tag !== tag));
  };

  async function review() {
    setBusy(true);
    setMsg(null);
    try {
      setPreview(await fetchPreview(clientId, everyContact, mappings.map((m) => m.tag)));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Couldn't count the leads." });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/tag-mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "tags", everyContact, mappings }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setMsg({ ok: false, text: errorText(body, "Couldn't save. Nothing was changed.") });
        return;
      }
      setPreview(null);
      const leads = body?.rebuilt?.leads;
      setMsg({
        ok: true,
        text:
          typeof leads === "number"
            ? `Saved. ${fmt(leads)} lead${leads === 1 ? "" : "s"} counted from this client's contacts, all time.`
            : "Saved.",
      });
      onSaved();
    } catch {
      setMsg({ ok: false, text: NO_ANSWER });
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <Message ok={false}>{loadError}</Message>;
  if (!loaded) {
    return (
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Loading this client&apos;s tags…
      </p>
    );
  }

  return (
    <div>
      <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
        Pick the GoHighLevel tags that mean each step. A contact with any mapped tag
        counts as a lead on the day it arrived. A later step counts from the day we
        saw its tag added; a tag that was already on the contact when we first read
        it counts on the day the contact arrived.
      </p>

      <label
        htmlFor="tag-every-contact"
        className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] border p-3"
        style={{ borderColor: "var(--border)" }}
      >
        <input
          id="tag-every-contact"
          type="checkbox"
          checked={everyContact}
          disabled={busy}
          onChange={(e) => {
            edited();
            setEveryContact(e.target.checked);
          }}
          className="mt-0.5"
        />
        <span>
          <span className="block text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
            Count every new contact as a lead
          </span>
          <span className="block text-xs" style={{ color: "var(--text-muted)" }}>
            For clients whose leads carry no tag. Tagged or not, every contact that
            arrives counts.
          </span>
        </span>
      </label>

      {loaded.tags.length === 0 && (
        <p className="mt-3 text-xs" style={{ color: "var(--status-warning)" }}>
          No tags found on this client&apos;s contacts yet. Run “Import historical data”
          below to bring them in from GoHighLevel.
        </p>
      )}

      <div
        className="mt-3 flex flex-col divide-y rounded-[var(--radius)] border"
        style={{ borderColor: "var(--border)" }}
      >
        {CANONICAL_STAGES.map((stage) => {
          const mine = mappings.filter((m) => m.canonicalStage === stage);
          return (
            <div
              key={stage}
              className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="w-full min-w-0 sm:w-[170px] sm:shrink-0">
                <div className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                  {STAGE_LABELS[stage]}
                </div>
                {STEP_HINT[stage] && (
                  <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {STEP_HINT[stage]}
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {mine.map((m) => (
                  <span
                    key={m.tag}
                    className="tint-badge inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-[12px] font-medium"
                    style={{ "--tint": "var(--accent)" } as CSSProperties}
                  >
                    <span className="truncate">{m.tag}</span>
                    <span className="tabular-nums" style={{ opacity: 0.75 }}>
                      {fmt(counts.get(m.tag) ?? 0)}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(m.tag)}
                      aria-label={`Remove ${m.tag} from ${STAGE_LABELS[stage]}`}
                      className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <TagPicker
                  stageLabel={STAGE_LABELS[stage]}
                  tags={available}
                  disabled={busy}
                  onPick={(tag) => add(stage, tag)}
                />
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        Contacts that carry an ad campaign ID, a Facebook lead-form ID, or a Google or
        TikTok click ID always count as leads. {paidRuleText(loaded.paidRule)} Change that under “Which leads count as
        paid” above.
      </p>
      {!hasLeadRule && (
        <p className="mt-2 text-xs" style={{ color: "var(--status-warning)" }}>
          No tags picked yet, so only contacts with an ad campaign or click ID would
          count as leads.
        </p>
      )}

      {!preview && (
        <button
          id="tag-mapping-save"
          type="button"
          onClick={review}
          disabled={busy}
          className="mt-3 btn-accent disabled:opacity-50"
        >
          {busy ? "Counting…" : savedMode === "tags" ? "Save tag mapping" : "Review and count by tags"}
        </button>
      )}
      {preview && (
        <ConfirmSwitch
          preview={preview}
          target="tags"
          savedMode={savedMode}
          busy={busy}
          onConfirm={save}
          onCancel={() => setPreview(null)}
        />
      )}
      {msg && <Message ok={msg.ok}>{msg.text}</Message>}
    </div>
  );
}
