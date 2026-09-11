-- The half-finished connect flow, moved out of process memory.
--
-- The credential handed back by an OAuth callback was parked in a module-scope
-- Map while the operator chose which ad accounts to attach -- one Map for Meta,
-- one for Google. On Vercel the callback and the picker are different route
-- handlers: different serverless functions, each scaling to its own instances.
-- The Map that was written was never the Map that got read, so BOTH self-serve
-- flows reported "that sign-in has expired" on every single attempt, at any
-- speed, and the message was indistinguishable from a genuine timeout.
--
-- The rules that made an in-memory stash defensible are kept as properties of
-- this table instead: the token is encrypted, expires_at is fifteen minutes
-- out, every read prunes what has passed, the row is deleted the moment the
-- accounts are attached, and it cascades with the client.
--
-- One table for both providers on purpose. Two would be two prune rules and two
-- tenant checks that begin identical and drift apart.
--
-- Idempotent and order-independent: it creates one table and moves no data.
CREATE TABLE IF NOT EXISTS "connect_stash" (
  "id" text PRIMARY KEY,
  "provider" text NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "token_encrypted" text NOT NULL,
  -- When the CREDENTIAL dies, not when the stash does. Null for a Google
  -- refresh token and for a Meta token Facebook declared non-expiring.
  "token_expires_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Pruning runs on every read, so it is on the hot path of both connect flows.
CREATE INDEX IF NOT EXISTS "connect_stash_expires_at"
  ON "connect_stash" ("expires_at");
