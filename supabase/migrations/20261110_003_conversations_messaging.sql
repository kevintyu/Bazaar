-- Marketplace Migration 003: Listing-based Conversations and Messaging
-- Requires Migration 001 (profiles, shops) and Migration 002 (listings,
-- private.shop_is_publicly_eligible, private schema).
--
-- PRIVACY / SECURITY
-- * One conversation per (listing, buyer); seller is the listing's owner.
-- * Only the buyer/seller can read a conversation and its messages.
-- * Ordinary clients cannot INSERT/UPDATE/DELETE conversations or messages.
-- * Authenticated RPCs derive sender / buyer from auth.uid().
-- * SECURITY DEFINER implementations live in the non-API-exposed private schema.
-- * Each participant independently archives/hides their inbox entry.
-- * Messages are immutable history; hiding a conversation is not data deletion.
-- * Supabase Realtime Postgres Changes may deliver new messages to subscribers
--   who can SELECT those rows under RLS. Persistent history stays in Postgres.
--
-- REVIEWER CORRECTIONS (2026-11-10)
-- * Fail early if Migration 002's eligibility helper is not present.
-- * Limit the ACTUAL stored message body to 4,000 characters and reject
--   whitespace-only messages, without trimming accepted messages.
-- * Use wall-clock message creation time and monotone inbox timestamps.
-- * Provisional policy: new conversations require ACTIVE listings; existing
--   conversations may continue while RESERVED; SOLD/REMOVED conclude chats.
--   This policy must be approved in domain docs before production rollout.
--
-- Review against existing schema and validate in a disposable local Supabase
-- database before application to production.

-- ======================================================================
-- 0. FAIL-FAST PREREQUISITE CHECK
-- ======================================================================
-- This helper IS defined by the original Migration 002 in our bundle.
-- If it is missing from the actual repository, reconcile Migration 002
-- instead of copying a different definition into Migration 003.
do $$
begin
  if to_regclass('public.listings') is null
     or to_regprocedure('private.shop_is_publicly_eligible(uuid)') is null then
    raise exception
      'MIGRATION_002_PREREQUISITES_MISSING: public.listings or private.shop_is_publicly_eligible(uuid)'
      using errcode = 'P0001';
  end if;
end;
$$;

-- ======================================================================
-- 1. ENUMS
-- ======================================================================
create type public.conversation_status as enum ('active', 'concluded');
create type public.message_type as enum ('text', 'system');

-- ======================================================================
-- 2. RELATIONAL INTEGRITY
-- ======================================================================
-- Migration 002 makes listings.owner_user_id equal to its Shop owner.
-- Composite FK below permanently ties conversation seller to Listing owner.
alter table public.listings
  add constraint listings_id_owner_unique unique (id, owner_user_id);

-- ======================================================================
-- 3. CONVERSATIONS
-- ======================================================================
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null,
  buyer_user_id uuid not null references public.profiles(id) on delete restrict,
  seller_user_id uuid not null references public.profiles(id) on delete restrict,
  status public.conversation_status not null default 'active',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  concluded_at timestamptz,

  constraint conversations_listing_seller_fk
    foreign key (listing_id, seller_user_id)
    references public.listings(id, owner_user_id) on delete restrict,
  constraint conversations_distinct_users
    check (buyer_user_id <> seller_user_id),
  constraint conversations_buyer_listing_unique
    unique (listing_id, buyer_user_id),
  constraint conversations_conclusion_consistency
    check (
      (status = 'active' and concluded_at is null)
      or (status = 'concluded' and concluded_at is not null)
    )
);

create index conversations_buyer_inbox_idx
  on public.conversations (buyer_user_id, last_message_at desc nulls last, created_at desc);
create index conversations_seller_inbox_idx
  on public.conversations (seller_user_id, last_message_at desc nulls last, created_at desc);
-- The unique (listing_id, buyer_user_id) index also supports listing lookup.

