"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CANONICAL_STAGES, STAGE_LABELS, type CanonicalStage } from "@/db/schema";

/**
 * Connection wizard.
 *
 * Every step VERIFIES against the live API before it will advance, and echoes
 * back what the API returned — the GHL business name, the Meta account name and
 * currency. A mistyped ad account id or a token generated against the wrong
 * sub-account is then caught in the moment, instead of surfacing weeks later as
 * an inexplicably empty dashboard.
 *
 * The final step is the important one: it does not declare success when the
 * webhook URL has been *displayed*, it polls until a real event arrives.
 * Configured and working are different things.
 */

interface StageRow {
  id: string;
  name: string | null;
  pipelineName: string | null;
  canonicalStage: CanonicalStage | null;
  discoveredFromWebhook: boolean;
}

interface Props {
  clientId: string;
  slug: string;
  webhookUrl: string;
  /** True when GHL_CLIENT_ID/SECRET are set, enabling the one-click install. */
  oauthAvailable: boolean;
  installation: {
    locationName: string | null;
    locationId: string;
    installedAt: string;
    uninstalledAt: string | null;
  } | null;
  initial: {
    ghlLocationId: string;
    ghlLocationName: string | null;
    ghlAuthMethod: "pit" | "oauth";
    hasGhlToken: boolean;
    clientTimezone: string;
    firstWebhookAt: string | null;
  };
  metaAccounts: MetaAccountRow[];
  googleAccounts: GoogleAccountRow[];
  /** True when the agency Google Ads env vars are all set. */
  googleConfigured: boolean;
  stages: StageRow[];
}

export interface MetaAccountRow {
  id: string;
  adAccountId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  isPrimary: boolean;
  status: "active" | "paused" | "removed";
}

export interface GoogleAccountRow {
  id: string;
  customerId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  isPrimary: boolean;
  status: "active" | "paused" | "removed";
}

export function SetupWizard({
  clientId,
  slug,
  webhookUrl,
  oauthAvailable,
  installation,
  initial,
  metaAccounts,
  googleAccounts,
  googleConfigured,
  stages: initialStages,
}: Props) {
  const router = useRouter();
  const usingOauth = initial.ghlAuthMethod === "oauth" || oauthAvailable;

  return (
    <div className="flex flex-col gap-5">
      {usingOauth ? (
        <InstallStep
          clientId={clientId}
          installation={installation}
          oauthAvailable={oauthAvailable}
        />
      ) : (
        <GhlStep clientId={clientId} initial={initial} onDone={() => router.refresh()} />
      )}
      <StageStep clientId={clientId} stages={initialStages} onDone={() => router.refresh()} />
      <MetaAccountsStep
        clientId={clientId}
        accounts={metaAccounts}
        onDone={() => router.refresh()}
      />
      <GoogleAccountsStep
        clientId={clientId}
        accounts={googleAccounts}
        configured={googleConfigured}
        onDone={() => router.refresh()}
      />
      {!usingOauth && (
        <WebhookStep
          clientId={clientId}
          webhookUrl={webhookUrl}
          firstWebhookAt={initial.firstWebhookAt}
        />
      )}
      {/* On the OAuth path WebhookStep (step 5) isn't rendered, so backfill takes
          its number — otherwise the wizard reads 1,2,3,4,6 with a missing "5". */}
      <BackfillStep clientId={clientId} slug={slug} step={usingOauth ? 5 : 6} />
    </div>
  );
}

/**
 * One-click install via the marketplace app.
 *
 * This replaces both the token-entry step AND the webhook-installation step:
 * app-level webhooks are configured once in the app's own settings, so an
 * installed sub-account starts streaming `OpportunityStageUpdate` events with
 * no per-client workflow building at all. That is the entire reason for
 * preferring OAuth over a Private Integration Token, which has no webhook
 * capability.
 */
