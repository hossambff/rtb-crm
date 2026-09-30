CREATE TABLE "rso"."deal_health_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rso"."commission_accruals" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "rso"."documents" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."email_messages" ADD COLUMN "message_id_header" text;--> statement-breakpoint
ALTER TABLE "rso"."enrichment_runs" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "rso"."enrichment_runs" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."import_records" ADD COLUMN "id" bigint PRIMARY KEY NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "rso"."import_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "rso"."import_records" ADD COLUMN "sheet" text;--> statement-breakpoint
ALTER TABLE "rso"."import_records" ADD COLUMN "row_number" integer;--> statement-breakpoint
ALTER TABLE "rso"."invoices" ADD COLUMN "pik_value_cents" bigint;--> statement-breakpoint
ALTER TABLE "rso"."invoices" ADD COLUMN "pik_approved_by" text;--> statement-breakpoint
ALTER TABLE "rso"."invoices" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "rso"."invoices" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."invoices" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rso"."proposals" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "rso"."proposals" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."proposals" ADD COLUMN "mask" jsonb;--> statement-breakpoint
ALTER TABLE "rso"."proposals" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rso"."scout_candidates" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."scout_candidates" ADD COLUMN "suppressed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rso"."scout_candidates" ADD COLUMN "muu_confidence" "rso"."metric_confidence";--> statement-breakpoint
ALTER TABLE "rso"."scout_searches" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "rso"."tasks" ADD COLUMN "snooze_reason" text;--> statement-breakpoint
ALTER TABLE "rso"."deal_health_history" ADD CONSTRAINT "deal_health_history_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_health_history_deal_idx" ON "rso"."deal_health_history" USING btree ("deal_id","taken_at");--> statement-breakpoint
CREATE INDEX "accounts_name_trgm" ON "rso"."accounts" USING gin (lower("name") extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "accounts_domain_trgm" ON "rso"."accounts" USING gin ("domain" extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "activities_contact_idx" ON "rso"."activities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "alerts_rule_state_idx" ON "rso"."alerts" USING btree ("rule_code","state");--> statement-breakpoint
CREATE INDEX "alerts_entity_idx" ON "rso"."alerts" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "approvals_entity_idx" ON "rso"."approvals" USING btree ("entity","entity_id","status");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "rso"."approvals" USING btree ("status","approver_role");--> statement-breakpoint
CREATE INDEX "comments_entity_idx" ON "rso"."comments" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_accruals_source_uq" ON "rso"."commission_accruals" USING btree ("user_id","plan_id","source_key") WHERE "rso"."commission_accruals"."source_key" is not null;--> statement-breakpoint
CREATE INDEX "commission_accruals_deal_idx" ON "rso"."commission_accruals" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "commission_assignments_plan_idx" ON "rso"."commission_assignments" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "contacts_owner_idx" ON "rso"."contacts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "contacts_rel_owner_idx" ON "rso"."contacts" USING btree ("relationship_owner_id");--> statement-breakpoint
CREATE INDEX "contacts_name_trgm" ON "rso"."contacts" USING gin (lower("full_name") extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "deal_contacts_contact_idx" ON "rso"."deal_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "deal_splits_user_idx" ON "rso"."deal_splits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "deals_stage_idx" ON "rso"."deals" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "deals_primary_contact_idx" ON "rso"."deals" USING btree ("primary_contact_id");--> statement-breakpoint
CREATE INDEX "deals_name_trgm" ON "rso"."deals" USING gin (lower("name") extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "documents_deal_idx" ON "rso"."documents" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "documents_account_idx" ON "rso"."documents" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "email_threads_deal_idx" ON "rso"."email_threads" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "email_threads_account_idx" ON "rso"."email_threads" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_org_provider" ON "rso"."integration_connections" USING btree ("provider") WHERE "rso"."integration_connections"."user_id" is null;--> statement-breakpoint
CREATE INDEX "invoices_deal_idx" ON "rso"."invoices" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_source_key_uq" ON "rso"."invoices" USING btree ("source_key") WHERE "rso"."invoices"."source_key" is not null;--> statement-breakpoint
CREATE INDEX "lead_registrations_account_idx" ON "rso"."lead_registrations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "lead_registrations_user_idx" ON "rso"."lead_registrations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "meetings_deal_idx" ON "rso"."meetings" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "meetings_account_idx" ON "rso"."meetings" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_projects_deal_uq" ON "rso"."migration_projects" USING btree ("deal_id") WHERE "rso"."migration_projects"."deal_id" is not null;--> statement-breakpoint
CREATE INDEX "migration_projects_account_idx" ON "rso"."migration_projects" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "migration_projects_owner_idx" ON "rso"."migration_projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "proposals_deal_idx" ON "rso"."proposals" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "restricted_access_user_idx" ON "rso"."restricted_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scout_candidates_domain_state" ON "rso"."scout_candidates" USING btree ("domain","state");--> statement-breakpoint
CREATE INDEX "tasks_account_idx" ON "rso"."tasks" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "tasks_contact_idx" ON "rso"."tasks" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "transcripts_deal_idx" ON "rso"."transcripts" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "transcripts_account_idx" ON "rso"."transcripts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "transcripts_uploaded_by_idx" ON "rso"."transcripts" USING btree ("uploaded_by");