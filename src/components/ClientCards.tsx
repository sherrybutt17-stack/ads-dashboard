import Link from "next/link";
import type { CSSProperties } from "react";
import { HealthBadge } from "@/components/HealthChecklist";
import { RemoveClient } from "@/components/RemoveClient";
import { ChurnChip } from "@/components/ChurnRisk";
import { Icon } from "@/components/Icon";
import type { HealthLevel } from "@/lib/health";
import type { ChurnLevel } from "@/lib/metrics/churn";
import type { Accent } from "@/lib/accent";
import { AD_PLATFORMS, PLATFORM_LABEL, type AdPlatform } from "@/lib/platforms";

/**
 * The agency's book, as one card per sub-account.
 *
 * ── Why cards, and why grouped ────────────────────────────────────────
 *
 * This was a flat list of rows, and a flat list says every line is equally
 * worth reading. It is not: on a real roster one or two accounts are live and
 * the rest are half-wired or dormant, and the operator opens this page to find
 * the live ones and to finish the unfinished ones — two different jobs that a
 * single undifferentiated column makes you do by reading every line.
 *
 * 🔴 The groups are derived from the connection facts, never hand-assigned, and
 * a client appears in exactly one. The order is the order of the operator's
 * attention: what is working, what broke, what was never finished.
 */

export interface ClientCard {
  id: string;
  name: string;
  slug: string;
  /** The ad side of the card's second line — see `adConnection`. */
  adLabel: string;
  ghlLocationName: string | null;
  firstWebhookAt: Date | string | null;
  /** How many ad accounts are wired, across every platform. */
  adAccounts: number;
  ghlConnected: boolean;
  health: HealthLevel;
  churn?: ChurnLevel;
  /** This client's own colour — their brand colour, or the generated one. */
  accent: Accent;
}

/** Each platform's live accounts, by name — what a card's ad facts are read from. */
export type CardAccounts = Readonly<Record<AdPlatform, ReadonlyArray<string | null>>>;

/** What each platform calls one of its accounts, and several. */
const ACCOUNT_NOUN: Record<AdPlatform, readonly [one: string, many: string]> = {
  meta: ["ad account", "ad accounts"],
  google: ["account", "accounts"],
  tiktok: ["advertiser", "advertisers"],
};

/**
 * The card's ad facts: how many accounts are wired, and the line that says so.
 *
 * 🔴 Every platform, not Meta's accounts alone — which is all the list used to
 * count. A client running TikTok alone read "Meta not connected" and, with no
 * CRM wired yet, was sorted into "Not connected yet" beside clients nobody had
 * touched: the one client with a live ad pipe filed as an empty shell. The
 * count feeds `bucketFor`, so it decides the group as well as the words.
 *
 * The label names the platforms actually connected. One platform names itself
 * and its account — "TikTok · Acme Ads", or "TikTok · 2 advertisers" — as the
 * Meta line always gave the account's name; several are listed by name, since
 * one truncating line cannot carry three accounts each.
 */
export function adConnection(accounts: CardAccounts): { label: string; count: number } {
  const connected = AD_PLATFORMS.filter((p) => accounts[p].length > 0);
  const count = AD_PLATFORMS.reduce((n, p) => n + accounts[p].length, 0);
  if (connected.length === 0) return { label: "Ads not connected", count };
  if (connected.length > 1) {
    return { label: connected.map((p) => PLATFORM_LABEL[p]).join(" + "), count };
  }
  const [platform] = connected;
  const names = accounts[platform];
  const [one, many] = ACCOUNT_NOUN[platform];
  const detail = names.length === 1 ? (names[0] ?? `1 ${one}`) : `${names.length} ${many}`;
  return { label: `${PLATFORM_LABEL[platform]} · ${detail}`, count };
}

type Bucket = "live" | "attention" | "unconnected";

