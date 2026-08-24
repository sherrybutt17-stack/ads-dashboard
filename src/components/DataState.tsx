import Link from "next/link";
import { Icon } from "@/components/Icon";
import type { AdPlatform } from "@/lib/platforms";
import { describeStoredFailure } from "@/lib/health-errors";
import type { AdPipeStatus, CrmPipeStatus } from "@/lib/metrics/pipe-state";

/**
 * Platform names as they read in a sentence about a connection.
 *
 * Not `PLATFORM_LABEL` from `@/lib/platforms`, which is the short form for tabs
 * and metric labels. "Google isn't connected" is ambiguous — a client has a
 * Google account, a Google Business Profile and Google Analytics — so the copy
 * that tells someone what to go and fix names the product.
 */
const PLATFORM_NAME: Record<AdPlatform, string> = {
  meta: "Meta",
  google: "Google Ads",
  tiktok: "TikTok Ads",
};

/**
 * What a panel renders when it has no numbers to render.
 *
 * The failure this whole product exists to replace was not a wrong number, it
 * was an ABSENT one that looked like a real zero — `SHOWN = 0` for the source
 * sheet's entire history, six of its seven blocks empty, and nobody noticing for
 * months. A dashed box saying "no data" reproduces that failure exactly: it is
 * the same glyph for "your ads are paused", "we cannot reach Meta", and "this
 * was never connected", three states with completely different responses.
 *
 * So every empty region on this page routes through here and must name its own
 * cause. Three rules the component enforces rather than leaves to the caller:
 *
 * 1. **Missing is never zero.** An unreachable pipe says so in the first line,
 *    in the words "missing, not zero", because the default reading of a blank
 *    chart is "nothing happened".
 * 2. **Status is never colour alone.** Every tone carries an icon and says the
 *    state in words, so it survives greyscale, colour blindness, and a phone in
 *    sunlight.
 * 3. **Two registers.** Staff get the diagnostic and a link to the thing that
 *    fixes it. Clients get plain language and no dead-end link to a page they
 *    cannot open — but the same *facts*: a client is never shown green calm
 *    where staff would see red.
 */

export type DataStateTone = "neutral" | "warning" | "critical";

export interface DataStateProps {
  /** Short, plain-language statement of what is (not) here. */
  title: string;
  /** One sentence of context. Optional — the title alone is often enough. */
  detail?: string;
  /** Diagnostic text shown to staff only, e.g. an API error message. */
  diagnostic?: string;
  tone?: DataStateTone;
  /** Renders a Setup link for staff. Omit for states staff cannot act on. */
  fixHref?: string;
  fixLabel?: string;
  /** Compact variant for panels that sit inside a larger card. */
  size?: "default" | "compact";
}

const TONE: Record<
  DataStateTone,
  { color: string; icon: "alert" | "x" | "help"; word: string }
> = {
  neutral: { color: "var(--text-muted)", icon: "help", word: "" },
  warning: { color: "var(--status-warning)", icon: "alert", word: "Degraded" },
  critical: { color: "var(--status-critical)", icon: "x", word: "Not available" },
};

export function DataState({
  title,
  detail,
  diagnostic,
  tone = "neutral",
  fixHref,
  fixLabel = "Open setup",
  size = "default",
}: DataStateProps) {
  const t = TONE[tone];
  const pad = size === "compact" ? "px-4 py-5" : "px-6 py-8";

  return (
    <div
      role="status"
      className={`flex flex-col items-center gap-1.5 rounded-[10px] border border-dashed text-center ${pad}`}
      style={{
        // Non-neutral states tint their border so the region reads as
        // "something is wrong here" from across the room, while the icon and
        // the words carry the same meaning for anyone the colour does not reach.
        borderColor:
          tone === "neutral"
            ? "var(--border-strong)"
            : `color-mix(in srgb, ${t.color} 45%, var(--border-strong))`,
        background:
          tone === "neutral"
            ? "transparent"
            : `color-mix(in srgb, ${t.color} 5%, transparent)`,
      }}
    >
      <span
        className="flex items-center gap-1.5 text-[13px] font-medium"
        style={{ color: tone === "neutral" ? "var(--text-secondary)" : t.color }}
      >
        <Icon name={t.icon} size={14} />
        {t.word && <span className="sr-only">{t.word}: </span>}
        {title}
      </span>

      {detail && (
        <p
          className="max-w-[46ch] text-xs leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          {detail}
        </p>
      )}

      {diagnostic && (
        <p
          className="max-w-[52ch] font-mono text-[11px] leading-relaxed break-words"
          style={{ color: "var(--text-muted)" }}
        >
          {diagnostic}
        </p>
      )}

      {fixHref && (
        <Link
          href={fixHref}
          className="mt-1 rounded-[7px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)]"
          style={{
            borderColor: "var(--border-strong)",
            color: "var(--text-secondary)",
          }}
        >
          {fixLabel}
        </Link>
      )}
    </div>
  );
}

