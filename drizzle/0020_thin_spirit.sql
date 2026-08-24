CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"platform" text DEFAULT 'meta' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cadence" text DEFAULT 'monthly' NOT NULL,
	"send_hour" integer DEFAULT 8 NOT NULL,
	"recipients" text[] DEFAULT '{}' NOT NULL,
	"last_sent_period" text,
	"last_sent_at" timestamp with time zone,
	"last_error" text,
	"link_ttl_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "report_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"platform" text DEFAULT 'meta' NOT NULL,
	"period_key" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"recipients" text[] DEFAULT '{}' NOT NULL,
	"share_link_id" uuid,
	"status" text DEFAULT 'sending' NOT NULL,
	"provider_id" text,
	"error" text,
	"skipped_periods" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sends" ADD CONSTRAINT "report_sends_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedules_client_platform_key" ON "report_schedules" USING btree ("client_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "report_sends_period_key" ON "report_sends" USING btree ("client_id","platform","period_key");