-- ======================================================================
-- 4. PER-USER INBOX STATE
-- ======================================================================
create table public.conversation_user_states (
  conversation_id uuid not null references public.conversations(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  archived_at timestamptz,
  hidden_at timestamptz,
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);

create index conversation_user_states_user_idx
  on public.conversation_user_states (user_id, hidden_at, archived_at);

-- ======================================================================
-- 5. MESSAGES
-- ======================================================================
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.conversations(id) on delete restrict,
  sender_user_id uuid references public.profiles(id) on delete restrict,
  type public.message_type not null default 'text',
  body text not null,
  client_message_id uuid,
  created_at timestamptz not null default clock_timestamp(),

  -- The stored text (not a trimmed copy) must be <= 4,000 characters.
  -- A positive-length body may still be all spaces/tabs/newlines, so
  -- non-whitespace content is a separate requirement.
  constraint messages_content_length
    check (char_length(body) between 1 and 4000 and body ~ '[^[:space:]]'),
  constraint messages_sender_matches_type
    check (
      (type = 'text' and sender_user_id is not null and client_message_id is not null)
      or
      (type = 'system' and sender_user_id is null and client_message_id is null)
    )
);

-- Same client message ID can be safely retried, but cannot be reused
-- by the sender to create a second message.
create unique index messages_sender_client_id_unique
  on public.messages (sender_user_id, client_message_id)
  where client_message_id is not null;

create index messages_conversation_cursor_idx
  on public.messages (conversation_id, created_at desc, id desc);

-- ======================================================================
-- 6. HELPER FUNCTIONS + TRIGGERS (non-API-exposed private schema)
-- ======================================================================
-- Migration 002 created private, granted schema USAGE and set up
-- public-safe definer helper functions. Keep private out of API exposure.

create function private.is_conversation_participant(p_conversation_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.conversations c
      where c.id = p_conversation_id
        and (
          c.buyer_user_id = (select auth.uid())
          or c.seller_user_id = (select auth.uid())
        )
    );
$$;

-- Automatically prepare inbox state for BOTH conversation participants.
create function private.create_conversation_inbox_rows()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.conversation_user_states (
    conversation_id, user_id, last_read_at
  ) values
    (new.id, new.buyer_user_id, new.created_at),
    (new.id, new.seller_user_id, new.created_at);
  return new;
end;
$$;

create trigger conversations_create_inbox_rows
  after insert on public.conversations
  for each row execute function private.create_conversation_inbox_rows();

-- A new inbound message makes a hidden/archived conversation visible again
-- to its recipient. Sender's own message counts as read.
create function private.on_text_message_insert()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- Never move an inbox's ordering timestamp backwards, even if an
  -- older transaction commits after a newer one.
  update public.conversations
  set last_message_at = greatest(
    coalesce(last_message_at, '-infinity'::timestamptz),
    new.created_at
  )
  where id = new.conversation_id;

  if new.type = 'text' then
    update public.conversation_user_states
    set last_read_at = greatest(
          coalesce(last_read_at, '-infinity'::timestamptz),
          new.created_at
        ),
        hidden_at = null,
        archived_at = null
    where conversation_id = new.conversation_id
      and user_id = new.sender_user_id;

    update public.conversation_user_states
    set hidden_at = null,
        archived_at = null
    where conversation_id = new.conversation_id
      and user_id <> new.sender_user_id;
  end if;
  return new;
end;
$$;

create trigger messages_after_insert_updates_inbox
  after insert on public.messages
  for each row execute function private.on_text_message_insert();

-- When a Listing is SOLD or REMOVED, conclude *all* its Conversations.
-- RESERVED is deliberately not terminal: existing buyers may still chat.
-- Starting a NEW conversation for a RESERVED listing is provisionally blocked.
-- This also catches Migration 002's existing remove_listing() RPC without
-- rewriting or replacing the previously authored function.
create function private.conclude_listing_conversations()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status in ('sold', 'removed')
     and old.status is distinct from new.status then
    update public.conversations
    set status = 'concluded',
        concluded_at = clock_timestamp()
    where listing_id = new.id and status = 'active';
  end if;
  return new;
