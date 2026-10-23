import { PAGE_H, PAGE_W } from "@/components/board/BoardDocument";

/**
 * Loading UI for the print view: one blank sheet at the document's size, so
 * the page lands without a jump. No sidebar — the print view has none.
 */
export default function Loading() {
  return (
    <div className="overflow-x-auto" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the print view…</span>
      <div className="mx-auto px-4 py-6" style={{ width: PAGE_W + 32 }}>
        <div className="skeleton rounded-[var(--radius-sm)]" style={{ width: PAGE_W, height: PAGE_H }} />
      </div>
    </div>
  );
}
