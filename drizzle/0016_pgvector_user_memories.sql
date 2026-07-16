CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "user_memories" (
	"id" varchar(191) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"category" varchar(256) NOT NULL,
	"status" varchar(256) DEFAULT 'candidate' NOT NULL,
	"sightings" integer DEFAULT 1 NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"source_chat_id" varchar(191),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "user_memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" varchar(255) PRIMARY KEY NOT NULL,
	"memory_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "user_memories_user_id_idx" ON "user_memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_memories_user_id_status_idx" ON "user_memories" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "user_memories_embedding_idx" ON "user_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE POLICY "users_manage_own_memories" ON "user_memories" AS PERMISSIVE FOR ALL TO public USING (user_id = (select current_setting('app.current_user_id', true))) WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));--> statement-breakpoint
CREATE POLICY "users_manage_own_settings" ON "user_settings" AS PERMISSIVE FOR ALL TO public USING (user_id = (select current_setting('app.current_user_id', true))) WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));
