"use client";

import { useState } from "react";
import type { CreativeType } from "@/db/schema";
import { Icon, type IconName } from "@/components/Icon";

const TYPE_ICON: Record<CreativeType, IconName> = {
  video: "play",
  image: "image",
  carousel: "layers",
  unknown: "help",
};

/**
 * An ad creative's preview image, with a typed fallback.
 *
 * Shared by the Overview's leaderboard and the Board's creative cards. `src` is
 * our own thumb route on a page, or a data URI in a document (a PDF or share
 * link has no session to call the route with). The stored URLs expire, so a
 * broken image is expected eventually and falls back to a placeholder saying
 * which kind of creative it was, never a browser-default broken icon.
 *
 * `eager` for documents: a PDF is captured once the page settles, and a lazy
 * image below the fold may not have been decoded by then.
 */
export function CreativeThumb({
  src,
  alt,
  type,
  videoSeconds,
  stored,
  eager = false,
  fit = "cover",
  className = "aspect-[1.91/1]",
  height,
}: {
  src: string | null;
  alt: string;
  type: CreativeType;
  videoSeconds: number | null;
  /** Whether a preview was ever stored — "Preview unavailable" vs "No preview". */
  stored: boolean;
  eager?: boolean;
  /** "contain" keeps a vertical video whole on a wide card, letterboxed. */
  fit?: "cover" | "contain";
  className?: string;
  /** A fixed height in px, for a card sized to a printed page. */
  height?: number;
}) {
  const [failed, setFailed] = useState(false);
  const show = Boolean(src) && !failed;

  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden ${height === undefined ? className : ""}`}
      style={{ background: "var(--surface-2)", ...(height !== undefined ? { height } : {}) }}
    >
      {show ? (
        /* Our own tenant-scoped route, or a data URI: `next/image` would need a
           remotePatterns entry for our own origin and would cache across a
           re-resolve. The route's headers already cache the bytes. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src ?? ""}
          alt={alt}
          className={`h-full w-full ${fit === "contain" ? "object-contain" : "object-cover"}`}
          loading={eager ? "eager" : "lazy"}
          decoding={eager ? "sync" : "async"}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex flex-col items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
          <Icon name={TYPE_ICON[type]} size={22} />
          <span className="text-[10px] uppercase tracking-wider">
            {stored ? "Preview unavailable" : "No preview"}
          </span>
        </div>
      )}
      {type === "video" && show && (
        <span
          className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}
        >
          <Icon name="play" size={9} />
          {videoSeconds ? `${Math.round(videoSeconds)}s` : "Video"}
        </span>
      )}
    </div>
  );
}
