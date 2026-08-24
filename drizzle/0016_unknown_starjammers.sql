ALTER TABLE "google_ad_accounts" ADD COLUMN "login_customer_id" text;--> statement-breakpoint
ALTER TABLE "google_ad_accounts" ADD COLUMN "is_manager" boolean DEFAULT false NOT NULL;