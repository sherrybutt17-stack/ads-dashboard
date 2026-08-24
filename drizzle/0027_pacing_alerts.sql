-- Budget-pacing alert state: when one last went out, and what it said.
--
-- The status matters as much as the timestamp. A client whose drift reverses —
-- underspending on Monday, overspending by Friday — is told immediately,
-- because the recorded status no longer matches; one that is merely STILL
-- underspending waits out the cooldown instead of repeating the same warning
-- every morning until the channel is muted.
--
-- Both nullable with no default: never alerted is the correct starting state,
-- and it reads as "nothing to suppress" in `decidePacingAlert`.
--
-- Idempotent, and safe in any order relative to the other pending migrations —
-- it touches one table and moves no data. `db:push` generates it too.
ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "last_pacing_alert_at" timestamp with time zone;
ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "last_pacing_alert_status" text;
