ALTER TABLE "files" ADD COLUMN "status" varchar(256) NOT NULL DEFAULT 'pending';
ALTER TABLE "files" ADD COLUMN "ingest_stage" varchar(256);
ALTER TABLE "files" ADD COLUMN "attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "files" ADD COLUMN "claimed_at" timestamp;
ALTER TABLE "files" ADD COLUMN "ingest_error" text;
ALTER TABLE "files" ADD COLUMN "ingested_at" timestamp;
-- Rows that predate ingestion tracking already work (or never will): ready.
UPDATE "files" SET "status" = 'ready';
CREATE INDEX "files_status_created_at_idx" ON "files" ("status","created_at");
