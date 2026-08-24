"use client";

import { useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";

/**
 * Print / save as PDF.
 *
 * ⚠️ **What this cannot do, stated where the code is rather than in a doc:**
 * Chrome stamps the document title, the date, the source URL and the page
 * number into the page margin whenever its "Headers and footers" checkbox is
 * ticked — which is the default. That checkbox is not reachable from CSS or
 * JavaScript, by design. So the first report a client forwards to their board
 * carries this app's URL in the footer.
 *
 * There are exactly two real remedies, neither of them a button:
 *   1. serve the app from the agency's own domain, so the stamp reads as a
 *      letterhead rather than as a leaked internal tool; or
 *   2. render the PDF server-side, where no browser chrome exists.
 *
 * A "please untick Headers and footers" instruction is not a third option — it
 * will not survive one real client, and pretending otherwise is how the URL ends
 * up on the board pack anyway.
 *
 * Rendered only once hydrated: a button whose sole action is `window.print()`
 * is inert without JavaScript, and an inert button on a document sent to
 * someone outside the company is worse than no button.
 *
 * Hydration is detected with `useSyncExternalStore` rather than the more
 * familiar `useState(false)` + `useEffect(() => setState(true))`: the server
 * snapshot is `false` and the client snapshot is `true`, which React resolves
 * during hydration instead of through a second render pass. The store never
 * changes, so `subscribe` has nothing to do.
 */
const NOOP_SUBSCRIBE = () => () => {};

export function PrintButton() {
  const hydrated = useSyncExternalStore(
    NOOP_SUBSCRIBE,
    () => true,
    () => false,
  );
  if (!hydrated) return null;

  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-[12px] font-medium transition-colors hover:opacity-80"
      style={{
        borderColor: "var(--border-strong)",
        background: "var(--surface-1)",
        color: "var(--text-secondary)",
      }}
    >
      <Icon name="printer" size={12} />
      Print or save as PDF
    </button>
  );
}
