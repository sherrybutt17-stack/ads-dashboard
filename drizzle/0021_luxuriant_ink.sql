ALTER TYPE "public"."sync_kind" ADD VALUE 'tiktok_daily';--> statement-breakpoint
ALTER TYPE "public"."sync_kind" ADD VALUE 'tiktok_intraday';--> statement-breakpoint
ALTER TYPE "public"."sync_kind" ADD VALUE 'tiktok_backfill';--> statement-breakpoint
CREATE TABLE "tiktok_ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"advertiser_id" text NOT NULL,
	"advertiser_name" text,
	"access_token_encrypted" text,
	"currency" text,
	"timezone" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tiktok_daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"advertiser_id" text DEFAULT '' NOT NULL,
	"date" date NOT NULL,
	"tiktok_campaign_id" text DEFAULT '' NOT NULL,
	"campaign_name" text,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"spend" numeric(14, 4) DEFAULT '0' NOT NULL,
	"conversions" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "report_sends_period_key";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "ttclid" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "tiktok_campaign_id" text;--> statement-breakpoint
ALTER TABLE "tiktok_ad_accounts" ADD CONSTRAINT "tiktok_ad_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiktok_daily_metrics" ADD CONSTRAINT "tiktok_daily_metrics_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tiktok_ad_accounts_key" ON "tiktok_ad_accounts" USING btree ("client_id","advertiser_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tiktok_daily_metrics_key" ON "tiktok_daily_metrics" USING btree ("client_id","advertiser_id","date","tiktok_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_sends_period_key" ON "report_sends" USING btree ("client_id","platform","period_key") WHERE status <> 'failed';