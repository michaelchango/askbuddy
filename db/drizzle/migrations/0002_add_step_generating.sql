ALTER TABLE "requirement_steps" ADD COLUMN IF NOT EXISTS "generating" smallint DEFAULT 0 NOT NULL;
