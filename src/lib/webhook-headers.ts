/**
 * What a stored webhook event keeps of its request headers.
 *
 * Everything `x-`, plus `content-type` and `user-agent` — what helps diagnose a
 * sender — EXCEPT Vercel's own `x-vercel-*`. Those are the platform talking to
 * itself: a sign-in token for this deployment (`x-vercel-oidc-token`), proxy
 * signatures, routing ids. They say nothing about the sender, a token has no
 * business sitting in a table, and they were most of every stored event —
 * ~170 MB of a 1 GB database on 27 Oct 2026.
 *
 * Nothing reads them back. The one stored header anything reads is our own
 * `__signature` mark (the install flow, `lib/ghl/oauth.ts`), and GHL's
 * signature headers stay.
 */
export function headersToStore(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  headers.forEach((v, k) => {
    if (isPlatformHeader(k)) return;
    // Skip hop-by-hop noise; keep anything that helps diagnose a sender.
    if (k.startsWith("x-") || k === "content-type" || k === "user-agent") {
      kept[k] = v;
    }
  });
  return kept;
}

/** Vercel's own headers. The SQL below matches the same names: `LIKE 'x-vercel-%'`. */
export function isPlatformHeader(name: string): boolean {
  return name.toLowerCase().startsWith("x-vercel-");
}

/*
 * ── The clean-up of events stored before `headersToStore` ──────────────
 *
 * Run by `scripts/trim-webhook-headers.ts`; pinned on PGlite by
 * `webhook-headers.test.ts`, so the SQL tested is the SQL run.
 *
 * One batch = the next 1,000 events by id after `$1`, each its own short
 * statement, so webhooks keep landing while it runs. Only `x-vercel-*` keys
 * go; every other header, `__signature` and every payload are untouched. A
 * `headers` that is NULL or not an object is left alone (the CASE keeps
 * `jsonb_object_keys` from ever seeing one).
 */
export const TRIM_BATCH_SQL = `
WITH batch AS (
  SELECT id FROM webhook_events WHERE id > $1::uuid ORDER BY id LIMIT 1000
), trimmed AS (
  UPDATE webhook_events AS w
     SET headers = w.headers - ARRAY(SELECT k FROM jsonb_object_keys(w.headers) AS k WHERE k LIKE 'x-vercel-%')
    FROM batch
   WHERE w.id = batch.id
     AND CASE WHEN jsonb_typeof(w.headers) = 'object'
              THEN EXISTS (SELECT 1 FROM jsonb_object_keys(w.headers) AS k WHERE k LIKE 'x-vercel-%')
              ELSE false END
  RETURNING 1
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1)::text AS last_id, (SELECT count(*) FROM trimmed)::int AS trimmed`;

/** How many stored events still carry a Vercel header. */
export const COUNT_UNTRIMMED_SQL = `
SELECT count(*)::int AS n FROM webhook_events
 WHERE CASE WHEN jsonb_typeof(headers) = 'object'
            THEN EXISTS (SELECT 1 FROM jsonb_object_keys(headers) AS k WHERE k LIKE 'x-vercel-%')
            ELSE false END`;

/** `pg`'s Client and PGlite both answer this shape. */
type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** Every batch, start to end. Returns how many events were trimmed. */
export async function trimStoredPlatformHeaders(
  query: Query,
  onBatch?: (trimmedSoFar: number) => void,
): Promise<number> {
  let after = "00000000-0000-0000-0000-000000000000";
  let total = 0;
  for (;;) {
    const { rows } = await query(TRIM_BATCH_SQL, [after]);
    const last = rows[0]?.last_id;
    if (typeof last !== "string") return total;
    total += Number(rows[0].trimmed);
    onBatch?.(total);
    after = last;
  }
}
