CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chats_title_trgm_idx" ON "chats" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parts_text_text_trgm_idx" ON "parts" USING gin ("text_text" gin_trgm_ops);
