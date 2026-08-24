-- TikTok gets its own reconcile marker, for the same reason Meta and Google
-- have separate ones: the three platforms reconcile on three separate crons,
-- and a shared column would let whichever ran first mark the client done and
-- make the other two skip it permanently.
--
-- Nullable with no default, deliberately. NULL reads as "never reconciled",
-- which `isReconcileOverdue` treats as overdue — so every existing client is
-- picked up by the very next run rather than appearing already trued up.
--
-- Idempotent, like the rest of the queue, so a partial apply can be re-run.
-- Safe before or after 0023/0024; it touches no data and no other table.
ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "last_tiktok_reconciled_at" timestamp with time zone;