end;
$$;

create trigger listings_conclude_conversations_on_terminal_status
  after update of status on public.listings
  for each row
  when (old.status is distinct from new.status)
  execute function private.conclude_listing_conversations();

-- ======================================================================
-- 7. RLS + TABLE GRANTS
-- ======================================================================
alter table public.conversations enable row level security;
alter table public.conversation_user_states enable row level security;
alter table public.messages enable row level security;

-- Normal users can ONLY SELECT their conversations, inbox state and messages.
-- All mutations happen via validated domain RPCs.
revoke all on public.conversations from anon, authenticated;
revoke all on public.conversation_user_states from anon, authenticated;
revoke all on public.messages from anon, authenticated;

grant select on public.conversations to authenticated;
grant select on public.conversation_user_states to authenticated;
grant select on public.messages to authenticated;

create policy conversations_select_participant
on public.conversations for select to authenticated
using (
  buyer_user_id = (select auth.uid())
  or seller_user_id = (select auth.uid())
);

create policy conversation_user_states_select_own
on public.conversation_user_states for select to authenticated
using (
  user_id = (select auth.uid())
  and private.is_conversation_participant(conversation_id)
);

create policy messages_select_participant
on public.messages for select to authenticated
using (private.is_conversation_participant(conversation_id));

-- ======================================================================
-- 8. START CONVERSATION (listing-scoped and idempotent)
-- ======================================================================
create function private.start_conversation_impl(p_listing_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_buyer uuid := auth.uid();
  v_listing public.listings%rowtype;
  v_conversation_id uuid;
begin
  if v_buyer is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_buyer and p.status = 'active'
  ) then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  -- Share-lock the listing to avoid creating a conversation while a concurrent
  -- sale/removal is changing its eligibility.
  select * into v_listing
  from public.listings where id = p_listing_id
  for share;

  if not found then
    raise exception 'LISTING_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_listing.owner_user_id = v_buyer then
    raise exception 'CANNOT_MESSAGE_OWN_LISTING' using errcode = 'P0001';
  end if;

  -- PROVISIONAL PRODUCT DECISION: prevent brand-new inquiries once a
  -- listing is RESERVED. Existing participants may continue messaging.
  if v_listing.status <> 'active'
     or v_listing.moderation_status <> 'clear'
     or not private.shop_is_publicly_eligible(v_listing.shop_id) then
    raise exception 'LISTING_NOT_AVAILABLE_FOR_CHAT' using errcode = 'P0001';
  end if;

  insert into public.conversations (
    listing_id, buyer_user_id, seller_user_id
  ) values (
    v_listing.id, v_buyer, v_listing.owner_user_id
  )
  on conflict (listing_id, buyer_user_id) do nothing
  returning id into v_conversation_id;

  if v_conversation_id is null then
    select id into v_conversation_id from public.conversations
    where listing_id = v_listing.id and buyer_user_id = v_buyer;
  end if;

  return v_conversation_id;
end;
$$;

create function public.start_conversation(p_listing_id uuid)
returns uuid
language sql security invoker
set search_path = ''
as $$
  select private.start_conversation_impl(p_listing_id);
$$;

