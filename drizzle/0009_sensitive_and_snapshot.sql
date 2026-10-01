ALTER TABLE "rso"."notifications" ADD COLUMN "sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rso"."sequence_enrollments" ADD COLUMN "steps_snapshot" jsonb;