/**
 * The same fact as a one-line strip, for a panel that DOES have data.
 *
 * `stale` and `unreachable` do not mean the panel is blank — we still hold the
 * last rows that synced successfully, and they may well cover the whole selected
 * range. Replacing a populated chart with a full-size notice would throw away
 * real numbers to report a pipe problem; showing nothing would present possibly
 * frozen numbers as current. So a populated panel keeps its chart and wears the
 * qualifier above it.
 *
 * `size="compact"` on the block form is for empty panels. This is for full ones.
 */
export function PipeNotice({ title, detail, tone = "neutral" }: DataStateProps) {
  const t = TONE[tone];
  return (
    <div
      role="status"
      className="mb-2 flex items-start gap-2 rounded-[8px] px-2.5 py-1.5 text-[11px] leading-snug"
      style={{
        background: `color-mix(in srgb, ${t.color} 8%, transparent)`,
        color: "var(--text-secondary)",
      }}
    >
      <span style={{ color: t.color }} className="mt-px shrink-0">
        <Icon name={t.icon} size={12} />
      </span>
      <span>
        {t.word && <span className="sr-only">{t.word}: </span>}
        <span style={{ color: t.color, fontWeight: 500 }}>{title}</span>
        {detail && <span> — {detail}</span>}
      </span>
    </div>
  );
}