-- ======================================================================
-- 9. SEND MESSAGE (idempotent retries, no sender spoofing)
-- ======================================================================
create function private.send_message_impl(
  p_conversation_id uuid,
  p_body text,
  p_client_message_id uuid
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_sender uuid := auth.uid();
  v_conversation public.conversations%rowtype;
  v_message_id uuid;
  v_previous public.messages%rowtype;
begin
  if v_sender is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  if p_client_message_id is null then
    raise exception 'CLIENT_MESSAGE_ID_REQUIRED' using errcode = 'P0001';
  end if;

  if p_body is null
     or char_length(p_body) not between 1 and 4000
     or p_body !~ '[^[:space:]]' then
    raise exception 'INVALID_MESSAGE_BODY' using errcode = 'P0001';
  end if;

  -- Serialize against terminal-status close operations on this Conversation.
  select * into v_conversation
  from public.conversations where id = p_conversation_id
  for update;

  if not found or v_sender not in (
    v_conversation.buyer_user_id, v_conversation.seller_user_id
  ) then
    raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- If a request was already committed, an exact retry succeeds even if the
  -- conversation has since concluded. Reusing the ID for different content
  -- fails explicitly.
  select * into v_previous from public.messages
  where sender_user_id = v_sender
    and client_message_id = p_client_message_id;

  if found then
    if v_previous.conversation_id <> p_conversation_id
       or v_previous.body <> p_body then
      raise exception 'MESSAGE_ID_REUSE_CONFLICT' using errcode = 'P0001';
    end if;
    return v_previous.id;
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_sender and p.status = 'active'
  ) then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  if v_conversation.status <> 'active' then
    raise exception 'CONVERSATION_CONCLUDED' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.listings l
    where l.id = v_conversation.listing_id
      and l.status in ('active', 'reserved')
      and l.moderation_status = 'clear'
      and private.shop_is_publicly_eligible(l.shop_id)
  ) then
    raise exception 'LISTING_NOT_AVAILABLE_FOR_CHAT' using errcode = 'P0001';
  end if;

  insert into public.messages (
    conversation_id, sender_user_id, type, body, client_message_id
  ) values (
    p_conversation_id, v_sender, 'text', p_body, p_client_message_id
  )
  on conflict (sender_user_id, client_message_id)
    where client_message_id is not null do nothing
  returning id into v_message_id;

  -- Covers a concurrent duplicate submission from the same sender across
  -- sessions; on conflict fetch and verify the prior committed message.
  if v_message_id is null then
    select * into v_previous from public.messages
    where sender_user_id = v_sender
      and client_message_id = p_client_message_id;

    if not found or v_previous.conversation_id <> p_conversation_id
       or v_previous.body <> p_body then
      raise exception 'MESSAGE_ID_REUSE_CONFLICT' using errcode = 'P0001';
    end if;
    v_message_id := v_previous.id;
  end if;

  return v_message_id;
end;
$$;

create function public.send_message(
  p_conversation_id uuid,
  p_body text,
  p_client_message_id uuid
)
returns uuid
language sql security invoker
set search_path = ''
as $$
  select private.send_message_impl(
    p_conversation_id, p_body, p_client_message_id
  );
$$;

