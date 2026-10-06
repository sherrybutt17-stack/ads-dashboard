/**
 * Overrides the sidebar skeleton one segment up.
 *
 * 🔴 `loading.tsx` in `/c/[slug]` is the fallback for this route too, and it
 * draws a 232px labelled column — which this page does not have and should not.
 * A report is a document: it is printed, exported as a PDF and handed to a
 * client, so the whole width belongs to the sheet and the only navigation is
 * the "Back to dashboard" link above it. Without this file the reader watches a
 * sidebar appear and then vanish on every load, which reads as a layout bug
 * rather than as a document opening.
 */
export default function Loading() {
  return (
    <div className="flex min-h-full flex-1 flex-col lg:p-5">
      <div className="app-frame flex min-w-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-[820px] px-4 py-6 sm:px-6">
          <div
            className="h-4 w-32 rounded-full"
            style={{ background: "var(--surface-2)" }}
          />
          <div
            className="mt-6 h-[420px] w-full rounded-[var(--radius-lg)]"
            style={{ background: "var(--surface-2)" }}
          />
        </div>
      </div>
    </div>
  );
}
