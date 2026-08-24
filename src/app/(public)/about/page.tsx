import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage, H2 } from "../PublicPage";

export const metadata: Metadata = {
  title: "Growth Guild — advertising and CRM reporting",
  description:
    "A reporting dashboard that joins Facebook and Google Ads spend to CRM pipeline outcomes, for the agency's clients.",
};

/**
 * The application home page.
 *
 * Required by Google's OAuth verification: the consent screen carries an
 * "Application home page" link, and a reviewer who cannot load it without
 * signing in cannot approve the application. It must therefore describe what
 * the app does, who it is for, and — the part reviewers actually check — what
 * the requested scope is used for.
 */
export default function AboutPage() {
  return (
    <PublicPage title="Advertising that is measured all the way to a customer">
      <p>
        Growth Guild builds and runs paid advertising for service businesses.
        This application is the reporting side of that work: it joins what was
        spent on Facebook and Google Ads to what actually happened in the
        client&rsquo;s CRM — enquiries, appointments booked, appointments
        attended, and deals closed.
      </p>
      <p>
        It exists because the usual answer to &ldquo;is my advertising
        working?&rdquo; stops at a cost per lead. A cost per lead says nothing
        about whether those leads answered the phone, turned up, or bought. This
        dashboard reports the whole path, and says plainly when a number is
        missing rather than showing a zero.
      </p>

      <H2>Who uses it</H2>
      <p>
        The agency&rsquo;s staff, and the agency&rsquo;s clients. Every client
        sees only their own data, through their own login. It is not a
        general-purpose product and there is no public sign-up.
      </p>

      <H2>What we ask Google for, and why</H2>
      <p>
        When a client connects their Google Ads account, we request a single
        scope — <code>https://www.googleapis.com/auth/adwords</code> — and use it
        for exactly one thing: reading daily campaign performance (impressions,
        clicks, cost and conversions) so it can be reported alongside the
        client&rsquo;s pipeline.
      </p>
      <p>
        The access is <strong>read-only in practice</strong>. This application
        never creates, edits, pauses or budgets a campaign, and never places a
        bid. A client can revoke it at any time from their Google account, and
        can ask us to disconnect it from within the dashboard.
      </p>

      <H2>Contact</H2>
      <p>
        Questions about this application, your data, or removing your account:{" "}
        <a
          href="mailto:dev@growthguild.us"
          className="underline underline-offset-2"
          style={{ color: "var(--series-1)" }}
        >
          dev@growthguild.us
        </a>
        .
      </p>
      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
        See our <Link href="/legal/privacy" className="underline underline-offset-2">privacy
        policy</Link> and{" "}
        <Link href="/legal/terms" className="underline underline-offset-2">
          terms of service
        </Link>
        .
      </p>
    </PublicPage>
  );
}