-- ======================================================================
-- 10. PER-PARTICIPANT INBOX OPERATIONS
-- ======================================================================
create function private.update_conversation_inbox_impl(
  p_conversation_id uuid,
  p_action text,
  p_value boolean default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  if not private.is_conversation_participant(p_conversation_id) then
    raise exception 'CONVERSATION_NOT_FOUND' using errcode = 'P0001';
  end if;

  if p_action = 'archive' then
    if p_value is null then
      raise exception 'INVALID_INBOX_ACTION' using errcode = 'P0001';
    end if;
    update public.conversation_user_states
    set archived_at = case when p_value then clock_timestamp() else null end
    where conversation_id = p_conversation_id and user_id = v_user_id;
  elsif p_action = 'hide' then
    if p_value is null then
      raise exception 'INVALID_INBOX_ACTION' using errcode = 'P0001';
    end if;
    update public.conversation_user_states
    set hidden_at = case when p_value then clock_timestamp() else null end
    where conversation_id = p_conversation_id and user_id = v_user_id;
  elsif p_action = 'read' then
    -- Read advances only to the newest message currently recorded for
    -- this conversation, never to an unrelated transaction start time.
    -- A future client message cursor can make read acknowledgements more
    -- exact when live messages race against inbox refreshes.
    update public.conversation_user_states cus
    set last_read_at = greatest(
      coalesce(cus.last_read_at, '-infinity'::timestamptz),
      coalesce(
        (select coalesce(c.last_message_at, c.created_at)
         from public.conversations c
         where c.id = p_conversation_id),
        '-infinity'::timestamptz
      )
    )
    where cus.conversation_id = p_conversation_id
      and cus.user_id = v_user_id;
  else
    raise exception 'INVALID_INBOX_ACTION' using errcode = 'P0001';
  end if;

  if not found then
    raise exception 'INBOX_STATE_MISSING' using errcode = 'P0001';
  end if;
end;
$$;

create function public.set_conversation_archived(
  p_conversation_id uuid, p_archived boolean
)
returns void
language sql security invoker
set search_path = ''
as $$
  select private.update_conversation_inbox_impl(
    p_conversation_id, 'archive', p_archived
  );
$$;

create function public.set_conversation_hidden(
  p_conversation_id uuid, p_hidden boolean
)
returns void
language sql security invoker
set search_path = ''
as $$
  select private.update_conversation_inbox_impl(
    p_conversation_id, 'hide', p_hidden
  );
$$;

create function public.mark_conversation_read(p_conversation_id uuid)
returns void
language sql security invoker
set search_path = ''
as $$
  select private.update_conversation_inbox_impl(
    p_conversation_id, 'read', null
  );
$$;

-- ======================================================================
-- 11. FUNCTION EXECUTION PRIVILEGES
-- ======================================================================
-- Trigger implementations aren't intended as callable API operations.
revoke all on function private.is_conversation_participant(uuid) from public;
revoke all on function private.create_conversation_inbox_rows() from public;
revoke all on function private.on_text_message_insert() from public;
revoke all on function private.conclude_listing_conversations() from public;
revoke all on function private.start_conversation_impl(uuid) from public;
revoke all on function private.send_message_impl(uuid,text,uuid) from public;
revoke all on function private.update_conversation_inbox_impl(uuid,text,boolean) from public;

-- RLS needs to evaluate this private helper as the authenticated role.
grant execute on function private.is_conversation_participant(uuid) to authenticated;

-- Wrappers may call their private implementations; each implementation
-- checks the calling JWT identity and business rules itself.
grant execute on function private.start_conversation_impl(uuid) to authenticated;
grant execute on function private.send_message_impl(uuid,text,uuid) to authenticated;
grant execute on function private.update_conversation_inbox_impl(uuid,text,boolean) to authenticated;

revoke all on function public.start_conversation(uuid) from public;
revoke all on function public.send_message(uuid,text,uuid) from public;
revoke all on function public.set_conversation_archived(uuid,boolean) from public;
revoke all on function public.set_conversation_hidden(uuid,boolean) from public;
revoke all on function public.mark_conversation_read(uuid) from public;

grant execute on function public.start_conversation(uuid) to authenticated;
grant execute on function public.send_message(uuid,text,uuid) to authenticated;
grant execute on function public.set_conversation_archived(uuid,boolean) to authenticated;
grant execute on function public.set_conversation_hidden(uuid,boolean) to authenticated;
grant execute on function public.mark_conversation_read(uuid) to authenticated;

-- ======================================================================
-- 12. REALTIME POSTGRES CHANGES (MVP)
-- ======================================================================
-- Supabase normally provisions the supabase_realtime publication.
-- Use Postgres Changes for simplicity in the first chat slice; Broadcast
-- can replace this as usage grows. Never subscribe anonymously to messages.
-- Do not drop/recreate the existing publication (may contain other tables).
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'messages'
    ) then
      execute 'alter publication supabase_realtime add table public.messages';
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'conversations'
    ) then
      execute 'alter publication supabase_realtime add table public.conversations';
    end if;
  else
    raise notice 'supabase_realtime publication not found: add messages and conversations after Realtime is configured';
  end if;
end;
$$;

-- End Migration 003.
