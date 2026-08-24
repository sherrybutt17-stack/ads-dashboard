ALTER TABLE "clients" ADD COLUMN "alert_webhook_encrypted" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "alerts_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "alerted_at" timestamp with time zone;