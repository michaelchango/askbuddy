CREATE TABLE IF NOT EXISTS "dev_contexts" (
	"requirement_id" text PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"completeness_score" numeric(4,3) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"applicable_count" integer DEFAULT 0 NOT NULL,
	"present_count" integer DEFAULT 0 NOT NULL,
	"upstream_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"maybe_stale" smallint DEFAULT 0 NOT NULL,
	"generated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_devctx_status" CHECK ("status" IN ('draft','confirmed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dev_context_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"requirement_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"completeness_score" numeric(4,3) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"changelog" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_devctx_ver" UNIQUE("requirement_id","version")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dev_context_versions" ADD CONSTRAINT "dev_context_versions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_devctx_score" ON "dev_contexts" USING btree ("completeness_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_devctx_ver_req" ON "dev_context_versions" USING btree ("requirement_id","version");
