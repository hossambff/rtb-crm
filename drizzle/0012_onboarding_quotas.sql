CREATE TABLE "rso"."quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	"pipeline_key" text DEFAULT '' NOT NULL,
	"metric" text NOT NULL,
	"target" double precision NOT NULL,
	"status" text DEFAULT 'set' NOT NULL,
	"set_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rso"."user_prefs" ADD COLUMN "onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rso"."user_prefs" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rso"."quotas" ADD CONSTRAINT "quotas_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quotas_uq" ON "rso"."quotas" USING btree ("user_id","period","pipeline_key","metric");--> statement-breakpoint
CREATE INDEX "quotas_period_idx" ON "rso"."quotas" USING btree ("period");