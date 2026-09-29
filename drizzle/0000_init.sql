-- schema "rso" is pre-created (owned by rso_app) in Supabase; see docs/SETUP.md
CREATE TYPE "rso"."account_type" AS ENUM('publisher', 'media_group', 'public_company', 'token_project', 'advertiser', 'agency', 'partner', 'other');--> statement-breakpoint
CREATE TYPE "rso"."activity_source" AS ENUM('manual', 'gmail', 'calendar', 'zoom', 'granola', 'meet', 'upload', 'import', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "rso"."activity_type" AS ENUM('email', 'call', 'meeting', 'note', 'linkedin', 'stage_change', 'field_change', 'system', 'agent');--> statement-breakpoint
CREATE TYPE "rso"."alert_severity" AS ENUM('info', 'warning', 'serious', 'critical');--> statement-breakpoint
CREATE TYPE "rso"."alert_state" AS ENUM('open', 'acknowledged', 'snoozed', 'resolved', 'dismissed', 'escalated');--> statement-breakpoint
CREATE TYPE "rso"."candidate_state" AS ENUM('new', 'accepted', 'rejected', 'snoozed', 'duplicate');--> statement-breakpoint
CREATE TYPE "rso"."deal_status" AS ENUM('open', 'won', 'lost', 'hold');--> statement-breakpoint
CREATE TYPE "rso"."doc_status" AS ENUM('draft', 'sent', 'signed', 'expired');--> statement-breakpoint
CREATE TYPE "rso"."doc_type" AS ENUM('nda', 'contract', 'proposal', 'pro_forma', 'deck', 'io', 'invoice', 'other');--> statement-breakpoint
CREATE TYPE "rso"."email_verification" AS ENUM('valid', 'risky', 'invalid', 'unknown');--> statement-breakpoint
CREATE TYPE "rso"."employment_type" AS ENUM('staff', 'retainer', 'hourly', 'commission', 'contractor');--> statement-breakpoint
CREATE TYPE "rso"."invoice_status" AS ENUM('scheduled', 'sent', 'paid', 'overdue', 'written_off');--> statement-breakpoint
CREATE TYPE "rso"."lifecycle" AS ENUM('target', 'prospect', 'customer', 'churned', 'disqualified');--> statement-breakpoint
CREATE TYPE "rso"."metric_confidence" AS ENUM('verified', 'reported', 'estimate');--> statement-breakpoint
CREATE TYPE "rso"."metric_type" AS ENUM('muu', 'visits', 'pageviews');--> statement-breakpoint
CREATE TYPE "rso"."migration_stage" AS ENUM('discovery', 'scoping', 'clone_built', 'content_migrated', 'qa', 'launched', 'live', 'paused');--> statement-breakpoint
CREATE TYPE "rso"."pipeline_type" AS ENUM('NET', 'ENT', 'SPT', 'R100', 'ADS', 'PAY', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "rso"."priority" AS ENUM('top10', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "rso"."processing_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "rso"."role_key" AS ENUM('super_admin', 'admin', 'executive', 'sales_leader', 'ae', 'sdr', 'intern', 'commission_rep', 'onboarding', 'finance', 'editorial', 'viewer', 'pending');--> statement-breakpoint
CREATE TYPE "rso"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "rso"."stage_category" AS ENUM('open', 'won', 'lost', 'hold');--> statement-breakpoint
CREATE TYPE "rso"."task_origin" AS ENUM('manual', 'email_ai', 'call_ai', 'rule', 'sequence', 'agent', 'import');--> statement-breakpoint
CREATE TYPE "rso"."task_status" AS ENUM('open', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "rso"."transcript_source" AS ENUM('granola', 'zoom', 'meet', 'upload', 'paste');--> statement-breakpoint
CREATE TYPE "rso"."value_unit" AS ENUM('muu', 'usd', 'activation');--> statement-breakpoint
CREATE TABLE "rso"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"alt_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"parent_id" uuid,
	"type" "rso"."account_type" DEFAULT 'publisher' NOT NULL,
	"category" text,
	"subcategory" text,
	"league" text,
	"team" text,
	"country" text,
	"region" text,
	"language" text,
	"ownership" text,
	"ticker" text,
	"token_name" text,
	"is_b2c" boolean,
	"market_cap_usd" bigint,
	"website" text,
	"press_page" text,
	"pr_email" text,
	"linkedin_url" text,
	"lifecycle" "rso"."lifecycle" DEFAULT 'target' NOT NULL,
	"priority" "rso"."priority",
	"owner_id" text,
	"team_id" uuid,
	"muu" bigint,
	"muu_source" text,
	"muu_confidence" "rso"."metric_confidence",
	"monthly_visits" bigint,
	"tech_stack" text[] DEFAULT '{}'::text[] NOT NULL,
	"fit_score" integer,
	"fit_explanation" text,
	"restricted" boolean DEFAULT false NOT NULL,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"notes" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rso"."activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "rso"."activity_type" NOT NULL,
	"source" "rso"."activity_source" DEFAULT 'manual' NOT NULL,
	"subject" text,
	"body" text,
	"direction" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_min" integer,
	"actor_id" text,
	"deal_id" uuid,
	"account_id" uuid,
	"contact_id" uuid,
	"email_message_id" uuid,
	"transcript_id" uuid,
	"meeting_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."actor_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"actor_id" text NOT NULL,
	"fallback_order" integer DEFAULT 0 NOT NULL,
	"input_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_per_result_usd" double precision DEFAULT 0.01 NOT NULL,
	"timeout_secs" integer DEFAULT 120 NOT NULL,
	"max_items" integer DEFAULT 25 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"compliant" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"model" text,
	"input" jsonb,
	"tool_calls" jsonb,
	"output" jsonb,
	"cost_usd" double precision,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."alert_rules" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity" "rso"."alert_severity" DEFAULT 'warning' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"escalate_after_hours" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_code" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"recipient_id" text,
	"severity" "rso"."alert_severity" NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"suggested_action" text,
	"state" "rso"."alert_state" DEFAULT 'open' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."allowed_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"approver_role" text DEFAULT 'executive' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."audience_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"metric" "rso"."metric_type" NOT NULL,
	"value" bigint NOT NULL,
	"raw_value" text,
	"derived_muu" bigint,
	"factor_used" double precision,
	"period" text,
	"source" text NOT NULL,
	"confidence" "rso"."metric_confidence" DEFAULT 'estimate' NOT NULL,
	"entered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rso"."audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" text,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"pattern" text,
	"status" text NOT NULL,
	"product_id" uuid,
	"evidence" text,
	"approved_alternative" text,
	"approver_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"mentions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."commission_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" uuid,
	"deal_id" uuid,
	"invoice_id" uuid,
	"trigger" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" text DEFAULT 'accrued' NOT NULL,
	"period" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."commission_assignments" (
	"user_id" text NOT NULL,
	"plan_id" uuid NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_assignments_user_id_plan_id_pk" PRIMARY KEY("user_id","plan_id")
);
--> statement-breakpoint
CREATE TABLE "rso"."commission_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"first_name" text,
	"last_name" text,
	"full_name" text NOT NULL,
	"title" text,
	"seniority" text,
	"email" text,
	"alt_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"email_status" "rso"."email_verification" DEFAULT 'unknown',
	"phone" text,
	"linkedin_url" text,
	"relationship_owner_id" text,
	"owner_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"last_contacted_at" timestamp with time zone,
	"origin" text,
	"notes" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rso"."custom_field_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" text NOT NULL,
	"pipeline_key" text,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"required_at_stages" text[] DEFAULT '{}'::text[] NOT NULL,
	"help_text" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."deal_contacts" (
	"deal_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" text,
	CONSTRAINT "deal_contacts_deal_id_contact_id_pk" PRIMARY KEY("deal_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "rso"."deal_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" double precision DEFAULT 1,
	"price_cents" bigint,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "rso"."deal_splits" (
	"deal_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"pct" double precision NOT NULL,
	"role" text DEFAULT 'owner',
	CONSTRAINT "deal_splits_deal_id_user_id_pk" PRIMARY KEY("deal_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rso"."deal_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid NOT NULL,
	"changed_by" text,
	"reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"status" "rso"."deal_status" DEFAULT 'open' NOT NULL,
	"account_id" uuid,
	"primary_contact_id" uuid,
	"owner_id" text,
	"team_id" uuid,
	"source" text,
	"priority" "rso"."priority",
	"expected_close_date" timestamp with time zone,
	"next_step" text,
	"next_step_due_at" timestamp with time zone,
	"next_step_waiting_reason" text,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone,
	"probability_override" double precision,
	"override_reason" text,
	"override_approved_by" text,
	"override_status" text,
	"muu" bigint,
	"usd_per_muu" double precision,
	"rev_share_pct" double precision,
	"guarantee_type" text,
	"guarantee_monthly_cents" bigint,
	"ramp_months" integer,
	"term_years" double precision,
	"contract_value_cents" bigint,
	"annualized_value_cents" bigint,
	"next_payment_cents" bigint,
	"next_payment_at" timestamp with time zone,
	"renewal_at" timestamp with time zone,
	"r100" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_score" integer,
	"health_explanation" text,
	"ai_summary" text,
	"ai_summary_at" timestamp with time zone,
	"won_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"lost_reason" text,
	"hold_reason" text,
	"restricted" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rso"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid,
	"account_id" uuid,
	"type" "rso"."doc_type" NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"status" "rso"."doc_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"signed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"from_addr" text,
	"to_addrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"cc_addrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"sent_at" timestamp with time zone,
	"direction" text,
	"body_text" text,
	"analysis" jsonb,
	"analyzed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."email_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_user_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"subject" text,
	"snippet" text,
	"participants" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_message_at" timestamp with time zone,
	"awaiting_reply_from" text,
	"deal_id" uuid,
	"account_id" uuid,
	"private" boolean DEFAULT false NOT NULL,
	"ai_intent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."enriched_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"account_id" uuid,
	"full_name" text NOT NULL,
	"title" text,
	"seniority" text,
	"linkedin_url" text,
	"email" text,
	"email_source" text,
	"verification" "rso"."email_verification" DEFAULT 'unknown' NOT NULL,
	"confidence" double precision,
	"source_actor" text,
	"promoted_contact_id" uuid,
	"state" text DEFAULT 'staged' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."enrichment_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"account_id" uuid,
	"search_id" uuid,
	"requested_by" text,
	"target_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"actors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "rso"."run_status" DEFAULT 'queued' NOT NULL,
	"estimated_cost_cents" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"results_count" integer DEFAULT 0 NOT NULL,
	"verified_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."field_permissions" (
	"role" text NOT NULL,
	"entity" text NOT NULL,
	"field" text NOT NULL,
	"access" text NOT NULL,
	CONSTRAINT "field_permissions_role_entity_field_pk" PRIMARY KEY("role","entity","field")
);
--> statement-breakpoint
CREATE TABLE "rso"."import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"sheet_name" text,
	"target" text NOT NULL,
	"pipeline_key" text,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rolled_back_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rso"."import_records" (
	"batch_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before" jsonb
);
--> statement-breakpoint
CREATE TABLE "rso"."integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"provider" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"secret_encrypted" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cursor" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "rso"."invoice_status" DEFAULT 'scheduled' NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_in_kind" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."lead_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"protected_until" timestamp with time zone,
	"decided_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text,
	"calendar_event_id" text,
	"title" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"attendees" text[] DEFAULT '{}'::text[] NOT NULL,
	"deal_id" uuid,
	"account_id" uuid,
	"transcript_id" uuid,
	"prep_brief" text,
	"consent_confirmed" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."migration_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid,
	"account_id" uuid,
	"name" text NOT NULL,
	"stage" "rso"."migration_stage" DEFAULT 'discovery' NOT NULL,
	"launched" boolean DEFAULT false NOT NULL,
	"owner_id" text,
	"target_go_live" timestamp with time zone,
	"actual_go_live" timestamp with time zone,
	"clone_url" text,
	"live_url" text,
	"blockers" text,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."picklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list" text NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."pipeline_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"taken_on" text NOT NULL,
	"pipeline_key" text NOT NULL,
	"stage_key" text NOT NULL,
	"deal_count" integer NOT NULL,
	"muu" bigint DEFAULT 0 NOT NULL,
	"gross_cents" bigint DEFAULT 0 NOT NULL,
	"weighted_cents" bigint DEFAULT 0 NOT NULL,
	"override_weighted_cents" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"type" "rso"."pipeline_type" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit" "rso"."value_unit" NOT NULL,
	"color" text NOT NULL,
	"usd_per_muu" double precision DEFAULT 1 NOT NULL,
	"default_rev_share_pct" double precision,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipelines_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "rso"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family" text NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"description" text,
	"pipeline_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"pricing_model" text,
	"default_terms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"inputs" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_reason" text,
	"approved_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."role_permissions" (
	"role" text NOT NULL,
	"module" text NOT NULL,
	"action" text NOT NULL,
	"scope" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_module_action_pk" PRIMARY KEY("role","module","action")
);
--> statement-breakpoint
CREATE TABLE "rso"."scout_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_id" uuid,
	"domain" text NOT NULL,
	"name" text,
	"category" text,
	"country" text,
	"language" text,
	"monthly_visits" bigint,
	"est_muu" bigint,
	"muu_source" text,
	"trend_pct" double precision,
	"tech_stack" text[] DEFAULT '{}'::text[] NOT NULL,
	"ownership" text,
	"fit_score" integer,
	"fit_factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fit_explanation" text,
	"est_value_cents" bigint,
	"crm_match" jsonb,
	"state" "rso"."candidate_state" DEFAULT 'new' NOT NULL,
	"reject_reason" text,
	"reviewer_id" text,
	"reviewed_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."scout_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" text,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" text DEFAULT 'once' NOT NULL,
	"budget_cap_cents" integer,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "rso"."stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"probability" double precision NOT NULL,
	"category" "rso"."stage_category" DEFAULT 'open' NOT NULL,
	"sla_days" integer,
	"required_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"import_aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."suppression_list" (
	"value" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "rso"."task_status" DEFAULT 'open' NOT NULL,
	"priority" "rso"."priority" DEFAULT 'medium',
	"due_at" timestamp with time zone,
	"assignee_id" text,
	"created_by" text,
	"deal_id" uuid,
	"account_id" uuid,
	"contact_id" uuid,
	"origin" "rso"."task_origin" DEFAULT 'manual' NOT NULL,
	"owed_by" text,
	"evidence" text,
	"evidence_source" text,
	"snooze_count" integer DEFAULT 0 NOT NULL,
	"snoozed_until" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"lead_id" text,
	"pipeline_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"territory" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "rso"."transcript_source" NOT NULL,
	"external_id" text,
	"title" text,
	"raw_text" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"duration_min" integer,
	"participants" text[] DEFAULT '{}'::text[] NOT NULL,
	"uploaded_by" text,
	"deal_id" uuid,
	"account_id" uuid,
	"meeting_id" uuid,
	"status" "rso"."processing_status" DEFAULT 'pending' NOT NULL,
	"analysis" jsonb,
	"analysis_engine" text,
	"applied_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rso"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text DEFAULT 'pending' NOT NULL,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"title" text,
	"employment_type" "rso"."employment_type" DEFAULT 'staff',
	"team_id" uuid,
	"manager_id" text,
	"timezone" text DEFAULT 'America/New_York',
	"work_start_hour" integer DEFAULT 9,
	"work_end_hour" integer DEFAULT 18,
	"access_expires_at" timestamp with time zone,
	"monthly_scout_budget_cents" integer,
	"last_active_at" timestamp with time zone,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "rso"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rso"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."accounts" ADD CONSTRAINT "accounts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."activities" ADD CONSTRAINT "activities_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."activities" ADD CONSTRAINT "activities_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."activities" ADD CONSTRAINT "activities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."activities" ADD CONSTRAINT "activities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "rso"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."agent_runs" ADD CONSTRAINT "agent_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."alerts" ADD CONSTRAINT "alerts_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."audience_metrics" ADD CONSTRAINT "audience_metrics_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."comments" ADD CONSTRAINT "comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."commission_accruals" ADD CONSTRAINT "commission_accruals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."commission_accruals" ADD CONSTRAINT "commission_accruals_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."commission_assignments" ADD CONSTRAINT "commission_assignments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."commission_assignments" ADD CONSTRAINT "commission_assignments_plan_id_commission_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "rso"."commission_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."contacts" ADD CONSTRAINT "contacts_relationship_owner_id_user_id_fk" FOREIGN KEY ("relationship_owner_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."contacts" ADD CONSTRAINT "contacts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deal_contacts" ADD CONSTRAINT "deal_contacts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deal_contacts" ADD CONSTRAINT "deal_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "rso"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deal_line_items" ADD CONSTRAINT "deal_line_items_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deal_splits" ADD CONSTRAINT "deal_splits_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deal_splits" ADD CONSTRAINT "deal_splits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deal_stage_history" ADD CONSTRAINT "deal_stage_history_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deals" ADD CONSTRAINT "deals_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "rso"."pipelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deals" ADD CONSTRAINT "deals_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "rso"."stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deals" ADD CONSTRAINT "deals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deals" ADD CONSTRAINT "deals_primary_contact_id_contacts_id_fk" FOREIGN KEY ("primary_contact_id") REFERENCES "rso"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."deals" ADD CONSTRAINT "deals_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."documents" ADD CONSTRAINT "documents_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."documents" ADD CONSTRAINT "documents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."email_messages" ADD CONSTRAINT "email_messages_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "rso"."email_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."email_threads" ADD CONSTRAINT "email_threads_mailbox_user_id_user_id_fk" FOREIGN KEY ("mailbox_user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."email_threads" ADD CONSTRAINT "email_threads_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."email_threads" ADD CONSTRAINT "email_threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."enriched_contacts" ADD CONSTRAINT "enriched_contacts_run_id_enrichment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "rso"."enrichment_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."enriched_contacts" ADD CONSTRAINT "enriched_contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."enrichment_runs" ADD CONSTRAINT "enrichment_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."enrichment_runs" ADD CONSTRAINT "enrichment_runs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."import_records" ADD CONSTRAINT "import_records_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "rso"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."integration_connections" ADD CONSTRAINT "integration_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."invoices" ADD CONSTRAINT "invoices_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."lead_registrations" ADD CONSTRAINT "lead_registrations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."lead_registrations" ADD CONSTRAINT "lead_registrations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."meetings" ADD CONSTRAINT "meetings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."meetings" ADD CONSTRAINT "meetings_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."meetings" ADD CONSTRAINT "meetings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."migration_projects" ADD CONSTRAINT "migration_projects_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."migration_projects" ADD CONSTRAINT "migration_projects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."migration_projects" ADD CONSTRAINT "migration_projects_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."proposals" ADD CONSTRAINT "proposals_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."scout_candidates" ADD CONSTRAINT "scout_candidates_search_id_scout_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "rso"."scout_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."scout_searches" ADD CONSTRAINT "scout_searches_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."stages" ADD CONSTRAINT "stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "rso"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."tasks" ADD CONSTRAINT "tasks_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."tasks" ADD CONSTRAINT "tasks_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."tasks" ADD CONSTRAINT "tasks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."tasks" ADD CONSTRAINT "tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "rso"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."teams" ADD CONSTRAINT "teams_lead_id_user_id_fk" FOREIGN KEY ("lead_id") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."transcripts" ADD CONSTRAINT "transcripts_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "rso"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."transcripts" ADD CONSTRAINT "transcripts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "rso"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rso"."transcripts" ADD CONSTRAINT "transcripts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "rso"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "rso"."account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_domain_uq" ON "rso"."accounts" USING btree ("domain") WHERE "rso"."accounts"."domain" is not null and "rso"."accounts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "accounts_owner_idx" ON "rso"."accounts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "accounts_name_idx" ON "rso"."accounts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "activities_deal_idx" ON "rso"."activities" USING btree ("deal_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_account_idx" ON "rso"."activities" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_actor_idx" ON "rso"."activities" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_runs_user_idx" ON "rso"."agent_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_uq" ON "rso"."alerts" USING btree ("rule_code","entity","entity_id","recipient_id") WHERE "rso"."alerts"."state" in ('open','acknowledged','snoozed','escalated');--> statement-breakpoint
CREATE INDEX "alerts_recipient_idx" ON "rso"."alerts" USING btree ("recipient_id","state");--> statement-breakpoint
CREATE INDEX "audience_account_idx" ON "rso"."audience_metrics" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "rso"."audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "rso"."audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "contacts_account_idx" ON "rso"."contacts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "rso"."contacts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_entity_key" ON "rso"."custom_field_defs" USING btree ("entity","key");--> statement-breakpoint
CREATE INDEX "stage_hist_deal_idx" ON "rso"."deal_stage_history" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "deals_pipeline_stage_idx" ON "rso"."deals" USING btree ("pipeline_id","stage_id");--> statement-breakpoint
CREATE INDEX "deals_owner_idx" ON "rso"."deals" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "deals_account_idx" ON "rso"."deals" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "deals_next_step_idx" ON "rso"."deals" USING btree ("next_step_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_uq" ON "rso"."email_messages" USING btree ("thread_id","gmail_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_threads_uq" ON "rso"."email_threads" USING btree ("mailbox_user_id","gmail_thread_id");--> statement-breakpoint
CREATE INDEX "import_records_batch_idx" ON "rso"."import_records" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_user_provider" ON "rso"."integration_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_owner_event" ON "rso"."meetings" USING btree ("owner_id","calendar_event_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "rso"."notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "picklists_list_value" ON "rso"."picklists" USING btree ("list","value");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_uq" ON "rso"."pipeline_snapshots" USING btree ("taken_on","pipeline_key","stage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scout_candidates_search_domain" ON "rso"."scout_candidates" USING btree ("search_id","domain");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "rso"."session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stages_pipeline_key" ON "rso"."stages" USING btree ("pipeline_id","key");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "rso"."tasks" USING btree ("assignee_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_deal_idx" ON "rso"."tasks" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_source_ext" ON "rso"."transcripts" USING btree ("source","external_id");