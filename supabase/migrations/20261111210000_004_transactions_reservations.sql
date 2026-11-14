-- Migration 004 foundation: seller-controlled reservation and cancellation.
-- Forward-only; preserves 001/002/compatibility/003 and all existing history.
-- Pickup/confirmation/dispute/finalization RPCs are deliberately absent.

create type public.transaction_status as enum (
  'reserved', 'awaiting_buyer_confirmation', 'completed', 'cancelled', 'disputed'
);

alter table public.listings add constraint listings_transaction_identity_unique
  unique (id, shop_id, owner_user_id);
alter table public.conversations add constraint conversations_transaction_identity_unique
  unique (id, listing_id, buyer_user_id, seller_user_id);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null,
  shop_id uuid not null,
  conversation_id uuid not null,
  buyer_user_id uuid not null,
  seller_user_id uuid not null,
  request_id uuid not null,
  status public.transaction_status not null default 'reserved',
  reserved_at timestamptz not null default clock_timestamp(),
  cancelled_at timestamptz,
  cancelled_by_user_id uuid references public.profiles(id) on delete restrict,
  cancellation_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint transactions_listing_identity_fk foreign key (listing_id, shop_id, seller_user_id)
    references public.listings(id, shop_id, owner_user_id) on delete restrict,
  constraint transactions_conversation_identity_fk
    foreign key (conversation_id, listing_id, buyer_user_id, seller_user_id)
    references public.conversations(id, listing_id, buyer_user_id, seller_user_id) on delete restrict,
  constraint transactions_distinct_participants check (buyer_user_id <> seller_user_id),
  constraint transactions_seller_request_unique unique (seller_user_id, request_id),
  -- Future states cannot be activated until their policy and operations are implemented.
  constraint transactions_foundation_states check (status in ('reserved', 'cancelled')),
  constraint transactions_cancellation_metadata check (
    (status = 'reserved' and cancelled_at is null and cancelled_by_user_id is null
      and cancellation_reason is null)
    or (status = 'cancelled' and cancelled_at is not null and cancelled_by_user_id is not null
      and cancelled_by_user_id in (buyer_user_id, seller_user_id) and cancelled_at >= reserved_at)
  ),
  constraint transactions_reason_length check (char_length(cancellation_reason) <= 1000)
);
create unique index one_active_transaction_per_listing on public.transactions(listing_id)
  where status in ('reserved', 'awaiting_buyer_confirmation', 'disputed');
create index transactions_buyer_history_idx on public.transactions(buyer_user_id, created_at desc, id);
create index transactions_seller_history_idx on public.transactions(seller_user_id, created_at desc, id);
create index transactions_listing_history_idx on public.transactions(listing_id, created_at desc, id);
create index transactions_conversation_idx on public.transactions(conversation_id);

create table public.transaction_events (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete restrict,
  actor_user_id uuid not null references public.profiles(id) on delete restrict,
  from_status public.transaction_status,
  to_status public.transaction_status not null,
  occurred_at timestamptz not null,
  cancellation_reason text,
  constraint transaction_events_transition check (
    (from_status is null and to_status = 'reserved' and cancellation_reason is null)
    or (from_status = 'reserved' and to_status = 'cancelled')
  ),
  constraint transaction_events_once unique (transaction_id, to_status)
);

create function private.guard_transaction_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'TRANSACTION_HISTORY_IMMUTABLE'; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'reserved' then raise exception 'INVALID_TRANSACTION_STATE'; end if;
    return new;
  end if;
  if (to_jsonb(new) - array['status','cancelled_at','cancelled_by_user_id','cancellation_reason','updated_at'])
     is distinct from
     (to_jsonb(old) - array['status','cancelled_at','cancelled_by_user_id','cancellation_reason','updated_at']) then
    raise exception 'TRANSACTION_IDENTITY_IMMUTABLE';
  end if;
  if old.status <> 'reserved' or new.status <> 'cancelled' then
    raise exception 'INVALID_TRANSACTION_STATE';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger transactions_guard_history before insert or update or delete on public.transactions
  for each row execute function private.guard_transaction_history();

create function private.record_transaction_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.transaction_events(transaction_id,actor_user_id,from_status,to_status,occurred_at)
      values(new.id,new.seller_user_id,null,'reserved',new.reserved_at);
  else
    insert into public.transaction_events(transaction_id,actor_user_id,from_status,to_status,occurred_at,cancellation_reason)
      values(new.id,new.cancelled_by_user_id,old.status,new.status,new.cancelled_at,new.cancellation_reason);
  end if;
  return new;
end;
$$;
create trigger transactions_record_event after insert or update on public.transactions
  for each row execute function private.record_transaction_event();

create function private.reject_transaction_event_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'TRANSACTION_EVENT_IMMUTABLE';
end;
$$;
create trigger transaction_events_immutable before update or delete on public.transaction_events
  for each row execute function private.reject_transaction_event_mutation();

alter table public.transactions enable row level security;
alter table public.transaction_events enable row level security;
revoke all on public.transactions, public.transaction_events from public, anon, authenticated, service_role;
grant select on public.transactions, public.transaction_events to authenticated;
create policy transactions_select_participant on public.transactions for select to authenticated
  using ((select auth.uid()) in (buyer_user_id, seller_user_id));
create policy transaction_events_select_participant on public.transaction_events for select to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id
    and (select auth.uid()) in (t.buyer_user_id,t.seller_user_id)));

