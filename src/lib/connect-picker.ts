/**
 * Selection logic shared by the three "which of these belong to this client?"
 * pickers on the setup page (Facebook, Google, TikTok).
 *
 * Pure and dependency-free, so the attach routes can import the same cap the
 * pickers enforce, and so it can be tested without rendering anything.
 */

/**
 * The most accounts one sign-in can attach in one go.
 *
 * The attach routes reject a longer list outright, and the sign-in is used up
 * by the first attach that succeeds, so a second batch needs a fresh sign-in.
 * Each attach also verifies every account with the platform inside one request.
 */
export const MAX_ATTACH_PER_SIGN_IN = 50;

/**
 * Asked before attaching more than this many at once.
 *
 * "Select all" makes it a single click to put dozens of different businesses'
 * spend on one client's dashboard — and an account can only belong to one
 * client — so a large attach is confirmed rather than assumed.
 */
export const CONFIRM_ATTACH_ABOVE = 10;

/** `picked` plus every id in `ids`. A new set; the input is not modified. */
export function selectAll(picked: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(picked);
  for (const id of ids) next.add(id);
  return next;
}

/** `picked` without any id in `ids`. A new set; the input is not modified. */
export function deselectAll(picked: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(picked);
  for (const id of ids) next.delete(id);
  return next;
}

/** How many of `ids` are in `picked`: none, some, or all (an empty list is "none"). */
export function coverage(
  picked: ReadonlySet<string>,
  ids: readonly string[],
): "none" | "some" | "all" {
  let n = 0;
  for (const id of ids) if (picked.has(id)) n++;
  if (n === 0) return "none";
  return n === ids.length ? "all" : "some";
}

export interface GoogleNode {
  customerId: string;
  isManager: boolean;
  /**
   * The manager this account is reached THROUGH, as discovery resolved it: `""`
   * (or absent) when the sign-in reaches it directly.
   */
  loginCustomerId?: string | null;
}

/**
 * For each manager, the attachable accounts reached through it.
 *
 * The picker lists managers first and then every account by name, so the tree
 * is not visible in the order of the rows; this is what lets one tick on a
 * manager select the accounts that sit under it. Accounts are grouped by the
 * manager they are reached through (`loginCustomerId`), which is the same
 * manager the sync will call through — so "selected under X" and "synced via X"
 * cannot disagree. Managers themselves are never included: they hold no
 * campaigns, and the attach route refuses them.
 */
export function accountsByManager(nodes: readonly GoogleNode[]): Map<string, string[]> {
  const managers = new Set(nodes.filter((n) => n.isManager).map((n) => n.customerId));
  const out = new Map<string, string[]>();
  for (const m of managers) out.set(m, []);
  for (const n of nodes) {
    if (n.isManager) continue;
    const via = n.loginCustomerId ?? "";
    if (via && via !== n.customerId && managers.has(via)) out.get(via)!.push(n.customerId);
  }
  return out;
}
