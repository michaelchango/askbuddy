CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"key_preview" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "card_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "card_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"requirement_id" text NOT NULL,
	"version" integer NOT NULL,
	"card" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_card_ver" UNIQUE("requirement_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"requirement_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "objects" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prd_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "prd_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"requirement_id" text NOT NULL,
	"version" integer NOT NULL,
	"markdown" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_prd_ver" UNIQUE("requirement_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prds" (
	"requirement_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"markdown" text,
	"current_version" integer DEFAULT 0 NOT NULL,
	"upstream_ids" jsonb,
	"maybe_stale" smallint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_prds_id" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"team_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prototype_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"requirement_id" text NOT NULL,
	"version" integer NOT NULL,
	"structure" jsonb,
	"html_storage_key" text NOT NULL,
	"model" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_proto_ver" UNIQUE("requirement_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prototypes" (
	"requirement_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"structure" jsonb,
	"html_storage_key" text,
	"version" integer,
	"model" text,
	"current_version" integer DEFAULT 0 NOT NULL,
	"upstream_ids" jsonb,
	"maybe_stale" smallint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_prototypes_id" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requirement_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"requirement_id" text NOT NULL,
	"step" text NOT NULL,
	"completion" text DEFAULT 'full' NOT NULL,
	"state" text DEFAULT 'not_started' NOT NULL,
	"awaiting_confirm" smallint DEFAULT 0 NOT NULL,
	"note" text,
	"output_version" integer,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"title_source" text,
	"priority" text,
	"tags" jsonb,
	"category" text,
	"related_ids" jsonb,
	"card" jsonb NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_analysis" (
	"requirement_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"framework" jsonb,
	"materials" jsonb,
	"report" text,
	"user_stories" jsonb,
	"features" jsonb,
	"source_conversation_id" bigint,
	"upstream_ids" jsonb,
	"maybe_stale" smallint DEFAULT 0 NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_research_analysis_id" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_analysis_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "research_analysis_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"requirement_id" text NOT NULL,
	"version" integer NOT NULL,
	"report" text,
	"user_stories" jsonb,
	"features" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ra_ver" UNIQUE("requirement_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"requirement_id" text NOT NULL,
	"type" text DEFAULT 'prototype' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "solution_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "solution_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"requirement_id" text NOT NULL,
	"version" integer NOT NULL,
	"doc" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_sol_ver" UNIQUE("requirement_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "solutions" (
	"requirement_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"doc" text,
	"upstream_ids" jsonb,
	"maybe_stale" smallint DEFAULT 0 NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_solutions_id" UNIQUE("id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card_versions" ADD CONSTRAINT "card_versions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prd_versions" ADD CONSTRAINT "prd_versions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prds" ADD CONSTRAINT "prds_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prototype_versions" ADD CONSTRAINT "prototype_versions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prototypes" ADD CONSTRAINT "prototypes_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "requirement_steps" ADD CONSTRAINT "requirement_steps_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "requirements" ADD CONSTRAINT "requirements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_analysis" ADD CONSTRAINT "research_analysis_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_analysis_versions" ADD CONSTRAINT "research_analysis_versions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "solution_versions" ADD CONSTRAINT "solution_versions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "solutions" ADD CONSTRAINT "solutions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_token_user" ON "api_tokens" USING btree ("user_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_token_hash" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_card_ver_req" ON "card_versions" USING btree ("requirement_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conv_req" ON "conversations" USING btree ("requirement_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_prd_ver_req" ON "prd_versions" USING btree ("requirement_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_owner" ON "projects" USING btree ("owner_id","status") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_proto_ver_req" ON "prototype_versions" USING btree ("requirement_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_step" ON "requirement_steps" USING btree ("requirement_id","step");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_req_project" ON "requirements" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ra_ver_req" ON "research_analysis_versions" USING btree ("requirement_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_share_req" ON "share_tokens" USING btree ("requirement_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sol_ver_req" ON "solution_versions" USING btree ("requirement_id","version");