-- Wrap current_setting() in (select ...) so PostgreSQL evaluates the current
-- user id once per statement (an InitPlan) instead of once per row. This is the
-- same pattern the memories/chunks/settings policies (0016/0017) already use;
-- these four legacy policies predate it and were still calling current_setting
-- per row. Row visibility is unchanged — identical predicate, evaluated once.
--
-- (Supersedes the never-registered, stale-named drizzle/0016_wrap_rls_current_setting.sql.)
ALTER POLICY "users_manage_own_chats" ON "chats"
  USING (user_id = (select current_setting('app.current_user_id', true)))
  WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));
--> statement-breakpoint
ALTER POLICY "users_manage_own_files" ON "files"
  USING (user_id = (select current_setting('app.current_user_id', true)))
  WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));
--> statement-breakpoint
ALTER POLICY "users_manage_own_notes" ON "notes"
  USING (user_id = (select current_setting('app.current_user_id', true)))
  WITH CHECK (user_id = (select current_setting('app.current_user_id', true)));
--> statement-breakpoint
ALTER POLICY "users_anonymize_own_feedback" ON "feedback"
  USING (user_id = (select current_setting('app.current_user_id', true)));
