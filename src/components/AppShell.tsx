/**
 * The rounded frame every non-dashboard page sits on.
 *
 * The client dashboard builds its own version of this inline — not because it
 * needs a different arrangement, it does not, but because the client's accent
 * colour is set as custom properties on the outermost element and has to reach
 * the sidebar and the frame alike. Passing a `style` through here would be one
 * prop that exactly one caller ever sets. Everything else — the roll-up,
 * Settings, Users, Audit, Connections, Branding — wants exactly this.
 *
 * The inset padding is the design, not decoration: a flat grey ground showing
 * on all four sides is what makes the frame read as one object rather than as a
 * background colour. It collapses below `lg`, where 20px of margin plus a 32px
 * radius would eat the usable width of a phone — `.app-frame` drops its radius
 * and its shadow at the same breakpoint so the two stay in step.
 *
 * ── The `nav` slot ────────────────────────────────────────────────────
 *
 * A sidebar, when the page has one, sits OUTSIDE the frame and shares the flex
 * row with it — the same arrangement the dashboard uses. Putting it inside
 * would make the frame's `overflow: clip` fight the sidebar's
 * `position: sticky`, and a sticky element inside a clipping ancestor simply
 * stops sticking, silently.
 *
 * The slot is optional because not every page that uses this frame has
 * somewhere to navigate to: the public pages, `not-found`, and the OAuth
 * result screen all render without a session, and a sidebar offering Settings
 * and Audit log to someone who is not signed in is an invitation to a
 * redirect. Those pass nothing and get exactly the frame they got before.
 *
 * Report and Present are the other two that pass nothing, for the opposite
 * reason: they are a printable document and a deck shown to a room, and both
 * want the full width. Each carries its own `loading.tsx` so the sidebar
 * skeleton one segment up does not flash a column they will never render.
 */
export function AppShell({
  children,
  nav,
}: {
  children: React.ReactNode;
  nav?: React.ReactNode;
}) {
  if (!nav) {
    return (
      <div className="flex min-h-full flex-1 flex-col lg:p-5">
        <div className="app-frame flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col lg:flex-row lg:gap-5 lg:p-5">
      {nav}
      <div className="app-frame flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