/**
 * The three groups, each wearing the house hue for the state it describes.
 *
 * 🔴 `hue` is STATUS and the card accent is IDENTITY. They sit on different
 * objects for that reason — the hue on the heading and its rule, the accent on
 * the card — and nothing on the page paints a card in a status colour or a
 * heading in a client's. A grey section of violet, teal and plum cards reads
 * correctly: seven different clients, all in the same state.
 *
 * One token serves as both band and ink here, which the section-hue rule in
 * globals.css warns against in general — `--series-N` and `--series-N-ink` are
 * deliberately different values, because a mark tuned to the 3:1 floor is too
 * light to set type in. The status tokens are not: they are already dark enough
 * in light and bright enough in dark to carry `--status-ink` as badge fills, and
 * measured against `--surface-app` they run 5.05–9.89:1 as text. The test
 * asserts that rather than trusting this paragraph.
 *
 * "Not connected yet" is muted on purpose. It is the largest group on a young
 * agency and it is not a failure — nobody finished the setup — so it must not
 * shout louder than the one client that actually broke.
 */
const GROUPS: {
  key: Bucket;
  title: string;
  blurb: string;
  hue: string;
}[] = [
  {
    key: "live",
    title: "Live",
    blurb: "Both pipes connected and delivering.",
    hue: "--status-good",
  },
  {
    key: "attention",
    title: "Needs attention",
    blurb: "Wired up, but something is not getting through.",
    hue: "--status-warning",
  },
  {
    key: "unconnected",
    title: "Not connected yet",
    blurb: "Created, never finished — no CRM, no ad account, no events.",
    hue: "--text-muted",
  },
];

/**
 * Which group a client belongs in.
 *
 * 🔴 "Broken" and "never set up" are not the same thing, and the row list
 * showed both as a red ✕ Broken badge. Six of seven accounts reading "Broken"
 * trains the operator to ignore the badge — which is the exact failure this
 * product was built to replace, arriving by a different route. A client with
 * nothing connected has not broken; nobody finished it. That is a different
 * sentence and a different next action, so it is a different group.
 *
 * The badge itself is untouched: `quickHealth` still says what it says, and
 * this only decides where the card sits.
 *
 * `adAccounts` counts every platform (`adConnection`); counting Meta alone is
 * how a TikTok-only client landed among the untouched.
 */
export function bucketFor(
  c: Pick<ClientCard, "health" | "ghlConnected" | "adAccounts" | "firstWebhookAt">,
): Bucket {
  if (c.health === "green") return "live";
  const touched = c.ghlConnected || c.adAccounts > 0 || Boolean(c.firstWebhookAt);
  return touched ? "attention" : "unconnected";
}

export function ClientCards({
  clients,
  staff,
}: {
  clients: ClientCard[];
  staff: boolean;
}) {
  const groups = GROUPS.map((g) => ({
    ...g,
    members: clients.filter((c) => bucketFor(c) === g.key),
  })).filter((g) => g.members.length > 0);

  /*
   * One group and no headings. A heading exists to tell two groups apart, and
   * with nothing to tell it apart from it is a label announcing that everything
   * is the same — which on a one-client agency reads as bureaucracy.
   */
  if (groups.length === 1) {
    return <Grid clients={groups[0].members} staff={staff} />;
  }

  return (
    <div className="flex flex-col gap-9">
      {groups.map((g) => (
        /*
         * `.section-band` is the house mechanism, not a new one: it draws the
         * 3px rule before the heading from `--section-band`, and every section
         * heading in the tree already asks for the ink with a fallback, which
         * `section-hue.test.ts` holds the whole tree to. Both properties
         * inherit, so setting them here is the whole feature — nothing below
         * knows it has a colour.
         *
         * (Do not name the heading tag literally in a comment here: that test
         * scans source text for the opening tag and does not strip comments, so
         * prose mentioning it parses as a heading that forgot its ink.)
         */
        <section
          key={g.key}
          className="section-band"
          style={
            {
              "--section-band": `var(${g.hue})`,
              "--section-ink": `var(${g.hue})`,
            } as CSSProperties
          }
        >
          <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2
              className="text-sm font-semibold tracking-[-0.01em]"
              style={{ color: "var(--section-ink, var(--text-primary))" }}
            >
              {g.title}
            </h2>
            {/*
             * The count stays neutral while the heading takes the hue. A chip
             * tinted in its own colour is the trap `.tint-badge` documents —
             * washing a colour into a ground it then has to be read against
             * eats its own contrast — and it would put a fourth coloured object
             * in a header that already has a rule and a heading.
             */}
            <span
              className="rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-secondary)",
              }}
            >
              {g.members.length}
            </span>
            <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              {g.blurb}
            </span>
          </div>
          <Grid clients={g.members} staff={staff} />
        </section>
      ))}
    </div>
  );
}

