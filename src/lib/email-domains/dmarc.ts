import { resolveTxt } from "node:dns/promises";

/**
 * Does this domain already have a DMARC policy — its own, or one it inherits?
 *
 * Asked so the Email domain tab can suggest a DMARC record ONLY when there is
 * none at any level. Two DMARC records on one name make the policy invalid,
 * and a `p=none` added under a parent that says `p=reject` would quietly weaken
 * the protection the agency already has. So the walk goes up from the domain
 * (`_dmarc.mail.acme.co.uk`, `_dmarc.acme.co.uk`, …) and stops at the first
 * policy found.
 *
 * Returns null when DNS could not be asked — a timeout, a resolver error —
 * because "unknown" must read as "don't suggest anything", never as "none".
 */

export type DmarcLookup = { found: true; at: string } | { found: false } | null;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("DNS lookup timed out")), ms)),
  ]);
}

const NO_RECORD = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

export async function findDmarc(domain: string, timeoutMs = 2_000): Promise<DmarcLookup> {
  const labels = domain.split(".");
  try {
    for (let i = 0; i <= labels.length - 2; i++) {
      const name = labels.slice(i).join(".");
      const records = await withTimeout(resolveTxt(`_dmarc.${name}`), timeoutMs).catch((err) => {
        if (NO_RECORD.has((err as { code?: string })?.code ?? "")) return [] as string[][];
        throw err;
      });
      if (records.some((chunks) => chunks.join("").trim().toLowerCase().startsWith("v=dmarc1"))) {
        return { found: true, at: name };
      }
    }
    return { found: false };
  } catch {
    return null;
  }
}
