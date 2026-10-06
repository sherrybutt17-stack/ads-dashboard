"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import type { SectionGroup } from "@/lib/dashboard/registry";

export interface NavGroup {
  id: SectionGroup;
  label: string;
  blurb: string;
  /**
   * The tab's URL, resolved by the SERVER.
   *
   * 🔴 Data, not a function, and that is not a style preference. This file is a
   * Client Component and its only caller is a Server Component, so every prop
   * crossing that boundary has to serialise. A `hrefForGroup: (g) => string`
   * prop type-checks, builds, and then throws at render — "Functions cannot be
   * passed directly to Client Components" — which React swallows into a boundary
   * that still returns 200. The observable symptom is that the tab bar is
   * silently absent, with nothing in the browser to say why.
   */
  href: string;
}

/**
 * The section switcher — which slice of this dashboard is on screen.
 *
 * These are deliberately NOT in the rail beside them. A destination takes you
 * to a different page; these change what one page is showing, and putting the
 * two kinds in the same list is how "Overview" and "Connections" end up looking
 * like peers when one is a tab and the other is a different screen with its own
 * URL, its own data and its own failure modes.
 *
 * Rendered as links rather than buttons on purpose: each group is a real URL
 * (`?tab=ads`), so it is back-buttonable, shareable and right-clickable. The
 * `aria-current="page"` is what both the styling and assistive tech read.
 *
 * It scrolls horizontally rather than wrapping. A segmented control that wraps
 * to two lines stops reading as one control, and four labels plus the header's
 * other contents was already exactly the width where that happens — at seven
 * groups, one of them called "Where the money went", the overflow is the normal
 * case rather than the edge one. Two things make a scrolling control usable
 * rather than merely non-broken: the active tab is scrolled into view on load
 * (a reader who lands on `?tab=reports` must not have to hunt for the tab they
 * are already on), and the strip carries an inline edge fade so a cut-off label
 * reads as "there is more this way" instead of as a rendering bug.
 *
 * The fade is painted with `mask-image`, not an overlaid gradient: a gradient
 * would need to know the header's background colour, which changes with theme
 * and with the client's accent, and a hardcoded one shows as a grey smear the
 * moment either moves.
 */
export function DashboardTabs({
  groups,
  activeGroup,
}: {
  groups: readonly NavGroup[];
  activeGroup: SectionGroup;
}) {
  const strip = useRef<HTMLElement | null>(null);

  /*
   * Bring the active tab into view when the strip is wider than the screen.
   *
   * `scrollIntoView` on the LINK would scroll the page as well as the strip —
   * it walks every scrollable ancestor — and on a phone that jumps the reader
   * past the header they just tapped in. Setting `scrollLeft` on the strip
   * itself moves exactly one box and nothing else.
   *
   * `behavior: "auto"` on purpose: this fires on load, and a tab sliding into
   * place as the page appears reads as a glitch, not as motion. It is also why
   * there is no reduced-motion branch — there is no motion to reduce.
   */
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && el.scrollWidth > el.clientWidth) {
      const target =
        active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2;
      el.scrollLeft = Math.max(0, target);
    }
  }, [activeGroup]);

  /*
   * Which edges have content hidden past them, as a `data-overflow` attribute
   * the stylesheet reads to place the fade.
   *
   * This is a MEASUREMENT, not a guess at the breakpoint. Tab labels are
   * client-supplied text at a font the browser may still be swapping, so the
   * width at which seven tabs stop fitting is not a number this file can know.
   *
   * Written straight to the DOM rather than held in state: it changes on every
   * frame of a scroll, and a `setState` per frame re-renders seven links to
   * change one attribute. The attribute is the state.
   *
   * Three listeners, because the strip stops overflowing for three different
   * reasons: the reader scrolled it, the window resized, or the font finished
   * loading and every label got wider. The last one is the easiest to miss and
   * the most visible when it happens — the fade sits on a strip that no longer
   * overflows until something else nudges it.
   */
  useEffect(() => {
    const el = strip.current;
    if (!el) return;

    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      // 1px of slack: fractional layout widths leave sub-pixel scroll room on a
      // strip that visibly fits, which would otherwise pin a permanent fade.
      if (max <= 1) {
        el.removeAttribute("data-overflow");
        return;
      }
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft < max - 1;
      el.dataset.overflow =
        left && right ? "both" : left ? "left" : right ? "right" : "";
    };

    measure();
    el.addEventListener("scroll", measure, { passive: true });

    const ro = new ResizeObserver(measure);
    ro.observe(el);

    // `document.fonts` is absent in older engines and in some test environments;
    // the fade is simply measured once less often there.
    document.fonts?.ready.then(measure).catch(() => {});

    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [groups.length, activeGroup]);

  return (
    <nav
      ref={strip}
      aria-label="Dashboard sections"
      className="tab-strip -mx-1 max-w-full overflow-x-auto px-1 py-0.5"
      style={{ scrollbarWidth: "none" }}
    >
      <div className="segmented">
        {groups.map((g) => (
          <Link
            key={g.id}
            href={g.href}
            aria-current={g.id === activeGroup ? "page" : undefined}
            title={g.blurb}
            className="seg-link"
          >
            {g.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
