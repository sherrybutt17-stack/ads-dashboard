import Link from "next/link";
import { readableFrom, type SenderSummary } from "@/lib/email-domains/identity";

/**
 * "Sends from …" — one muted line under the email panels, saying whose
 * address the client will see before anyone presses Send.
 *
 * When the agency has no verified domain, it links to where one is set up. The
 * link only appears where custom domains are available at all, so an agency is
 * never pointed at a tab that can only say "not available".
 */
export function SenderLine({ sender }: { sender: SenderSummary | null | undefined }) {
  if (!sender?.from) return null;

  const pending = !sender.viaDomain && sender.domain;
  return (
    <p className="text-[11.5px] leading-snug" style={{ color: "var(--text-muted)" }}>
      {pending ? (
        <>
          <strong style={{ color: "var(--text-secondary)" }}>{sender.domain}</strong>{" "}
          isn&rsquo;t verified yet, so this sends from{" "}
        </>
      ) : (
        <>Sends from{" "}</>
      )}
      {/* The full stop rides inside, so a wrap never strands it on its own line. */}
      <span className="break-words" style={{ color: "var(--text-secondary)" }}>
        {readableFrom(sender.from)}.
      </span>
      {!sender.viaDomain && sender.available && (
        <>
          {" "}
          <Link href="/settings/email-domain" className="underline underline-offset-2">
            {pending ? "Check your domain" : "Send from your own domain"}
          </Link>
        </>
      )}
    </p>
  );
}
