import type { Metadata } from "next";
import { PublicPage, H2 } from "../../PublicPage";

export const metadata: Metadata = {
  title: "Privacy policy — Growth Guild",
  description:
    "What data the Growth Guild reporting dashboard collects, why, and how to have it removed.",
};

/**
 * Required by Google's OAuth verification, and genuinely load-bearing: the
 * reviewer checks that the policy names the requested scope and explains what is
 * done with the data it returns. A policy that omits the scope is the most
 * common reason an otherwise fine application goes back for another round.
 *
 * Also states the Limited Use commitment verbatim in substance, which is the
 * clause reviewers look for by name.
 */
export default function PrivacyPage() {
  return (
    <PublicPage title="Privacy policy" updated="29 September 2026">
      <p>
        This policy covers the Growth Guild reporting dashboard — the application
        that joins advertising spend to CRM outcomes for our clients. An agency
        creates its own account; clients get access only through a login their
        agency issues.
      </p>

      <H2>What we hold</H2>
      <p>
        <strong>Advertising data.</strong> Daily campaign performance from
        Facebook, Google Ads and TikTok: impressions, clicks, cost, conversions,
        and the names and identifiers of campaigns, ad sets and ads — plus the
        name, identifier, currency and time zone of each connected ad account.
        Aggregate figures only — never a list of the people who saw an ad.
      </p>
      <p>
        <strong>CRM data.</strong> From the client&rsquo;s own GoHighLevel
        account: enquiries and their progress through the sales pipeline. This
        includes contact details — name, email address and telephone number —
        because the client&rsquo;s own staff use the same records to follow up.
      </p>
      <p>
        <strong>Account data.</strong> Login email addresses for the people we
        grant access to, and a record of significant actions taken in the
        application, so a change can be traced to whoever made it.
      </p>

      <H2>Google user data, specifically</H2>
      <p>
        When a client connects Google Ads, we request one scope:{" "}
        <code>https://www.googleapis.com/auth/adwords</code>. We use it solely to
        read campaign performance metrics for the accounts that client has chosen
        to connect, so those figures can be shown in their dashboard and monthly
        report.
      </p>
      <p>
        We do not use it to create, change, pause or budget campaigns. When a
        client signs in, we list the Google Ads accounts that sign-in can reach —
        their names and identifiers — so the client can choose which to connect;
        we read performance data only from the accounts they choose. From Google
        we store: the daily metrics above, the names and identifiers of the
        chosen accounts and their campaigns, each account&rsquo;s currency and
        time zone, and an encrypted refresh token. Nothing else.
      </p>
      <p>
        <strong>Limited Use.</strong> Our use and transfer of information
        received from Google APIs adheres to the{" "}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          className="underline underline-offset-2"
          style={{ color: "var(--series-1)" }}
          rel="noopener noreferrer"
          target="_blank"
        >
          Google API Services User Data Policy
        </a>
        , including its Limited Use requirements. In particular: this data is
        never sold, never used for advertising, never transferred to others
        except as needed to provide this reporting or where required by law, and
        never read by a human except with the client&rsquo;s consent, for
        security purposes, or to comply with the law.
      </p>

      <H2>What we never do</H2>
      <p>
        We do not sell data. We do not share one client&rsquo;s data with
        another. We do not use client data to train machine-learning models. We
        do not run advertising or analytics trackers on this application.
      </p>

      <H2>Where it is held, and for how long</H2>
      <p>
        Data is stored in a Postgres database hosted by Neon and served from
        Vercel&rsquo;s infrastructure. Credentials — advertising platform tokens
        and CRM tokens — are encrypted at rest with AES-256-GCM. Passwords are
        stored as scrypt hashes and are not recoverable.
      </p>
      <p>
        <strong>Service providers.</strong> A small number of providers process
        data for us, each only to run the part of the application named here:
        Vercel (hosting) and Neon (database) for everything above; Resend, to
        deliver report emails, which carry a link and never figures; and, only
        where these features are switched on, Anthropic, which writes the
        plain-English summary of a report from its aggregated figures (never
        contact details), and a PDF rendering service (Browserless or PDFShift),
        which turns a report page into a PDF when one is requested. None of them
        may use the data for their own purposes.
      </p>
      <p>
        Reporting data is retained for as long as the client is with us, and
        removed within 30 days of a written request or the end of the engagement.
        Disconnecting an advertising account removes its stored credential
        immediately. It does not remove this application from your Google
        account&rsquo;s list of connected apps — to do that, use Google Account
        permissions, below.
      </p>

      <H2>Your choices</H2>
      <p>
        A client may revoke this application&rsquo;s access to their Google
        account at any time from{" "}
        <a
          href="https://myaccount.google.com/permissions"
          className="underline underline-offset-2"
          style={{ color: "var(--series-1)" }}
          rel="noopener noreferrer"
          target="_blank"
        >
          Google Account permissions
        </a>
        , or ask us to disconnect it. Either stops all further data collection
        from that account.
      </p>
      <p>
        To request a copy of your data, or its deletion, email{" "}
        <a
          href="mailto:dev@growthguild.us"
          className="underline underline-offset-2"
          style={{ color: "var(--series-1)" }}
        >
          dev@growthguild.us
        </a>
        . We respond within 30 days.
      </p>

      <H2>Changes</H2>
      <p>
        If this policy changes materially we will tell affected clients directly
        rather than relying on the date at the top of this page.
      </p>
    </PublicPage>
  );
}
