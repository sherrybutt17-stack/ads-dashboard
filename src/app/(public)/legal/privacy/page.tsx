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
 *
 * 🔴 "How we protect your data" is the section Google's review failed us on
 * (1 Oct 2026: "does not specify any data protection mechanisms for sensitive
 * data") — the encryption facts were here, but scattered under storage. Every
 * line in it is true of this codebase or its providers; keep it that way, since
 * a reviewer or a client's lawyer may hold us to each one.
 */
export default function PrivacyPage() {
  return (
    <PublicPage title="Privacy policy" updated="23 October 2026">
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
          style={{ color: "var(--accent)" }}
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
        Vercel&rsquo;s infrastructure. How it is protected there is set out in
        the next section.
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

      <H2>How we protect your data</H2>
      <p>
        We treat everything we hold as sensitive data — Google user data and the
        other advertising figures, CRM contact details, and login details alike
        — and protect it as follows.
      </p>
      <p>
        <strong>Encryption in transit.</strong> The dashboard is served only
        over HTTPS (TLS): plain-HTTP requests are redirected, and browsers are
        told to use HTTPS only (HSTS). The application&rsquo;s connections to
        its database and to Google, Facebook, TikTok and GoHighLevel are
        encrypted with TLS as well.
      </p>
      <p>
        <strong>Encryption at rest.</strong> The database is encrypted at rest
        with AES-256 by our database provider. In addition, every access and
        refresh token we hold for an advertising or CRM account — Google refresh
        tokens included — is encrypted by the application with AES-256-GCM
        before it is stored, under a key kept outside the database in our
        hosting provider&rsquo;s encrypted configuration. Passwords are stored
        only as scrypt hashes and cannot be recovered, even by us.
      </p>
      <p>
        <strong>Access control.</strong> The dashboard and its data require a
        signed-in account, and every request is checked on the server against
        that account&rsquo;s role: a client sees only their own dashboards, and
        an agency only its own clients. Sign-in sessions use secure, HTTP-only
        cookies that expire, and repeated sign-in attempts are rate-limited.
        Access to the production database and hosting accounts is limited to the
        Growth Guild staff who run the service, and is used only to operate and
        support it.
      </p>
      <p>
        <strong>Shared report links.</strong> A report link that an agency
        chooses to share opens that one report without a sign-in. Each link
        expires, can be revoked at any time, can require a password, and is
        stored only as a one-way hash, so the link itself cannot be recovered
        from our database.
      </p>
      <p>
        <strong>Audit trail.</strong> Sign-ins, connections, exports and other
        significant actions are recorded, so access to data can be traced to the
        person who made it. Tokens and passwords are never written into it.
      </p>
      <p>
        <strong>Minimum access.</strong> We request only the access described
        above and store only the data this policy lists. We only ever read from
        connected advertising and CRM accounts; we never change them.
      </p>
      <p>
        <strong>If something goes wrong.</strong> If we learn of a security
        incident affecting your data, we will tell the affected agencies and
        clients promptly, along with what we are doing about it.
      </p>

      <H2>Your choices</H2>
      <p>
        A client may revoke this application&rsquo;s access to their Google
        account at any time from{" "}
        <a
          href="https://myaccount.google.com/permissions"
          className="underline underline-offset-2"
          style={{ color: "var(--accent)" }}
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
          style={{ color: "var(--accent)" }}
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
