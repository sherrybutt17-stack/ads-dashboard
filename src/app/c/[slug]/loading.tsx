/**
 * Loading UI for a client dashboard.
 *
 * There was none. `loadDashboard` is one blocking `Promise.all` of ~60 queries
 * behind `force-dynamic`, so first paint waited on the slowest of them with the
 * browser showing the previous page — no signal that anything was happening.
 *
 * Skeletons, not a spinner: a shaped placeholder says "your dashboard is
 * arriving and here is its shape", a spinner says "something is stuck". The
 * geometry deliberately mirrors `page.tsx` — same 1400px shell, same header
 * height, same 2/4-column KPI grid — so content lands without the layout jumping
 * under the reader's eye.
 *
 * `.skeleton` (globals.css) carries the shimmer and already honours
 * prefers-reduced-motion.
 */
export default function Loading() {
  return (
    <div className="min-h-full" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading dashboard…</span>

      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3.5 sm:px-6">
          <div className="skeleton h-7 w-7 rounded-[9px]" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="skeleton h-4 w-40" />
            <div className="skeleton h-3 w-24" />
          </div>
          <div className="skeleton h-8 w-[260px] rounded-[10px]" />
          <div className="skeleton h-8 w-8 rounded-[9px]" />
        </div>
      </header>

      <main className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-7 sm:px-6">
        {/* Insight strip */}
        <div className="skeleton h-11 w-full rounded-[12px]" />

        {/* Headline KPIs — matches the live grid so tiles don't reflow in */}
        <section className="grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="card flex flex-col gap-2.5 p-4 sm:p-5">
              <div className="skeleton h-3 w-20" />
              <div className="skeleton h-8 w-28" />
              <div className="skeleton h-3 w-16" />
            </div>
          ))}
        </section>

        {/* Funnel + trend, then the wider sections below */}
        <div className="skeleton h-[280px] w-full rounded-[14px]" />
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="skeleton h-[320px] w-full rounded-[14px]" />
          <div className="skeleton h-[320px] w-full rounded-[14px]" />
        </div>
        <div className="skeleton h-[220px] w-full rounded-[14px]" />
      </main>
    </div>
  );
}
