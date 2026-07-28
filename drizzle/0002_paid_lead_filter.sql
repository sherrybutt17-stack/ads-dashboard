CREATE TYPE "public"."paid_lead_filter" AS ENUM('all', 'attributed', 'tagged', 'either');--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "paid_lead_filter" "paid_lead_filter" DEFAULT 'either' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "paid_lead_tag" text DEFAULT 'facebook-lead' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "tags" text[];