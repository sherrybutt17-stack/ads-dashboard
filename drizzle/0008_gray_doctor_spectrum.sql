ALTER TABLE "clients" ADD COLUMN "last_meta_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "last_google_reconciled_at" timestamp with time zone;