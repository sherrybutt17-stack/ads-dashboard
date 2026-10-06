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
  | "arrowLeft"
  | "play"
  | "image"
  | "layers"
  | "printer"
  | "download"
  | "link"
  | "copy"
  | "trash"
  /* Navigation — the pill rail's destinations. */
  | "grid"
  | "chart"
  | "users"
  | "fileText"
  | "plug"
  | "palette"
  | "presentation"
  | "settings"
  | "shield"
  | "logOut"
  | "search"
  | "plus"
  | "chevronLeft"
  | "chevronRight";

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
      /*
       * 1.75, not 2.
       *
       * At the 14–18px these render at, a 2px stroke on a 24px grid is visually
       * heavier than the 500-weight text beside it, and the icon starts reading
       * as the emphasis in a row where it is meant to be the quiet half. 1.75
       * lands just under the type's weight. It is a single number because the
       * whole point of the set is that it looks like one family.
       */
      strokeWidth={1.75}
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
  play: <path d="M6 4.5v15l13-7.5-13-7.5z" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 16-5-5L5 20" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5z" />
      <path d="m3 14 9 5 9-5" />
    </>
  ),
  printer: (
    <>
      <path d="M6 9V3h12v6" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <path d="M6 14h12v7H6z" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.1.1l3-3a5 5 0 0 0-7.1-7.1L11.5 4.5" />
      <path d="M14 11a5 5 0 0 0-7.1-.1l-3 3a5 5 0 0 0 7.1 7.1l1.4-1.4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  chart: (
    <>
      <path d="M3 3v18h18" />
      <path d="M8 17V10" />
      <path d="M13 17v-4" />
      <path d="M18 17V6" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  fileText: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M15 2v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </>
  ),
  plug: (
    <>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </>
  ),
  palette: (
    <>
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.83-.44-1.12-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2A5.55 5.55 0 0 0 22 10.83C21.97 6.01 17.46 2 12 2Z" />
      <circle cx="6.5" cy="12.5" r="1" />
      <circle cx="8.5" cy="7.5" r="1" />
      <circle cx="13.5" cy="6.5" r="1" />
      <circle cx="17.5" cy="10.5" r="1" />
    </>
  ),
  presentation: (
    <>
      <path d="M2 3h20" />
      <path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3" />
      <path d="m7 21 5-4 5 4" />
    </>
  ),
  settings: (
    <>
      <path d="M12.9 2.3a1.6 1.6 0 0 0-1.8 0l-1 .7a1.6 1.6 0 0 1-1.3.24l-1.16-.3a1.6 1.6 0 0 0-1.73.75l-.6 1.04a1.6 1.6 0 0 1-.96.75l-1.15.32a1.6 1.6 0 0 0-1.17 1.55v1.2a1.6 1.6 0 0 1-.44 1.1l-.84.88a1.6 1.6 0 0 0 0 2.2l.84.88c.28.3.44.69.44 1.1v1.2a1.6 1.6 0 0 0 1.17 1.55l1.15.32c.4.11.75.38.96.75l.6 1.04c.35.6 1.06.9 1.73.75l1.16-.3c.45-.1.93-.02 1.3.24l1 .7c.54.38 1.26.38 1.8 0l1-.7c.37-.26.85-.35 1.3-.24l1.16.3a1.6 1.6 0 0 0 1.73-.75l.6-1.04c.21-.37.56-.64.96-.75l1.15-.32a1.6 1.6 0 0 0 1.17-1.55v-1.2c0-.41.16-.8.44-1.1l.84-.88a1.6 1.6 0 0 0 0-2.2l-.84-.88a1.6 1.6 0 0 1-.44-1.1v-1.2a1.6 1.6 0 0 0-1.17-1.55l-1.15-.32a1.6 1.6 0 0 1-.96-.75l-.6-1.04a1.6 1.6 0 0 0-1.73-.75l-1.16.3a1.6 1.6 0 0 1-1.3-.24Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  shield: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </>
  ),
  logOut: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
};
