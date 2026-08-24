import type { Metadata } from "next";
import { PublicPage, H2 } from "../../PublicPage";

export const metadata: Metadata = {
  title: "Terms of service — Growth Guild",
  description:
    "Terms covering use of the Growth Guild reporting dashboard by the agency's clients.",
};

export default function TermsPage() {
  return (
    <PublicPage title="Terms of service" updated="13 August 2026">
      <p>
        These terms cover use of the Growth Guild reporting dashboard. They sit
        alongside — and do not replace — the service agreement between Growth
        Guild and each client. Where the two disagree, the service agreement
        wins.
      </p>

      <H2>Access</H2>
      <p>
        Access is by invitation. We issue a login to named people at each client,
        and to our own staff. Accounts are personal: do not share a login or its
        password. Tell us promptly if you believe an account has been
        compromised, and we will disable it.
      </p>
      <p>
        Each login can see only the clients it has been granted. Attempting to
        reach another client&rsquo;s data is grounds for immediate removal.
      </p>

      <H2>What the dashboard is</H2>
      <p>
        A reporting tool. It reads from advertising platforms and from the
        client&rsquo;s CRM and presents the result. It does not place, change or
        stop advertising, and nothing shown here is financial, legal or medical
        advice.
      </p>

      <H2>Accuracy, stated honestly</H2>
      <p>
        Figures come from third-party systems and inherit their behaviour.
        Advertising platforms restate recent performance for up to 28 days as
        attribution windows fill, so recent numbers move; where that applies, the
        dashboard marks the figures as provisional rather than presenting them as
        settled.
      </p>
      <p>
        Pipeline history accumulates from the moment the CRM connection is live
        and cannot be reconstructed for any period before it. We do not present
        estimates as measurements: where a figure cannot be computed, the
        dashboard shows a dash and says why.
      </p>

      <H2>Connected accounts</H2>
      <p>
        Connecting an advertising account grants this application read access to
        that account&rsquo;s performance data. You may disconnect it at any time,
        from within the dashboard or from the platform&rsquo;s own permissions
        page. Disconnecting stops further collection; previously reported figures
        remain in your historical reports unless you ask us to remove them.
      </p>

      <H2>Availability</H2>
      <p>
        We aim to keep the dashboard available but do not offer a guaranteed
        uptime. Planned work is scheduled outside business hours where possible.
        Data collection is resilient to short outages — a missed sync is caught
        up by the next one — but reporting is not a substitute for the
        platforms&rsquo; own systems of record.
      </p>

      <H2>Liability</H2>
      <p>
        The dashboard is provided as part of the wider service, and our liability
        for it is governed by the limits in the service agreement. We are not
        liable for decisions taken solely on the basis of a figure shown here
        without reference to the underlying platform.
      </p>

      <H2>Ending access</H2>
      <p>
        Either party may end access in line with the service agreement. On
        ending, we remove stored credentials immediately and remaining data
        within 30 days of a written request.
      </p>

      <H2>Contact</H2>
      <p>
        <a
          href="mailto:dev@growthguild.us"
          className="underline underline-offset-2"
          style={{ color: "var(--series-1)" }}
        >
          dev@growthguild.us
        </a>
      </p>
    </PublicPage>
  );
}
