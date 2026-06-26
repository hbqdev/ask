ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "last_viewed_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chats_user_id_last_viewed_at_idx" ON "chats" ("user_id","last_viewed_at" DESC NULLS LAST);
