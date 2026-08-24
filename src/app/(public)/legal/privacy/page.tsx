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
    <PublicPage title="Privacy policy" updated="13 August 2026">
      <p>
        This policy covers the Growth Guild reporting dashboard — the application
        that joins advertising spend to CRM outcomes for our clients. It is not a
        public product; access is by invitation, through a login we issue.
      </p>

      <H2>What we hold</H2>
      <p>
        <strong>Advertising data.</strong> Daily campaign performance from
        Facebook and Google Ads: impressions, clicks, cost, conversions, and the
        names and identifiers of campaigns, ad sets and ads. Aggregate figures
        only — never a list of the people who saw an ad.
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
        We do not use it to create, change, pause or budget campaigns. We do not
        read data from any Google Ads account the client has not explicitly
        selected. We store the resulting metrics and an encrypted refresh token,
        nothing else from Google.
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
        Data is stored in a managed Postgres database and served from
        Vercel&rsquo;s infrastructure. Credentials — advertising platform tokens
        and CRM tokens — are encrypted at rest with AES-256-GCM. Passwords are
        stored as scrypt hashes and are not recoverable.
      </p>
      <p>
        Reporting data is retained for as long as the client is with us, and
        removed within 30 days of a written request or the end of the engagement.
        Disconnecting an advertising account removes its stored credential
        immediately.
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
