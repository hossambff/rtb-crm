CREATE TABLE "rso"."restricted_access" (
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restricted_access_entity_entity_id_user_id_pk" PRIMARY KEY("entity","entity_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "rso"."restricted_access" ADD CONSTRAINT "restricted_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "rso"."user"("id") ON DELETE cascade ON UPDATE no action;