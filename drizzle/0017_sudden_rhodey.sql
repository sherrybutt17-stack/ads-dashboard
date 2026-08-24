CREATE TYPE "public"."summary_framing" AS ENUM('summary', 'wins', 'issues', 'recommendations');--> statement-breakpoint
CREATE TABLE "report_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"platform" text DEFAULT 'meta' NOT NULL,
	"range_start" date NOT NULL,
	"range_end" date NOT NULL,
	"framing" "summary_framing" NOT NULL,
	"headline" text NOT NULL,
	"body" text NOT NULL,
	"verification" jsonb,
	"generated_by" text,
	"model" text,
	"published_headline" text,
	"published_body" text,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "report_summaries" ADD CONSTRAINT "report_summaries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_summaries_period_key" ON "report_summaries" USING btree ("client_id","platform","range_start","range_end","framing");