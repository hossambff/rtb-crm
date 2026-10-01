CREATE TABLE "rso"."briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"period_key" text DEFAULT '' NOT NULL,
	"content" jsonb NOT NULL,
	"engine" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."deal_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"suggested_stage_id" uuid,
	"suggested_close_date" timestamp with time zone,
	"quote" text,
	"rationale" text,
	"confidence" double precision,
	"engine" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."forecast_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"week_of" text NOT NULL,
	"period" text NOT NULL,
	"owner_id" text,
	"suggested_category" text NOT NULL,
	"suggested_reason" text,
	"category" text,
	"weighted_cents" bigint DEFAULT 0 NOT NULL,
	"gross_cents" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_user_id" text,
	"to_user_id" text NOT NULL,
	"brief" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_note" text,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."help_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid,
	"meeting_id" uuid,
	"requester_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"ask" text NOT NULL,
	"context" text,
	"needed_by" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"response" text,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."queue_snoozes" (
	"user_id" text NOT NULL,
	"item_key" text NOT NULL,
	"until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_snoozes_user_id_item_key_pk" PRIMARY KEY("user_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "rso"."review_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"facilitator_id" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deal_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rso"."saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"page" text NOT NULL,
	"name" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_last" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."sequence_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"deal_id" uuid,
	"account_id" uuid,
	"sender_id" text NOT NULL,
	"enrolled_by" text,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone,
	"gmail_thread_id" text,
	"last_message_id_header" text,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"exit_reason" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"pipeline_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"owner_id" text,
	"shared" boolean DEFAULT true NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exit_on" jsonb DEFAULT '{"reply":true,"meetingBooked":true,"stageChange":true,"unsubscribe":true}'::jsonb NOT NULL,
	"daily_cap" integer DEFAULT 40 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rso"."share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"partner_name" text,
	"deal_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "rso"."stage_playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage_id" uuid NOT NULL,
	"name" text NOT NULL,
	"guidance" text,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"email_templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."team_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"deal_id" uuid,
	"author_id" text,
	"title" text NOT NULL,
	"body" text,
	"clip" jsonb,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"in_playbook" boolean DEFAULT false NOT NULL,
	"reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rso"."user_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"nav_hidden" text[] DEFAULT '{}'::text[] NOT NULL,
	"pipeline_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"alert_budget_per_day" integer DEFAULT 3 NOT NULL,
	"autopilot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"slack_user_id" text,
	"slack_dm" boolean DEFAULT false NOT NULL,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rso"."approvals" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."approvals" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."comments" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "rso"."comments" ADD COLUMN "slack_ts" text;--> statement-breakpoint
ALTER TABLE "rso"."comments" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."comments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."notifications" ADD COLUMN "severity" text;--> statement-breakpoint
ALTER TABLE "rso"."notifications" ADD COLUMN "digest_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rso"."notifications" ADD COLUMN "delivered_via" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "rso"."proposals" ADD COLUMN "kind" text DEFAULT 'pro_forma' NOT NULL;--> statement-breakpoint
ALTER TABLE "rso"."deal_signals" ADD CONSTRAINT "deal_signals_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."forecast_entries" ADD CONSTRAINT "forecast_entries_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."handoffs" ADD CONSTRAINT "handoffs_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."handoffs" ADD CONSTRAINT "handoffs_to_user_id_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."help_requests" ADD CONSTRAINT "help_requests_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."help_requests" ADD CONSTRAINT "help_requests_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."queue_snoozes" ADD CONSTRAINT "queue_snoozes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."saved_views" ADD CONSTRAINT "saved_views_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "rso"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "rso"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sender_id_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."sequences" ADD CONSTRAINT "sequences_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."stage_playbooks" ADD CONSTRAINT "stage_playbooks_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "rso"."stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."team_posts" ADD CONSTRAINT "team_posts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."team_posts" ADD CONSTRAINT "team_posts_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."user_prefs" ADD CONSTRAINT "user_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "briefs_uq" ON "rso"."briefs" USING btree ("kind","subject_id","user_id","period_key");--> statement-breakpoint
CREATE INDEX "briefs_user_idx" ON "rso"."briefs" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "deal_signals_deal_idx" ON "rso"."deal_signals" USING btree ("deal_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_signals_source_uq" ON "rso"."deal_signals" USING btree ("source","source_id","deal_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_deal_week_uq" ON "rso"."forecast_entries" USING btree ("deal_id","week_of");--> statement-breakpoint
CREATE INDEX "forecast_week_owner_idx" ON "rso"."forecast_entries" USING btree ("week_of","owner_id");--> statement-breakpoint
CREATE INDEX "handoffs_to_idx" ON "rso"."handoffs" USING btree ("to_user_id","status");--> statement-breakpoint
CREATE INDEX "handoffs_deal_idx" ON "rso"."handoffs" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "help_requests_target_idx" ON "rso"."help_requests" USING btree ("target_user_id","status");--> statement-breakpoint
CREATE INDEX "help_requests_deal_idx" ON "rso"."help_requests" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "saved_views_user_page_idx" ON "rso"."saved_views" USING btree ("user_id","page");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_last_uq" ON "rso"."saved_views" USING btree ("user_id","page") WHERE "rso"."saved_views"."is_last";--> statement-breakpoint
CREATE INDEX "seq_enroll_due_idx" ON "rso"."sequence_enrollments" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "seq_enroll_contact_idx" ON "rso"."sequence_enrollments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "seq_enroll_sender_idx" ON "rso"."sequence_enrollments" USING btree ("sender_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seq_enroll_active_uq" ON "rso"."sequence_enrollments" USING btree ("sequence_id","contact_id") WHERE "rso"."sequence_enrollments"."status" in ('active','paused');--> statement-breakpoint
CREATE INDEX "share_links_created_by_idx" ON "rso"."share_links" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_playbooks_stage_uq" ON "rso"."stage_playbooks" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "team_posts_created_idx" ON "rso"."team_posts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "team_posts_playbook_idx" ON "rso"."team_posts" USING btree ("in_playbook");