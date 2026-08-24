CREATE TABLE "monthly_commentary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"platform" text DEFAULT 'meta' NOT NULL,
	"month" text NOT NULL,
	"did" text DEFAULT '' NOT NULL,
	"commitments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_did" text,
	"published_commitments" jsonb,
	"published_outcomes" jsonb,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "monthly_commentary" ADD CONSTRAINT "monthly_commentary_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_commentary_month_key" ON "monthly_commentary" USING btree ("client_id","platform","month");