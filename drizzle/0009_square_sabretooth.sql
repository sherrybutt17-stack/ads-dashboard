ALTER TYPE "public"."sync_kind" ADD VALUE 'meta_intraday' BEFORE 'meta_reach';--> statement-breakpoint
ALTER TYPE "public"."sync_kind" ADD VALUE 'google_intraday' BEFORE 'google_backfill';