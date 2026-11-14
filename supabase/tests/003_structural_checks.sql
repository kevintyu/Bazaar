-- Migration 003 structural checks.
-- Run against a disposable Supabase development database after 001 + 002 + 003.
-- These checks do NOT replace real JWT-role, concurrency and Realtime tests.

do $$
begin
  if to_regclass('public.listings') is null
     or to_regclass('public.profiles') is null then
    raise exception 'Migrations 001/002 prerequisites missing';
  end if;

  if to_regclass('public.conversations') is null
     or to_regclass('public.conversation_user_states') is null
     or to_regclass('public.messages') is null then
    raise exception 'Migration 003 tables missing';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('conversations', 'conversation_user_states', 'messages')
    group by n.nspname
    having count(*) filter (where c.relrowsecurity) = 3
  ) then
    raise exception 'RLS not enabled for all Messaging tables';
  end if;

  if to_regprocedure('public.start_conversation(uuid)') is null
    or to_regprocedure('public.send_message(uuid,text,uuid)') is null
    or to_regprocedure('public.set_conversation_archived(uuid,boolean)') is null
    or to_regprocedure('public.set_conversation_hidden(uuid,boolean)') is null
    or to_regprocedure('public.mark_conversation_read(uuid)') is null then
    raise exception 'Required public Messaging RPC missing';
  end if;

  if to_regprocedure('private.is_conversation_participant(uuid)') is null
    or to_regprocedure('private.start_conversation_impl(uuid)') is null
    or to_regprocedure('private.send_message_impl(uuid,text,uuid)') is null then
    raise exception 'Private guarded Messaging helpers missing';
  end if;

  if has_table_privilege('anon', 'public.messages', 'SELECT')
    or has_table_privilege('anon', 'public.conversations', 'SELECT')
    or has_table_privilege('anon', 'public.conversation_user_states', 'SELECT') then
    raise exception 'Anonymous users can SELECT private messaging tables';
  end if;

  if not has_table_privilege('authenticated', 'public.messages', 'SELECT')
    or not has_table_privilege('authenticated', 'public.conversations', 'SELECT')
    or not has_table_privilege('authenticated', 'public.conversation_user_states', 'SELECT') then
    raise exception 'Authenticated users lack RLS-scoped SELECT';
  end if;

  if has_table_privilege('authenticated', 'public.conversations', 'INSERT')
    or has_table_privilege('authenticated', 'public.conversations', 'UPDATE')
    or has_table_privilege('authenticated', 'public.conversations', 'DELETE')
    or has_table_privilege('authenticated', 'public.messages', 'INSERT')
    or has_table_privilege('authenticated', 'public.messages', 'UPDATE')
    or has_table_privilege('authenticated', 'public.messages', 'DELETE')
    or has_table_privilege('authenticated', 'public.conversation_user_states', 'INSERT')
    or has_table_privilege('authenticated', 'public.conversation_user_states', 'UPDATE')
    or has_table_privilege('authenticated', 'public.conversation_user_states', 'DELETE') then
    raise exception 'Authenticated clients have unsafe direct messaging writes';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.conversations'::regclass
      and conname = 'conversations_buyer_listing_unique'
      and contype = 'u'
  ) then
    raise exception 'One conversation per buyer/listing constraint missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.conversations'::regclass
      and conname = 'conversations_listing_seller_fk'
      and contype = 'f'
  ) then
    raise exception 'Conversation seller/Listing-owner FK missing';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'messages'
      and indexname = 'messages_sender_client_id_unique'
  ) then
    raise exception 'Message retry-dedup index missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.listings'::regclass
      and tgname = 'listings_conclude_conversations_on_terminal_status'
      and not tgisinternal
  ) then
    raise exception 'Automatic conversation conclusion trigger missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.messages'::regclass
      and tgname = 'messages_after_insert_updates_inbox'
      and not tgisinternal
  ) then
    raise exception 'Message/inbox trigger missing';
  end if;

  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'messages'
    ) then
      raise exception 'Messages not added to supabase_realtime publication';
    end if;
  else
    raise notice 'No Supabase Realtime publication found; configure before chat live testing';
  end if;

  raise notice 'Migration 003 structural checks passed';
end;
$$;
