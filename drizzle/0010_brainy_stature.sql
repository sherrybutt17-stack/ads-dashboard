CREATE TYPE "public"."creative_type" AS ENUM('image', 'video', 'carousel', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."delivery_ranking" AS ENUM('above_average', 'average', 'below_average_35', 'below_average_20', 'below_average_10', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."insight_level" ADD VALUE 'adset';--> statement-breakpoint
ALTER TYPE "public"."insight_level" ADD VALUE 'ad';--> statement-breakpoint
CREATE TABLE "meta_ad_creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"meta_ad_account_id" text DEFAULT '' NOT NULL,
	"meta_ad_id" text NOT NULL,
	"ad_name" text,
	"meta_adset_id" text,
	"meta_campaign_id" text,
	"meta_creative_id" text,
	"creative_key" text DEFAULT '' NOT NULL,
	"creative_type" "creative_type" DEFAULT 'unknown' NOT NULL,
	"image_hash" text,
	"video_id" text,
	"video_length_seconds" numeric(8, 2),
	"title" text,
	"body" text,
	"call_to_action_type" text,
	"link_url" text,
	"thumbnail_url" text,
	"status" text,
	"learning_stage" text,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "fb_daily_metrics_key";--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "meta_adset_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "adset_name" text;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "meta_ad_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "ad_name" text;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "creative_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "creative_type" "creative_type" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "video_3s_views" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "video_plays" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "thru_plays" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "video_p25" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "video_p50" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "video_p75" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "video_p95" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "video_p100" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "landing_page_views" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "outbound_clicks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "quality_ranking" "delivery_ranking";--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "engagement_rate_ranking" "delivery_ranking";--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD COLUMN "conversion_rate_ranking" "delivery_ranking";--> statement-breakpoint
ALTER TABLE "meta_ad_creatives" ADD CONSTRAINT "meta_ad_creatives_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_ad_creatives_key" ON "meta_ad_creatives" USING btree ("client_id","meta_ad_id");--> statement-breakpoint
CREATE INDEX "meta_ad_creatives_creative_idx" ON "meta_ad_creatives" USING btree ("client_id","creative_key");--> statement-breakpoint
CREATE INDEX "fb_daily_metrics_creative_idx" ON "fb_daily_metrics" USING btree ("client_id","level","creative_key","date");--> statement-breakpoint
CREATE UNIQUE INDEX "fb_daily_metrics_key" ON "fb_daily_metrics" USING btree ("client_id","meta_ad_account_id","date","level","meta_campaign_id","meta_adset_id","meta_ad_id");