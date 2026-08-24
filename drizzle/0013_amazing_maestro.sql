CREATE TYPE "public"."agency_mark_mode" AS ENUM('full', 'prepared_by', 'none');--> statement-breakpoint
CREATE TABLE "agency_settings" (
	"id" text PRIMARY KEY DEFAULT 'SINGLETON' NOT NULL,
	"agency_name" text,
	"agency_mark_mode" "agency_mark_mode" DEFAULT 'prepared_by' NOT NULL,
	"support_email" text,
	"logo_wordmark" "bytea",
	"logo_wordmark_type" text,
	"logo_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_branding" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"brand_color" text,
	"report_contact_line" text,
	"logo_wordmark" "bytea",
	"logo_wordmark_type" text,
	"logo_square" "bytea",
	"logo_square_type" text,
	"logo_version" integer DEFAULT 0 NOT NULL,
	"brand_color_applies_to_dashboard" boolean DEFAULT true NOT NULL,
	"client_editable" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "client_branding" ADD CONSTRAINT "client_branding_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;