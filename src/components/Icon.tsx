import type { CSSProperties } from "react";

/**
 * A small, consistent inline-SVG icon set.
 *
 * Replaces the unicode glyphs (☀ ✓ ✕ ↑ ▾) that render differently on every OS
 * and read as unpolished. All icons are single-stroke, inherit `currentColor`,
 * and share one grid + weight so they look like one family. Decorative by
 * default (aria-hidden) — the surrounding control carries the label.
 */

export type IconName =
  | "sun"
  | "moon"
  | "check"
  | "alert"
  | "x"
  | "help"
  | "arrowUp"
  | "arrowDown"
  | "chevronDown"
  | "arrowLeft";

export function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

const PATHS: Record<IconName, React.ReactNode> = {
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />,
  check: <path d="M20 6 9 17l-5-5" />,
  alert: (
    <>
      <path d="M12 7v6" />
      <path d="M12 17h.01" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  help: (
    <>
      <path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  arrowDown: <path d="M12 5v14M19 12l-7 7-7-7" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  arrowLeft: <path d="M19 12H5M12 19l-7-7 7-7" />,
};
