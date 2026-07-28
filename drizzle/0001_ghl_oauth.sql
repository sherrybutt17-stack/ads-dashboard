CREATE TYPE "public"."ghl_auth_method" AS ENUM('pit', 'oauth');--> statement-breakpoint
CREATE TABLE "ghl_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" text NOT NULL,
	"company_id" text,
	"user_type" text,
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" text,
	"location_name" text,
	"client_id" uuid,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"uninstalled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "ghl_auth_method" "ghl_auth_method" DEFAULT 'pit' NOT NULL;--> statement-breakpoint
ALTER TABLE "ghl_installations" ADD CONSTRAINT "ghl_installations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ghl_installations_location_key" ON "ghl_installations" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "ghl_installations_client_idx" ON "ghl_installations" USING btree ("client_id");