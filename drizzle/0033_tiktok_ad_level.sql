-- TikTok ad-level reporting: one row per ad per day, what each ad shows, and
-- each asset's picture.
--
--   tiktok_ad_daily_metrics  one row per client, advertiser, day and ad
--   tiktok_ad_creatives      one row per client and ad: what the ad shows
--   tiktok_creative_assets   one row per client and asset: duration, size and a
--                            small cached JPEG of its cover
--
-- "tiktok_daily_metrics" is NOT altered. Its readers sum it with no level
-- filter, and the TikTok sync upserts on exactly (client_id, advertiser_id,
-- date, tiktok_campaign_id): ad rows in it, or a changed key, would double
-- TikTok spend or break the spend sync between this migration and the deploy.
--
-- The cover is stored because TikTok signs its picture URLs for about six
-- hours. A share link or PDF opened next week has no other way to show it.
--
-- 🔴 Apply BEFORE deploying the code that reads it. Without it the TikTok
-- creative panel says its data could not be read, and the nightly ad-level
-- pass fails on its own run kind; TikTok spend is unaffected either way.
--
-- Safe to re-run (IF NOT EXISTS throughout). Touches no existing row.
-- To undo:
--   DROP TABLE IF EXISTS "tiktok_ad_daily_metrics", "tiktok_ad_creatives", "tiktok_creative_assets";
--   (an enum value cannot be dropped; an unused 'tiktok_adlevel' is harmless)

CREATE TABLE IF NOT EXISTS "tiktok_ad_daily_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "advertiser_id" text NOT NULL,
  "date" date NOT NULL,
  "tiktok_campaign_id" text NOT NULL DEFAULT '',
  "campaign_name" text,
  "tiktok_adgroup_id" text NOT NULL DEFAULT '',
  "adgroup_name" text,
  "tiktok_ad_id" text NOT NULL,
  "ad_name" text,
  "creative_key" text NOT NULL DEFAULT '',
  "creative_type" "creative_type" NOT NULL DEFAULT 'unknown',
  "impressions" bigint NOT NULL DEFAULT 0,
  "clicks" integer NOT NULL DEFAULT 0,
  "spend" numeric(14, 4) NOT NULL DEFAULT '0',
  "conversions" numeric(14, 2) NOT NULL DEFAULT '0',
  "currency" text,
  "raw" jsonb,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tiktok_ad_daily_metrics_key"
  ON "tiktok_ad_daily_metrics" ("client_id", "advertiser_id", "date", "tiktok_ad_id");
CREATE INDEX IF NOT EXISTS "tiktok_ad_daily_metrics_client_date_idx"
  ON "tiktok_ad_daily_metrics" ("client_id", "date");
CREATE INDEX IF NOT EXISTS "tiktok_ad_daily_metrics_creative_idx"
  ON "tiktok_ad_daily_metrics" ("client_id", "creative_key", "date");

CREATE TABLE IF NOT EXISTS "tiktok_ad_creatives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "advertiser_id" text NOT NULL,
  "tiktok_ad_id" text NOT NULL,
  "ad_name" text,
  "tiktok_adgroup_id" text,
  "tiktok_campaign_id" text,
  "creative_key" text NOT NULL DEFAULT '',
  "creative_type" "creative_type" NOT NULL DEFAULT 'unknown',
  "thumb_key" text NOT NULL DEFAULT '',
  "video_id" text,
  "image_ids" jsonb,
  "tiktok_item_id" text,
  "ad_format" text,
  "ad_text" text,
  "call_to_action" text,
  "display_name" text,
  "landing_page_url" text,
  "operation_status" text,
  "secondary_status" text,
  "raw" jsonb,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tiktok_ad_creatives_key"
  ON "tiktok_ad_creatives" ("client_id", "tiktok_ad_id");
CREATE INDEX IF NOT EXISTS "tiktok_ad_creatives_creative_idx"
  ON "tiktok_ad_creatives" ("client_id", "creative_key");

CREATE TABLE IF NOT EXISTS "tiktok_creative_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "advertiser_id" text NOT NULL,
  "asset_key" text NOT NULL,
  "kind" text NOT NULL,
  "video_id" text,
  "image_id" text,
  "duration_seconds" numeric(8, 2),
  "width" integer,
  "height" integer,
  "thumb" bytea,
  "thumb_content_type" text,
  "thumb_fetched_at" timestamp with time zone,
  "raw" jsonb,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tiktok_creative_assets_key"
  ON "tiktok_creative_assets" ("client_id", "asset_key");

-- The ad-level pass records its own run kind. Health and pipe status read only
-- tiktok_daily and tiktok_backfill, so this kind can never turn the TikTok
-- spend pipe red or green.
ALTER TYPE "sync_kind" ADD VALUE IF NOT EXISTS 'tiktok_adlevel';
