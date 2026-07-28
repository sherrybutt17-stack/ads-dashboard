CREATE TYPE "public"."meta_account_status" AS ENUM('active', 'paused', 'removed');--> statement-breakpoint
CREATE TABLE "meta_ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"ad_account_id" text NOT NULL,
	"token_encrypted" text,
	"account_name" text,
	"currency" text,
	"timezone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"status" "meta_account_status" DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "fb_daily_metrics_key";--> statement-breakpoint
DROP INDEX "fb_period_reach_key";--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "meta_ad_account_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_period_reach" ADD COLUMN "meta_ad_account_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_ad_accounts" ADD CONSTRAINT "meta_ad_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_ad_accounts_account_key" ON "meta_ad_accounts" USING btree ("ad_account_id");--> statement-breakpoint
CREATE INDEX "meta_ad_accounts_client_idx" ON "meta_ad_accounts" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fb_daily_metrics_key" ON "fb_daily_metrics" USING btree ("client_id","meta_ad_account_id","date","level","meta_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fb_period_reach_key" ON "fb_period_reach" USING btree ("client_id","meta_ad_account_id","period_start","period_end","meta_campaign_id");--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "meta_ad_account_id";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "meta_token_encrypted";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "meta_account_name";