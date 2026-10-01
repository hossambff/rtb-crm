CREATE TABLE "rso"."proposal_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"file_name" text NOT NULL,
	"file_b64" text NOT NULL,
	"sha256" text NOT NULL,
	"field_map" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parsed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "proposal_templates_kind_idx" ON "rso"."proposal_templates" USING btree ("kind","active");