/**
 * Loading UI for a client dashboard.
 *
 * There was none. `loadDashboard` is one blocking `Promise.all` of ~60 queries
 * behind `force-dynamic`, so first paint waited on the slowest of them with the
 * browser showing the previous page — no signal that anything was happening.
 *
 * Skeletons, not a spinner: a shaped placeholder says "your dashboard is
 * arriving and here is its shape", a spinner says "something is stuck".
 *
 * 🔴 The geometry deliberately mirrors `page.tsx` and has to be edited WITH it.
 * Same page inset, same sidebar width, same frame, same header height, same 2/4
 * column KPI grid — so content lands without the layout jumping under the
 * reader's eye. A skeleton that no longer matches is worse than none: it
 * promises a shape and then shifts everything the moment the data arrives. The
 * sidebar is drawn solid rather than shimmering because it is chrome, not
 * content — it looks identical before and after, so it should not advertise a
 * wait.
 *
 * `.skeleton` (globals.css) carries the shimmer and already honours
 * prefers-reduced-motion.
 */
export default function Loading() {
  return (
    <div
      className="flex min-h-full flex-1 flex-col gap-3 lg:flex-row lg:gap-5 lg:p-5"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading dashboard…</span>

      <div className="sidenav flex shrink-0 flex-col gap-1 px-3 py-3 lg:sticky lg:top-5 lg:h-[calc(100vh-40px)] lg:w-[232px] lg:px-4 lg:py-5">
        <div className="mb-2 flex items-center gap-2.5 px-1 py-1">
          <div
            className="h-9 w-9 shrink-0 rounded-[var(--radius)]"
            style={{ background: "var(--surface-2)" }}
          />
          <div
            className="h-4 w-28 rounded-full"
            style={{ background: "var(--surface-2)" }}
          />
        </div>
        <div className="flex flex-row gap-1 lg:flex-col">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-10 w-[104px] shrink-0 rounded-[var(--radius-sm)] lg:w-full"
              style={{ background: "var(--surface-2)" }}
            />
          ))}
        </div>
      </div>

      <div className="app-frame flex min-w-0 flex-1 flex-col">
        <header className="border-b" style={{ borderColor: "var(--border)" }}>
          <div className="flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3.5 sm:px-6">
            <div className="skeleton h-9 w-9 rounded-[var(--radius)]" />
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="skeleton h-3.5 w-24 rounded-full" />
              <div className="skeleton h-4 w-40 rounded-full" />
            </div>
            <div className="skeleton h-8 w-[260px] rounded-[var(--radius)]" />
            <div className="skeleton h-8 w-8 rounded-[var(--radius-sm)]" />
          </div>
          {/* The segmented switcher. */}
          <div className="px-4 pb-3 sm:px-6">
            <div className="skeleton h-[42px] w-[320px] rounded-full" />
          </div>
        </header>

        <main className="flex flex-col gap-6 px-4 py-7 sm:px-6">
          {/* "What changed" — the notched panel, tab and all. */}
          <div className="skeleton mt-[42px] h-[72px] w-full rounded-[0_20px_20px_20px]" />

          {/* Headline KPIs — matches the live grid so tiles don't reflow in */}
          <section className="grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="card flex flex-col gap-2.5 p-4 sm:p-5">
                <div className="skeleton h-3 w-20 rounded-full" />
                <div className="skeleton h-8 w-28 rounded-[var(--radius-sm)]" />
                <div className="skeleton h-3 w-16 rounded-full" />
              </div>
            ))}
          </section>

          {/* Funnel + trend, then the wider sections below */}
          <div className="skeleton h-[280px] w-full rounded-[var(--radius-xl)]" />
          <div className="grid gap-6 xl:grid-cols-2">
            <div className="skeleton h-[320px] w-full rounded-[var(--radius-xl)]" />
            <div className="skeleton h-[320px] w-full rounded-[var(--radius-xl)]" />
          </div>
          <div className="skeleton h-[220px] w-full rounded-[var(--radius-xl)]" />
        </main>
      </div>
    </div>
  );
}
