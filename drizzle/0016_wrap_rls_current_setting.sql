-- Wrap current_setting() in (select ...) so PostgreSQL evaluates it once per
-- statement instead of once per row. This is a documented Supabase RLS
-- performance pattern (InitPlan vs per-row volatile function evaluation).

-- chats table policies
ALTER POLICY "Users can only access their own chats" ON "public"."chats"
  USING (user_id = (select current_setting('app.current_user_id', true)))
  WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));

-- files table policies
ALTER POLICY "Users can only access their own files" ON "public"."files"
  USING (user_id = (select current_setting('app.current_user_id', true)))
  WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));

-- notes table policies
ALTER POLICY "Users can only access their own notes" ON "public"."notes"
  USING (user_id = (select current_setting('app.current_user_id', true)))
  WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));

-- feedback table policies
ALTER POLICY "Users can only access their own feedback" ON "public"."feedback"
  USING (user_id = (select current_setting('app.current_user_id', true)))
  WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));