/** Human "3 days" / "5 hours" for a duration in hours. */
function agoHours(h: number): string {
  if (h < 1) return "under an hour";
  if (h < 48) return `${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * The ad-pipe copy, resolved once so every panel tells the same story.
 *
 * Returns null when the pipe is healthy — the caller then decides what an empty
 * result means on its own terms (paused, filtered, out of range), which is only
 * a legitimate question to ask once we know the data actually arrived.
 */
export function adPipeState(
  pipe: AdPipeStatus,
  opts: { staff: boolean; slug: string },
): DataStateProps | null {
  /*
   * 🔴 From the shared map, not `=== "google" ? "Google Ads" : "Meta"`.
   *
   * That ternary sent TikTok down the else-branch, so every empty state on a
   * TikTok panel read "Meta isn't connected" and "Waiting for the first Meta
   * sync". Wrong copy on the one surface whose entire job is telling the truth
   * about why a region is blank — and it would have sent someone to fix a
   * Facebook connection that was working fine.
   */
  const name = PLATFORM_NAME[pipe.platform];
  const setup = opts.staff ? `/c/${opts.slug}/setup` : undefined;

  switch (pipe.state) {
    case "not_connected":
      return {
        title: `${name} isn't connected`,
        detail: opts.staff
          ? `No ${name} ad account is attached to this client, so there is no spend to show.`
          : `${name} advertising hasn't been connected to this dashboard yet.`,
        tone: "neutral",
        fixHref: setup,
        fixLabel: `Connect ${name}`,
      };

    /*
     * The post-connect wait, and the only state on this screen that is good
     * news. It exists because connecting an account used to succeed into
     * silence: the nightly reconciliation might be hours off, so the dashboard
     * showed an empty panel and the operator could not tell whether they had
     * done something wrong. This is the moment a trial is won or abandoned.
     *
     * The duration is named, because "please wait" with no horizon is what
     * makes a screen feel stuck — and it stops being named the moment it stops
     * being true. A progress message still promising two minutes at minute
     * twelve is worse than no promise at all.
     */
    case "backfilling": {
      const slow = (pipe.runningForMinutes ?? 0) >= 5;
      return {
        title: `Fetching your ${name} history`,
        detail: slow
          ? `This is taking longer than usual — large accounts and long date ranges can. It will finish on its own; nothing needs restarting.`
          : `Importing the last 90 days. Usually two or three minutes, and this fills in on its own.`,
        tone: "neutral",
      };
    }

    case "never_synced":
      return {
        title: `Waiting for the first ${name} sync`,
        detail: opts.staff
          ? `The account is connected but no data has been pulled yet, and nothing is running. The nightly reconciliation will fill this in — or import it now from setup.`
          : `The account is connected and the first figures are on their way.`,
        tone: "neutral",
        fixHref: setup,
        fixLabel: "Import now",
      };

    case "unreachable": {
      /*
       * 🔴 This was `diagnostic: opts.staff ? pipe.lastError : undefined`, and
       * `opts.staff` is `isAgencyOperator(session)` — which since tenancy
       * includes agency owners, who are customers. `sync_runs.error` is the raw
       * upstream string: a Graph error naming our app id, a Google payload
       * carrying our MCC, or a Postgres failure written for nobody.
       *
       * Classified instead, so the operator keeps the diagnosis — which of the
       * six things went wrong, and what to do — and loses only the request id.
       * The raw text stays reachable in the health checklist, where it is gated
       * on superadmin rather than on "runs this account".
       */
      const failure = describeStoredFailure(pipe.lastError, pipe.platform);
      return {
        title: `${name} data is missing, not zero`,
        detail: opts.staff
          ? `The last ${name} sync failed, so nothing here reflects current spend. Do not read this as no activity.`
          : `We couldn't load ${name} data for this period. Don't read this as no activity — the figures are missing, and we're on it.`,
        diagnostic:
          opts.staff && failure
            ? `${failure.message}. ${failure.hint ?? ""}`.trim()
            : undefined,
        tone: "critical",
        fixHref: setup,
      };
    }

    case "stale":
      return {
        title: `${name} data may be incomplete`,
        detail: `Last successful sync was ${agoHours(pipe.hoursSinceSuccess ?? 0)} ago${
          opts.staff ? " — the nightly reconciliation may not be running." : "."
        } Anything more recent than that is not in these figures yet.`,
        tone: "warning",
        fixHref: setup,
      };

    case "live":
      return null;
  }
}

/**
 * The CRM equivalent, for lead-shaped panels.
 *
 * `silent` is reported only when the panel is ALSO empty (the caller's job) —
 * on its own, a quiet fortnight is not a fault, and firing a warning at every
 * small client would train everyone to ignore the warning that matters.
 */
export function crmPipeState(
  crm: CrmPipeStatus,
  opts: { staff: boolean; slug: string; emptyPanel: boolean },
): DataStateProps | null {
  const setup = opts.staff ? `/c/${opts.slug}/setup` : undefined;

  if (crm.state === "never_connected") {
    return {
      title: "No CRM events have arrived yet",
      detail: opts.staff
        ? "Lead and stage history only accumulates forward from the first webhook — nothing before it can be recovered. Install the webhook to start recording."
        : "Lead activity will appear here as soon as the CRM connection starts sending events.",
      tone: "warning",
      fixHref: setup,
      fixLabel: "Install the webhook",
    };
  }

  if (crm.state === "silent" && opts.emptyPanel) {
    const days = Math.round(crm.daysSinceEvent ?? 0);
    return {
      title: "No leads in this period",
      detail: `The CRM has also sent no events at all for ${days} days, so this may be a quiet stretch or a connection that has stopped — worth checking rather than assuming.`,
      tone: "warning",
      fixHref: setup,
    };
  }

  return null;
}
