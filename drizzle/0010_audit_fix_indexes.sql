DROP INDEX "rso"."audit_entity_idx";--> statement-breakpoint
ALTER TABLE "rso"."sequence_enrollments" ADD COLUMN "steps_version" integer;--> statement-breakpoint
ALTER TABLE "rso"."sequences" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_one_pending_uq" ON "rso"."handoffs" USING btree ("deal_id") WHERE "rso"."handoffs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "meetings_starts_at_idx" ON "rso"."meetings" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "meetings_attendees_gin" ON "rso"."meetings" USING gin ("attendees");--> statement-breakpoint
CREATE INDEX "tasks_evidence_source_idx" ON "rso"."tasks" USING btree ("evidence_source") WHERE "rso"."tasks"."evidence_source" is not null;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "rso"."audit_log" USING btree ("entity","entity_id","created_at");