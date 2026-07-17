CREATE TABLE IF NOT EXISTS "conversation_chunks" (
	"id" varchar(191) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"chat_id" varchar(191) NOT NULL,
	"message_id" varchar(191) NOT NULL,
	"role" varchar(256) NOT NULL,
	"content" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversation_chunks" ADD CONSTRAINT "conversation_chunks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_chunks" ADD CONSTRAINT "conversation_chunks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversation_chunks_user_id_idx" ON "conversation_chunks" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "conversation_chunks_chat_id_idx" ON "conversation_chunks" USING btree ("chat_id");
--> statement-breakpoint
CREATE INDEX "conversation_chunks_message_id_idx" ON "conversation_chunks" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX "conversation_chunks_embedding_idx" ON "conversation_chunks" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE POLICY "users_manage_own_conversation_chunks" ON "conversation_chunks" AS PERMISSIVE FOR ALL TO public USING (user_id = (select current_setting('app.current_user_id', true))) WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "recall_enabled" boolean DEFAULT true NOT NULL;
