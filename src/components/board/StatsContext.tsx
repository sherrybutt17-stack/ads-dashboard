"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { BUILTIN, buildRegistry, type CustomMetric, type Registry } from "@/lib/board/registry";

/**
 * The stats a board's widgets can name — the built-ins and the agency's own
 * metrics — for every component under one board: the view, the editor, the
 * picker, a share link, a printed page.
 *
 * The server hands the agency's metrics down as plain JSON (a component in the
 * browser cannot receive the registry's functions), and this builds the same
 * registry the server used to compute the numbers, so a label, a format and a
 * good/bad direction always match the figure beside them.
 */
const StatsContext = createContext<Registry>(BUILTIN);

export function StatsProvider({
  metrics,
  children,
}: {
  metrics: readonly CustomMetric[] | undefined;
  children: ReactNode;
}) {
  const reg = useMemo(() => (metrics && metrics.length > 0 ? buildRegistry(metrics) : BUILTIN), [metrics]);
  return <StatsContext.Provider value={reg}>{children}</StatsContext.Provider>;
}

/** The board's registry; the built-ins alone outside a provider. */
export function useStats(): Registry {
  return useContext(StatsContext);
}
