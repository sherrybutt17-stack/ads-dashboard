CREATE TYPE "public"."breakdown_key" AS ENUM('age', 'gender', 'region', 'placement', 'device');--> statement-breakpoint
CREATE TABLE "fb_breakdown_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"meta_ad_account_id" text DEFAULT '' NOT NULL,
	"date_start" date NOT NULL,
	"date_end" date NOT NULL,
	"level" "insight_level" DEFAULT 'account' NOT NULL,
	"meta_campaign_id" text DEFAULT '' NOT NULL,
	"breakdown_key" "breakdown_key" NOT NULL,
	"segment_value" text NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks_all" integer DEFAULT 0 NOT NULL,
	"link_clicks" integer DEFAULT 0 NOT NULL,
	"spend" numeric(14, 4) DEFAULT '0' NOT NULL,
	"leads_total" integer DEFAULT 0 NOT NULL,
	"reach" integer DEFAULT 0 NOT NULL,
	"is_provisional" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fb_breakdown_metrics" ADD CONSTRAINT "fb_breakdown_metrics_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fb_breakdown_metrics_key" ON "fb_breakdown_metrics" USING btree ("client_id","meta_ad_account_id","date_start","date_end","level","meta_campaign_id","breakdown_key","segment_value");--> statement-breakpoint
CREATE INDEX "fb_breakdown_metrics_lookup_idx" ON "fb_breakdown_metrics" USING btree ("client_id","breakdown_key","date_start");