function Grid({ clients, staff }: { clients: ClientCard[]; staff: boolean }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {clients.map((c) => (
        <Card key={c.id} c={c} staff={staff} />
      ))}
    </ul>
  );
}

function Card({ c, staff }: { c: ClientCard; staff: boolean }) {
  /*
   * The accent reaches the CSS from here, as an inline custom property, for the
   * same reason `.accent-fill` is a class rather than a style: the colour is
   * per-client data, but the RECIPE that makes it legible — the 6% wash, the
   * 85% spine — belongs in one place in the stylesheet where it was measured.
   */
  const accentVars = { "--accent": c.accent.color } as CSSProperties;

  return (
    /*
      🔴 The remove control is a SIBLING of the link, not a child. A button
      inside an anchor is invalid HTML and, worse, clicking it would follow the
      link — so a destructive action would open the dashboard instead of asking
      anything.
    */
    <li className="relative" style={accentVars}>
      <Link
        href={`/c/${c.slug}`}
        className="card card-interactive client-card flex h-full flex-col gap-3 p-4"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="accent-fill grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius)] text-[13px] font-semibold"
          >
            {c.name.trim().charAt(0).toUpperCase() || "•"}
          </span>
          <div className="min-w-0 flex-1">
            {/*
              Reserving the Remove button's track, not guessing at it: the
              button is `px-2 py-1` around 12px "Remove" — about 66px — pinned
              14px from the card's edge, and the name's own track ends at the
              card's 16px padding. 66 + 14 - 16 = 64, rounded up for the ascender
              on a capital. Without it the name truncates UNDER the button and
              the longest client names are the ones that lose characters.

              Only the name. The meta line below it clears the button's height
              on its own, and padding it would cost width for nothing.
            */}
            <div
              className={`truncate font-semibold${staff ? " pr-[72px]" : ""}`}
              style={{ color: "var(--text-primary)" }}
            >
              {c.name}
            </div>
            {/*
              🔴 --text-secondary, and NOT --text-muted. The card is washed in
              the client's accent at 14%, and muted is the faintest ink in the
              house: carrying this one line in it capped the wash at 6%, which
              is a white card with a coloured edge. See globals.css — the
              budget is measured there, and this line is what it was spent on.
            */}
            <div
              className="mt-0.5 truncate text-[12px]"
              style={{ color: "var(--text-secondary)" }}
            >
              {c.ghlLocationName ?? "GHL not connected"}
              <span aria-hidden="true"> · </span>
              {c.adLabel}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Mirrors the panel above, so a flagged client is findable in the
              list without scrolling back up. */}
          <ChurnChip level={c.churn} />
          {!c.firstWebhookAt && (
            <span
              className="text-[11px] font-medium"
              style={{ color: "var(--status-critical)" }}
            >
              No events yet
            </span>
          )}
          <HealthBadge level={c.health} />
        </div>

        {/*
         * The card is one link, and this is its label rather than a second
         * control inside it — an anchor nested in an anchor is invalid, and a
         * button here would compete with the card for the same click.
         *
         * It says "sub-account" because that is the word the operator already
         * uses: each of these is a GHL sub-account with its own ad accounts
         * behind it, and "Open dashboard" would not say WHOSE.
         */}
        <div
          className="mt-auto flex items-center justify-between gap-2 border-t pt-2.5 text-[12px] font-medium"
          style={{
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          Switch to sub-account
          <Icon name="chevronRight" size={13} aria-hidden="true" />
        </div>
      </Link>

      {staff && (
        <div className="absolute top-3.5 right-3.5">
          <RemoveClient variant="row" clientId={c.id} clientName={c.name} />
        </div>
      )}
    </li>
  );
}
