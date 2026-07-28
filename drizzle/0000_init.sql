CREATE TYPE "public"."canonical_stage" AS ENUM('new_lead', 'contacted', 'appointment_booked', 'showed', 'no_show', 'closed_won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."insight_level" AS ENUM('account', 'campaign');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('open', 'won', 'lost', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."sync_kind" AS ENUM('meta_daily', 'meta_reach', 'meta_backfill', 'ghl_backfill');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transition_source" AS ENUM('webhook', 'backfill_snapshot', 'manual');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('pending', 'processed', 'failed', 'ignored');--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"ghl_location_id" text,
	"ghl_token_encrypted" text,
	"ghl_location_name" text,
	"meta_ad_account_id" text,
	"meta_token_encrypted" text,
	"meta_account_name" text,
	"meta_currency" text,
	"meta_timezone" text,
	"webhook_token" text NOT NULL,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"first_webhook_at" timestamp with time zone,
	"last_webhook_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"ghl_contact_id" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"source" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"meta_campaign_id" text,
	"meta_adset_id" text,
	"meta_ad_id" text,
	"fbclid" text,
	"facebook_lead_id" text,
	"raw_attribution" jsonb,
	"attribution_fetched_at" timestamp with time zone,
	"ghl_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fb_daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"date" date NOT NULL,
	"level" "insight_level" DEFAULT 'campaign' NOT NULL,
	"meta_campaign_id" text DEFAULT '' NOT NULL,
	"campaign_name" text,
	"reach" integer DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks_all" integer DEFAULT 0 NOT NULL,
	"link_clicks" integer DEFAULT 0 NOT NULL,
	"inline_link_clicks" integer DEFAULT 0 NOT NULL,
	"spend" numeric(14, 4) DEFAULT '0' NOT NULL,
	"leads_total" integer DEFAULT 0 NOT NULL,
	"leads_pixel" integer DEFAULT 0 NOT NULL,
	"leads_onsite" integer DEFAULT 0 NOT NULL,
	"currency" text,
	"is_provisional" boolean DEFAULT true NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fb_period_reach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"meta_campaign_id" text DEFAULT '' NOT NULL,
	"reach" integer DEFAULT 0 NOT NULL,
	"frequency" numeric(10, 4),
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"ghl_opportunity_id" text NOT NULL,
	"contact_id" uuid,
	"ghl_contact_id" text,
	"name" text,
	"ghl_pipeline_id" text,
	"current_stage_id" uuid,
	"current_stage_ghl_id" text,
	"status" "opportunity_status",
	"monetary_value" numeric(14, 2),
	"ghl_created_at" timestamp with time zone,
	"last_stage_change_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"ghl_pipeline_id" text NOT NULL,
	"ghl_stage_id" text NOT NULL,
	"ghl_stage_name" text,
	"ghl_pipeline_name" text,
	"canonical_stage" "canonical_stage",
	"display_order" integer DEFAULT 0 NOT NULL,
	"discovered_from_webhook" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"contact_id" uuid,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"from_stage_ghl_id" text,
	"to_stage_ghl_id" text NOT NULL,
	"from_canonical" "canonical_stage",
	"to_canonical" "canonical_stage",
	"changed_at" timestamp with time zone NOT NULL,
	"source" "transition_source" DEFAULT 'webhook' NOT NULL,
	"dedupe_key" text NOT NULL,
	"webhook_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"kind" "sync_kind" NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"error" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"webhook_token" text,
	"event_type" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"headers" jsonb,
	"payload" jsonb NOT NULL,
	"status" "webhook_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fb_daily_metrics" ADD CONSTRAINT "fb_daily_metrics_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fb_period_reach" ADD CONSTRAINT "fb_period_reach_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_current_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("current_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_slug_key" ON "clients" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_webhook_token_key" ON "clients" USING btree ("webhook_token");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_client_ghl_key" ON "contacts" USING btree ("client_id","ghl_contact_id");--> statement-breakpoint
CREATE INDEX "contacts_client_campaign_idx" ON "contacts" USING btree ("client_id","meta_campaign_id");--> statement-breakpoint
CREATE INDEX "contacts_client_created_idx" ON "contacts" USING btree ("client_id","ghl_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fb_daily_metrics_key" ON "fb_daily_metrics" USING btree ("client_id","date","level","meta_campaign_id");--> statement-breakpoint
CREATE INDEX "fb_daily_metrics_client_date_idx" ON "fb_daily_metrics" USING btree ("client_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "fb_period_reach_key" ON "fb_period_reach" USING btree ("client_id","period_start","period_end","meta_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_client_ghl_key" ON "opportunities" USING btree ("client_id","ghl_opportunity_id");--> statement-breakpoint
CREATE INDEX "opportunities_client_stage_idx" ON "opportunities" USING btree ("client_id","current_stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_client_stage_key" ON "pipeline_stages" USING btree ("client_id","ghl_stage_id");--> statement-breakpoint
CREATE INDEX "pipeline_stages_client_canonical_idx" ON "pipeline_stages" USING btree ("client_id","canonical_stage");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_transitions_dedupe_key" ON "stage_transitions" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "stage_transitions_client_canonical_changed_idx" ON "stage_transitions" USING btree ("client_id","to_canonical","changed_at");--> statement-breakpoint
CREATE INDEX "stage_transitions_opportunity_idx" ON "stage_transitions" USING btree ("opportunity_id","changed_at");--> statement-breakpoint
CREATE INDEX "sync_runs_client_started_idx" ON "sync_runs" USING btree ("client_id","started_at");--> statement-breakpoint
CREATE INDEX "webhook_events_client_received_idx" ON "webhook_events" USING btree ("client_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status");