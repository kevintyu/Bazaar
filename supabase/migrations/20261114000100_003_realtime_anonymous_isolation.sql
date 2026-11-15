-- Realtime apply_rls sends a 401 envelope per change when the subscriber
-- cannot SELECT the primary key, before evaluating row policies. With no
-- filter this reveals table activity, even though records are empty.
-- Permit only the PK authorization probe; restrictive RLS denies EVERY anon
-- row. No table-wide SELECT, message content, or write privilege is granted.
-- Authenticated participant policies and all previously applied SQL remain.
create policy messages_anon_deny
  on public.messages as restrictive for select to anon using (false);
create policy conversations_anon_deny
  on public.conversations as restrictive for select to anon using (false);
grant select (id) on public.messages, public.conversations to anon;
