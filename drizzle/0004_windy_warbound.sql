ALTER TYPE "public"."sync_kind" ADD VALUE 'google_daily';--> statement-breakpoint
ALTER TYPE "public"."sync_kind" ADD VALUE 'google_backfill';--> statement-breakpoint
CREATE TABLE "google_ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"refresh_token_encrypted" text,
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
CREATE TABLE "google_daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"customer_id" text DEFAULT '' NOT NULL,
	"date" date NOT NULL,
	"google_campaign_id" text DEFAULT '' NOT NULL,
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
ALTER TABLE "contacts" ADD COLUMN "gclid" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "google_campaign_id" text;--> statement-breakpoint
ALTER TABLE "google_ad_accounts" ADD CONSTRAINT "google_ad_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_daily_metrics" ADD CONSTRAINT "google_daily_metrics_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_ad_accounts_customer_key" ON "google_ad_accounts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "google_ad_accounts_client_idx" ON "google_ad_accounts" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "google_daily_metrics_key" ON "google_daily_metrics" USING btree ("client_id","customer_id","date","google_campaign_id");--> statement-breakpoint
CREATE INDEX "google_daily_metrics_client_date_idx" ON "google_daily_metrics" USING btree ("client_id","date");