create function private.reserve_listing_impl(p_conversation_id uuid, p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_c public.conversations%rowtype;
  v_l public.listings%rowtype;
  v_previous public.transactions%rowtype;
  v_id uuid;
begin
  if v_actor is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  -- Scope before locks to avoid letting outsiders lock another seller's Listing.
  select * into v_c from public.conversations
    where id = p_conversation_id and seller_user_id = v_actor;
  if not found then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  select * into v_l from public.listings where id = v_c.listing_id for update;
  if not found or v_l.owner_user_id <> v_actor then raise exception 'LISTING_NOT_OWNED'; end if;

  select * into v_previous from public.transactions
    where seller_user_id = v_actor and request_id = p_request_id;
  if found then
    if v_previous.conversation_id <> p_conversation_id then raise exception 'RESERVATION_REQUEST_CONFLICT'; end if;
    return v_previous.id;
  end if;
  if v_l.status <> 'active' then raise exception 'INVALID_LISTING_STATE'; end if;
  if v_l.moderation_status <> 'clear'
     or not private.shop_is_publicly_eligible(v_l.shop_id) then
    raise exception 'LISTING_NOT_AVAILABLE_FOR_RESERVATION';
  end if;
  if not exists(select 1 from public.profiles where id = v_c.buyer_user_id and status = 'active') then
    raise exception 'BUYER_NOT_ACTIVE';
  end if;
  -- Listing lock serializes start/remove/reserve; recheck the Conversation after it.
  select * into v_c from public.conversations where id = p_conversation_id for share;
  if v_c.status <> 'active' then raise exception 'CONVERSATION_CONCLUDED'; end if;

  insert into public.transactions(listing_id,shop_id,conversation_id,buyer_user_id,seller_user_id,request_id)
    values(v_l.id,v_l.shop_id,v_c.id,v_c.buyer_user_id,v_actor,p_request_id)
    on conflict (seller_user_id,request_id) do nothing returning id into v_id;
  -- Covers simultaneous reuse across different Listing locks; no second Listing is mutated.
  if v_id is null then
    select * into v_previous from public.transactions
      where seller_user_id = v_actor and request_id = p_request_id;
    if not found or v_previous.conversation_id <> p_conversation_id then
      raise exception 'RESERVATION_REQUEST_CONFLICT';
    end if;
    return v_previous.id;
  end if;
  update public.listings set status = 'reserved' where id = v_l.id;
  return v_id;
end;
$$;
create function public.reserve_listing(p_conversation_id uuid, p_request_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select private.reserve_listing_impl(p_conversation_id,p_request_id);
$$;

revoke all on function private.guard_transaction_history() from public,anon,authenticated,service_role;
revoke all on function private.record_transaction_event() from public,anon,authenticated,service_role;
revoke all on function private.reject_transaction_event_mutation() from public,anon,authenticated,service_role;
revoke all on function private.reserve_listing_impl(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.reserve_listing(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.reserve_listing_impl(uuid,uuid) to authenticated;
grant execute on function public.reserve_listing(uuid,uuid) to authenticated;

create function private.cancel_transaction_impl(p_transaction_id uuid, p_reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_t public.transactions%rowtype;
  v_l public.listings%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_actor is null then raise exception 'UNAUTHENTICATED'; end if;
  if char_length(p_reason) > 1000 then raise exception 'INVALID_CANCELLATION_REASON'; end if;
  select * into v_t from public.transactions where id = p_transaction_id
    and v_actor in (buyer_user_id,seller_user_id);
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;
  -- Same order as reserve/remove: Listing before Transaction, never the reverse.
  select * into v_l from public.listings where id = v_t.listing_id for update;
  select * into v_t from public.transactions where id = p_transaction_id for update;
  if v_t.status = 'cancelled' then
    if v_t.cancelled_by_user_id = v_actor and v_t.cancellation_reason is not distinct from v_reason then
      return v_t.id; -- Receipt only: never changes a newer reservation or replays the transition.
    end if;
    raise exception 'CANCELLATION_REQUEST_CONFLICT';
  end if;
  if v_t.status <> 'reserved' then raise exception 'INVALID_TRANSACTION_STATE'; end if;
  if v_l.status <> 'reserved' then raise exception 'INVALID_LISTING_STATE'; end if;
  -- Owner-confirmed 2026-11-11: no cancellation while either account, Shop,
  -- or Listing is restricted. History remains readable; no automatic cancellation.
  if v_l.moderation_status <> 'clear'
     or not private.shop_is_publicly_eligible(v_l.shop_id)
     or not exists(select 1 from public.profiles where id = v_t.buyer_user_id and status = 'active') then
    raise exception 'TRANSACTION_RESTRICTED';
  end if;
  update public.transactions set status = 'cancelled', cancelled_at = clock_timestamp(),
    cancelled_by_user_id = v_actor, cancellation_reason = v_reason where id = v_t.id;
  update public.listings set status = 'active' where id = v_l.id;
  return v_t.id;
end;
$$;
create function public.cancel_transaction(p_transaction_id uuid, p_reason text default null)
returns uuid language sql security invoker set search_path = '' as $$
  select private.cancel_transaction_impl(p_transaction_id,p_reason);
$$;
revoke all on function private.cancel_transaction_impl(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.cancel_transaction(uuid,text) from public,anon,authenticated,service_role;
grant execute on function private.cancel_transaction_impl(uuid,text) to authenticated;
grant execute on function public.cancel_transaction(uuid,text) to authenticated;