function InstallStep({
  clientId,
  installation,
  oauthAvailable,
}: {
  clientId: string;
  installation: Props["installation"];
  oauthAvailable: boolean;
}) {
  const active = installation && !installation.uninstalledAt;

  return (
    <Card
      step={1}
      title="Connect GoHighLevel"
      description="Installs the marketplace app on the client's sub-account. No workflow building required — stage changes stream automatically."
      done={Boolean(active)}
    >
      {!oauthAvailable ? (
        <p className="text-xs" style={{ color: "var(--status-warning)" }}>
          OAuth is not configured on this deployment. Set{" "}
          <code>GHL_CLIENT_ID</code> and <code>GHL_CLIENT_SECRET</code>, or use a
          Private Integration Token instead.
        </p>
      ) : active ? (
        <>
          <Result ok>
            Installed on {installation!.locationName ?? installation!.locationId}
          </Result>
          <a
            href={`/api/oauth/authorize?clientId=${clientId}`}
            className="mt-3 inline-block rounded-[8px] border px-3 py-2 text-[13px] font-medium"
            style={{
              borderColor: "var(--border-strong)",
              color: "var(--text-secondary)",
            }}
          >
            Reconnect
          </a>
        </>
      ) : (
        <>
          {installation?.uninstalledAt && (
            <p
              className="mb-3 text-xs"
              style={{ color: "var(--status-critical)" }}
            >
              The app was uninstalled on{" "}
              {new Date(installation.uninstalledAt).toLocaleDateString("en-US", {
                timeZone: "UTC",
              })}
              . Stage
              changes are not being recorded.
            </p>
          )}
          <a
            href={`/api/oauth/authorize?clientId=${clientId}`}
            className="inline-block rounded-[8px] px-3 py-2 text-[13px] font-medium text-white"
            style={{ background: "var(--series-1)" }}
          >
            Install on a sub-account
          </a>
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            You&rsquo;ll be sent to GoHighLevel to pick the sub-account, then
            returned here. Pipeline stages import automatically.
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function Card({
  step,
  title,
  description,
  done,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-5">
      <div className="mb-3 flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
          style={{
            background: done ? "var(--status-good)" : "var(--surface-2)",
            color: done ? "#fff" : "var(--text-secondary)",
          }}
          aria-hidden="true"
        >
          {done ? "✓" : step}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

const inputStyle = {
  borderColor: "var(--border-strong)",
  background: "var(--surface-1)",
  color: "var(--text-primary)",
} as const;

function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span
        className="text-[11px] font-medium tracking-wider uppercase"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
      <input
        {...props}
        className="mt-1 w-full rounded-[8px] border px-3 py-2 text-[13px]"
        style={inputStyle}
      />
    </label>
  );
}

function Result({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <p
      className="mt-3 flex items-start gap-2 text-xs"
      style={{ color: ok ? "var(--delta-good)" : "var(--status-critical)" }}
    >
      <span aria-hidden="true">{ok ? "✓" : "✕"}</span>
      <span>{children}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ */

function GhlStep({
  clientId,
  initial,
  onDone,
}: {
  clientId: string;
  initial: Props["initial"];
  onDone: () => void;
}) {
  const [locationId, setLocationId] = useState(initial.ghlLocationId);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(
    initial.ghlLocationName
      ? { ok: true, msg: `Connected to ${initial.ghlLocationName}` }
      : null,
  );

  async function verify() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "ghl",
          locationId,
          token: token || undefined,
        }),
      });
      const body = await res.json();
      setResult(
        res.ok
          ? { ok: true, msg: `Connected to ${body.locationName ?? locationId}` }
          : { ok: false, msg: body.error ?? "Verification failed" },
      );
      if (res.ok) {
        setToken("");
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={1}
      title="Connect GoHighLevel"
      description="A Private Integration Token for this sub-account, plus its location ID."
      done={Boolean(initial.ghlLocationName)}
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Location ID"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          placeholder="ve9EPM428h8vShlRW1KT"
        />
        <Field
          label={
            initial.hasGhlToken
              ? "Private Integration Token (leave blank to keep existing)"
              : "Private Integration Token"
          }
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="pit-..."
        />
        <button
          onClick={verify}
          disabled={busy || !locationId}
          className="self-start rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
          style={{ background: "var(--series-1)" }}
        >
          {busy ? "Verifying…" : "Verify & save"}
        </button>
      </div>
      {result && <Result ok={result.ok}>{result.msg}</Result>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function StageStep({
  clientId,
  stages,
  onDone,
}: {
  clientId: string;
  stages: StageRow[];
  onDone: () => void;
}) {
  const [rows, setRows] = useState(stages);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  /*
   * Reset local edits when the server sends a new stage list (after a
   * re-import, or a router.refresh()). This is React's documented
   * adjust-state-during-render pattern — an effect would render once with the
   * stale list and then correct itself, briefly showing the old mapping.
   */
  const [seenStages, setSeenStages] = useState(stages);
  if (stages !== seenStages) {
    setSeenStages(stages);
    setRows(stages);
  }

  const mapped = new Set(rows.map((r) => r.canonicalStage).filter(Boolean));
  const missing = CANONICAL_STAGES.filter((s) => !mapped.has(s));

  async function importStages() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/stages?refresh=1`);
      const body = await res.json();
      if (res.ok) {
        setRows(body.stages);
        setMsg({ ok: true, msg: `Imported ${body.stages.length} stages` });
        onDone();
      } else {
        setMsg({ ok: false, msg: body.error ?? "Import failed" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/stages`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mappings: rows.map((r) => ({
            stageId: r.id,
            canonicalStage: r.canonicalStage,
          })),
        }),
      });
      const body = await res.json();
      setMsg(
        res.ok
          ? {
              ok: true,
              msg: `Saved.${
                body.reclassifiedTransitions
                  ? ` ${body.reclassifiedTransitions} existing transitions reclassified.`
                  : ""
              }`,
            }
          : { ok: false, msg: body.error ?? "Save failed" },
      );
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={2}
      title="Map pipeline stages"
      description="Your GHL stage names, mapped onto the seven canonical funnel stages."
      done={rows.length > 0 && missing.length === 0}
    >
      <button
        onClick={importStages}
        disabled={busy}
        className="rounded-[8px] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
        style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
      >
        {busy ? "Working…" : rows.length ? "Re-import from GHL" : "Import from GHL"}
      </button>

      {rows.length > 0 && (
        <>
          <div className="mt-4 flex flex-col gap-2">
            {rows.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-[13px]"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {row.name ?? <em style={{ color: "var(--text-muted)" }}>Unnamed stage</em>}
                    {row.discoveredFromWebhook && (
                      <span
                        className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{
                          background: "color-mix(in srgb, var(--status-warning) 22%, transparent)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        seen in webhook
                      </span>
                    )}
                  </div>
                  {row.pipelineName && (
                    <div className="truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {row.pipelineName}
                    </div>
                  )}
                </div>
                <select
                  value={row.canonicalStage ?? ""}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r) =>
                        r.id === row.id
                          ? {
                              ...r,
                              canonicalStage:
                                (e.target.value || null) as CanonicalStage | null,
                            }
                          : r,
                      ),
                    )
                  }
                  className="rounded-[8px] border px-2 py-1.5 text-[13px]"
                  style={inputStyle}
                >
                  <option value="">— not used —</option>
                  {CANONICAL_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {missing.length > 0 && (
            <p className="mt-3 text-xs" style={{ color: "var(--status-warning)" }}>
              Unmapped: {missing.map((s) => STAGE_LABELS[s]).join(", ")} — these
              will read as zero in the funnel.
            </p>
          )}

          <button
            onClick={save}
            disabled={busy}
            className="mt-3 rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
            style={{ background: "var(--series-1)" }}
          >
            Save mapping
          </button>
        </>
      )}

      {msg && <Result ok={msg.ok}>{msg.msg}</Result>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Meta ad accounts — add as many as the client runs.
 *
 * A client can hold several accounts (e.g. one per location); the dashboard
 * sums spend and metrics across all of them. Each is verified against the Meta
 * API before it is stored, echoing back the real name/currency/timezone so a
 * mistyped id is caught immediately. The first account added sets the client's
 * display currency and bucketing timezone; a later account that disagrees on
 * either is flagged, because mixed currencies cannot be summed.
 */
function MetaAccountsStep({
  clientId,
  accounts,
  onDone,
}: {
  clientId: string;
  accounts: MetaAccountRow[];
  onDone: () => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; warn?: string } | null>(
    null,
  );

  const live = accounts.filter((a) => a.status !== "removed");

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/meta-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adAccountId: accountId, token: token || undefined }),
      });
      const body = await res.json();
      if (res.ok) {
        const warnings: string[] = [];
        if (body.currencyMismatch) {
          warnings.push(
            `Currency ${body.currencyMismatch.thisAccount} differs from the primary account's ${body.currencyMismatch.primary} — spend across different currencies cannot be summed correctly.`,
          );
        }
        if (body.timezoneMismatch) {
          warnings.push(
            `Timezone ${body.timezoneMismatch.thisAccount} differs from the primary ${body.timezoneMismatch.primary} — daily buckets may not line up.`,
          );
        }
        setMsg({
          ok: true,
          text: `Added ${body.account.accountName ?? body.account.adAccountId} · ${body.account.currency ?? "?"} · ${body.account.timezone ?? "?"}`,
          warn: warnings.join(" "),
        });
        setAccountId("");
        setToken("");
        setShowToken(false);
        onDone();
      } else {
        setMsg({ ok: false, text: body.error ?? "Failed to add account" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this ad account? Metrics already pulled are kept.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/meta-accounts/${id}`, {
        method: "DELETE",
      });
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={3}
      title="Connect Meta ad accounts"
      description="Add every ad account this client runs. Spend and metrics are summed across all of them."
      done={live.length > 0}
    >
      {live.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {live.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-2 rounded-[8px] border p-2.5"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="truncate text-[13px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {a.accountName ?? a.adAccountId}
                  </span>
                  {a.isPrimary && (
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                      style={{
                        background: "var(--surface-2)",
                        color: "var(--text-muted)",
                      }}
                    >
                      primary
                    </span>
                  )}
                </div>
                <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  act_{a.adAccountId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                </div>
              </div>
              <button
                onClick={() => remove(a.id)}
                disabled={busy}
                className="shrink-0 text-xs hover:underline disabled:opacity-50"
                style={{ color: "var(--status-critical)" }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3">
        <Field
          label={live.length ? "Add another ad account ID" : "Ad account ID"}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder="1234567890 (or act_1234567890)"
        />
        {showToken ? (
          <Field
            label="Access token override (different Business Manager)"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Leave blank to use the system user token"
          />
        ) : (
          <button
            onClick={() => setShowToken(true)}
            className="self-start text-xs hover:underline"
            style={{ color: "var(--text-muted)" }}
          >
            + Add a token override (only if this account is in another Business Manager)
          </button>
        )}
        <button
          onClick={add}
          disabled={busy || !accountId}
          className="self-start rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
          style={{ background: "var(--series-1)" }}
        >
          {busy ? "Verifying…" : "Verify & add"}
        </button>
      </div>

      {msg && (
        <>
          <Result ok={msg.ok}>{msg.text}</Result>
          {msg.warn && (
            <p className="mt-2 text-xs" style={{ color: "var(--status-warning)" }}>
              ⚠ {msg.warn}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Google Ads accounts — the direct sibling of the Meta step.
 *
 * Unlike Meta (one system-user token in env), Google authorizes every account
 * through the agency MCC, so the only per-client input is the Customer ID. It is
 * verified against the Google Ads API before storing, echoing back the real
 * name/currency/timezone so a wrong id or an account that was never linked to
 * our MCC is caught in the moment rather than surfacing as silently missing
 * spend. When the agency Google env vars aren't set, the step explains that and
 * stays inert — Google is optional, a client can run Meta only.
 */
function GoogleAccountsStep({
  clientId,
  accounts,
  configured,
  onDone,
}: {
  clientId: string;
  accounts: GoogleAccountRow[];
  configured: boolean;
  onDone: () => void;
}) {
  const [customerId, setCustomerId] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; warn?: string } | null>(
    null,
  );

  const live = accounts.filter((a) => a.status !== "removed");

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/google-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, refreshToken: token || undefined }),
      });
      const body = await res.json();
      if (res.ok) {
        const warnings: string[] = [];
        if (body.currencyMismatch) {
          warnings.push(
            `Currency ${body.currencyMismatch.thisAccount} differs from the primary account's ${body.currencyMismatch.primary} — spend across different currencies cannot be summed correctly.`,
          );
        }
        if (body.timezoneMismatch) {
          warnings.push(
            `Timezone ${body.timezoneMismatch.thisAccount} differs from the primary ${body.timezoneMismatch.primary} — daily buckets may not line up.`,
          );
        }
        setMsg({
          ok: true,
          text: `Added ${body.account.accountName ?? body.account.customerId} · ${body.account.currency ?? "?"} · ${body.account.timezone ?? "?"}`,
          warn: warnings.join(" "),
        });
        setCustomerId("");
        setToken("");
        setShowToken(false);
        onDone();
      } else {
        setMsg({ ok: false, text: body.error ?? "Failed to add account" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this Google Ads account? Metrics already pulled are kept.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/google-accounts/${id}`, {
        method: "DELETE",
      });
      if (res.ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      step={4}
      title="Connect Google Ads (optional)"
      description="Add the client's Customer ID. Spend, impressions and clicks are summed in alongside Meta."
      done={live.length > 0}
    >
      {!configured && live.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--status-warning)" }}>
          Google Ads isn&rsquo;t configured on this deployment yet. Add the agency
          developer token, OAuth client, refresh token and MCC id to the
          environment (see <code>SETUP.md</code> §2b), then reload. A client can
          run Meta-only until then.
        </p>
      ) : (
        <>
          {live.length > 0 && (
            <ul className="mb-4 flex flex-col gap-2">
              {live.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-2 rounded-[8px] border p-2.5"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="truncate text-[13px] font-medium"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {a.accountName ?? a.customerId}
                      </span>
                      {a.isPrimary && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: "var(--surface-2)",
                            color: "var(--text-muted)",
                          }}
                        >
                          primary
                        </span>
                      )}
                    </div>
                    <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {a.customerId} · {a.currency ?? "?"} · {a.timezone ?? "?"}
                    </div>
                  </div>
                  <button
                    onClick={() => remove(a.id)}
                    disabled={busy}
                    className="shrink-0 text-xs hover:underline disabled:opacity-50"
                    style={{ color: "var(--status-critical)" }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-3">
            <Field
              label={live.length ? "Add another Customer ID" : "Customer ID"}
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="123-456-7890"
            />
            {showToken ? (
              <Field
                label="Refresh token override (account not under the agency MCC)"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Leave blank to use the agency MCC token"
              />
            ) : (
              <button
                onClick={() => setShowToken(true)}
                className="self-start text-xs hover:underline"
                style={{ color: "var(--text-muted)" }}
              >
                + Add a token override (only if this account is not linked to our MCC)
              </button>
            )}
            <button
              onClick={add}
              disabled={busy || !customerId}
              className="self-start rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50"
              style={{ background: "var(--series-1)" }}
            >
              {busy ? "Verifying…" : "Verify & add"}
            </button>
          </div>

          {msg && (
            <>
              <Result ok={msg.ok}>{msg.text}</Result>
              {msg.warn && (
                <p className="mt-2 text-xs" style={{ color: "var(--status-warning)" }}>
                  ⚠ {msg.warn}
                </p>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Waits for a real event rather than trusting that the URL was pasted.
 * Polls the health endpoint until `firstWebhookAt` is populated.
 */
function WebhookStep({
  clientId,
  webhookUrl,
  firstWebhookAt,
}: {
  clientId: string;
  webhookUrl: string;
  firstWebhookAt: string | null;
}) {
  const [received, setReceived] = useState(Boolean(firstWebhookAt));
  const [listening, setListening] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!listening || received) return;
    timer.current = setInterval(async () => {
      const res = await fetch(`/api/clients/${clientId}`, { cache: "no-store" });
      if (res.ok) {
        const body = await res.json();
        if (body.client?.firstWebhookAt) {
          setReceived(true);
          setListening(false);
        }
      }
    }, 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [listening, received, clientId]);

  return (
    <Card
      step={5}
      title="Install the GHL webhook"
      description="In GHL: Automation → Workflows → new workflow → trigger 'Pipeline Stage Changed' → action 'Webhook'."
      done={received}
    >
      <div
        className="flex items-center gap-2 rounded-[8px] border p-2"
        style={{ borderColor: "var(--border-strong)", background: "var(--surface-2)" }}
      >
        <code
          className="min-w-0 flex-1 truncate text-[12px]"
          style={{ color: "var(--text-primary)" }}
        >
          {webhookUrl}
        </code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(webhookUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="shrink-0 rounded-[6px] border px-2 py-1 text-[12px]"
          style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {received ? (
        <Result ok>Webhook events are arriving — funnel history is recording.</Result>
      ) : (
        <>
          <button
            onClick={() => setListening(true)}
            disabled={listening}
            className="mt-3 rounded-[8px] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
            style={{ background: "var(--series-1)" }}
          >
            {listening ? "Waiting for first event…" : "Test connection"}
          </button>
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Move any opportunity between stages in GHL. This will turn green the
            moment a real event lands — until then, no pipeline history is being
            recorded, and it cannot be backfilled later.
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function BackfillStep({
  clientId,
  slug,
  step,
}: {
  clientId: string;
  slug: string;
  step: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  async function run(action: "meta_backfill" | "ghl_backfill") {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, days: 90 }),
      });
      const body = await res.json();
      setMsg(
        res.ok
          ? {
              ok: true,
              msg:
                action === "meta_backfill"
                  ? `Imported ${body.rowsWritten} daily metric rows.`
                  : `Snapshotted ${body.opportunities} opportunities (${body.transitions} arrivals). ${body.note}`,
            }
          : { ok: false, msg: body.error ?? "Failed" },
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      step={step}
      title="Import historical data"
      description="Optional, run once. Meta history imports fully; GHL history does not."
    >
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => run("meta_backfill")}
          disabled={busy !== null}
          className="rounded-[8px] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
        >
          {busy === "meta_backfill" ? "Importing…" : "Import 90 days of Meta data"}
        </button>
        <button
          onClick={() => run("ghl_backfill")}
          disabled={busy !== null}
          className="rounded-[8px] border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
          style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
        >
          {busy === "ghl_backfill" ? "Importing…" : "Snapshot GHL opportunities"}
        </button>
      </div>

      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        GoHighLevel exposes no stage-transition history, so the snapshot records
        only where each opportunity sits now and when it last moved. The path
        each lead took to get there is not recoverable — true funnel flow begins
        from when the webhook went live.
      </p>

      {msg && <Result ok={msg.ok}>{msg.msg}</Result>}

      <a
        href={`/c/${slug}`}
        className="mt-4 inline-block text-[13px] font-medium hover:underline"
        style={{ color: "var(--series-1)" }}
      >
        Go to dashboard →
      </a>
    </Card>
  );
}
