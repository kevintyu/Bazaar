-- Forward-only extension of the applied reserve/cancel foundation.
-- Compatibility mapping: awaiting_buyer_confirmation is the EXISTING enum
-- value used for a buyer claim awaiting SELLER confirmation. No enum is renamed.
-- No completion deadline, scheduler or external notification delivery is added.

create table private.transaction_administrators (
  user_id uuid primary key references public.profiles(id) on delete restrict,
  enabled boolean not null default true
);
comment on table private.transaction_administrators is
  'Operator-managed allowlist. Never populate from user_metadata or client role claims.';

create function private.valid_resolution_evidence(p_refs jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_refs) = 'array' then
    jsonb_array_length(p_refs) between 1 and 20 and not exists (
      select 1 from jsonb_array_elements(p_refs) e
      where jsonb_typeof(e) <> 'string' or length(btrim(e #>> '{}')) not between 1 and 1000
        or (e #>> '{}') !~ '[^[:space:]]'
    ) else false end;
$$;

create table private.transaction_resolutions (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions(id) on delete restrict,
  administrator_id uuid not null references public.profiles(id) on delete restrict,
  request_id uuid not null,
  outcome text not null check (outcome in ('completed','cancelled')),
  reason text not null check (length(reason) <= 1000 and length(regexp_replace(reason,'[[:space:]]','','g')) >= 10),
  evidence_references jsonb not null check (private.valid_resolution_evidence(evidence_references)),
  review_findings text not null check (length(review_findings) <= 4000 and length(regexp_replace(review_findings,'[[:space:]]','','g')) >= 20),
  resolved_at timestamptz not null default clock_timestamp(),
  unique (administrator_id, request_id)
);
create trigger transaction_resolutions_immutable before update or delete on private.transaction_resolutions
  for each row execute function private.reject_transaction_event_mutation();

alter table public.transactions
  add column pickup_claimed_at timestamptz,
  add column seller_confirmed_at timestamptz,
  add column completed_at timestamptz,
  add column completed_by_user_id uuid references public.profiles(id) on delete restrict,
  add column administrator_resolution_id uuid references private.transaction_resolutions(id) on delete restrict;

alter table public.transactions drop constraint transactions_foundation_states;
alter table public.transactions drop constraint transactions_cancellation_metadata;
alter table public.transactions add constraint transactions_lifecycle_metadata check (
  (pickup_claimed_at is null or pickup_claimed_at >= reserved_at)
  and (seller_confirmed_at is null or (pickup_claimed_at is not null
    and seller_confirmed_at >= pickup_claimed_at and completed_by_user_id = seller_user_id))
  and (
    (status = 'reserved' and pickup_claimed_at is null and completed_at is null
      and completed_by_user_id is null and seller_confirmed_at is null and administrator_resolution_id is null)
    or (status in ('awaiting_buyer_confirmation','disputed') and pickup_claimed_at is not null
      and completed_at is null and completed_by_user_id is null
      and seller_confirmed_at is null and administrator_resolution_id is null)
    or (status = 'completed' and pickup_claimed_at is not null and completed_at is not null
      and completed_at >= pickup_claimed_at and completed_by_user_id is not null
      and ((administrator_resolution_id is null and seller_confirmed_at is not null
        and seller_confirmed_at = completed_at and completed_by_user_id = seller_user_id)
        or (administrator_resolution_id is not null and seller_confirmed_at is null)))
    or (status = 'cancelled' and completed_at is null and completed_by_user_id is null
      and seller_confirmed_at is null)
  )
);
alter table public.transactions add constraint transactions_cancellation_metadata check (
  (status <> 'cancelled' and cancelled_at is null and cancelled_by_user_id is null and cancellation_reason is null)
  or (status = 'cancelled' and cancelled_at is not null and cancelled_by_user_id is not null
    and cancelled_at >= reserved_at and (pickup_claimed_at is null or cancelled_at >= pickup_claimed_at)
    and ((administrator_resolution_id is null and pickup_claimed_at is null
      and cancelled_by_user_id in (buyer_user_id,seller_user_id))
      or (administrator_resolution_id is not null and cancellation_reason is null)))
);

alter table public.transaction_events add column administrator_resolution_id uuid
  references private.transaction_resolutions(id) on delete restrict;
alter table public.transaction_events drop constraint transaction_events_transition;
alter table public.transaction_events add constraint transaction_events_transition check (
  (from_status is null and to_status = 'reserved' and cancellation_reason is null
    and administrator_resolution_id is null)
  or (from_status is not null and (
    (from_status = 'reserved' and to_status = 'cancelled')
    or (from_status = 'reserved' and to_status = 'awaiting_buyer_confirmation'
      and cancellation_reason is null and administrator_resolution_id is null)
    or (from_status in ('awaiting_buyer_confirmation','disputed') and to_status = 'completed'
      and cancellation_reason is null)
    or (from_status in ('awaiting_buyer_confirmation','disputed') and to_status = 'cancelled'
      and administrator_resolution_id is not null and cancellation_reason is null)
  ))
);
-- Existing single-active index already includes the compatibility pending state
-- and DISPUTED; keep it, request UUID uniqueness and all identity FKs unchanged.

create table private.transaction_notification_policy (
  singleton boolean primary key default true check (singleton),
  reminder_interval interval check (reminder_interval > interval '0'),
  escalation_after interval check (escalation_after > interval '0')
);
insert into private.transaction_notification_policy(singleton) values(true);
create table private.transaction_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete restrict,
  kind text not null check (kind in ('pickup_claimed','confirmation_reminder','administrator_escalation')),
  sequence_no integer not null check (sequence_no >= 0),
  recipient_user_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique(transaction_id,kind,sequence_no),
  check ((kind = 'administrator_escalation' and recipient_user_id is null)
    or (kind <> 'administrator_escalation' and recipient_user_id is not null))
);
create index transaction_notification_outbox_created_idx
  on private.transaction_notification_outbox(created_at,id);
create index transactions_pending_claim_idx on public.transactions(pickup_claimed_at,id)
  where status = 'awaiting_buyer_confirmation';
create trigger transaction_notification_outbox_immutable before update or delete
  on private.transaction_notification_outbox
  for each row execute function private.reject_transaction_event_mutation();

revoke all on private.transaction_administrators, private.transaction_resolutions,
  private.transaction_notification_policy, private.transaction_notification_outbox
  from public, anon, authenticated, service_role;
alter table private.transaction_administrators enable row level security;
alter table private.transaction_resolutions enable row level security;
alter table private.transaction_notification_policy enable row level security;
alter table private.transaction_notification_outbox enable row level security;
revoke all on function private.valid_resolution_evidence(jsonb) from public,anon,authenticated,service_role;

create function private.require_transaction_administrator()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'UNAUTHENTICATED'; end if;
  -- Lock membership against concurrent revocation; never trust JWT role metadata.
  perform 1 from private.transaction_administrators a join public.profiles p on p.id=a.user_id
    where a.user_id=v_actor and a.enabled and p.status='active' for share of a;
  if not found then raise exception 'ADMINISTRATOR_REQUIRED'; end if;
  return v_actor;
end;
$$;

create function private.require_transaction_eligible(p_transaction_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.transactions t
    join public.listings l on l.id=t.listing_id join public.profiles b on b.id=t.buyer_user_id
    where t.id=p_transaction_id and l.status='reserved' and l.moderation_status='clear'
      and b.status='active' and private.shop_is_publicly_eligible(l.shop_id)) then
    raise exception 'TRANSACTION_RESTRICTED';
  end if;
end;
$$;

create or replace function private.guard_transaction_history()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_allowed text[]; v_resolution private.transaction_resolutions%rowtype;
begin
  if tg_op='DELETE' then raise exception 'TRANSACTION_HISTORY_IMMUTABLE'; end if;
  if tg_op='INSERT' then
    if new.status <> 'reserved' or new.pickup_claimed_at is not null
      or new.administrator_resolution_id is not null then raise exception 'INVALID_TRANSACTION_STATE'; end if;
    return new;
  end if;
  if (new.id,new.listing_id,new.shop_id,new.conversation_id,new.buyer_user_id,
      new.seller_user_id,new.request_id,new.reserved_at,new.created_at)
    is distinct from (old.id,old.listing_id,old.shop_id,old.conversation_id,old.buyer_user_id,
      old.seller_user_id,old.request_id,old.reserved_at,old.created_at) then
    raise exception 'TRANSACTION_IDENTITY_IMMUTABLE';
  end if;
  if old.status='reserved' and new.status='awaiting_buyer_confirmation' then
    if new.pickup_claimed_at is null or auth.uid() is distinct from old.buyer_user_id then
      raise exception 'INVALID_TRANSACTION_STATE';
    end if;
    v_allowed := array['status','pickup_claimed_at','updated_at'];
  elsif old.status in ('reserved','awaiting_buyer_confirmation','disputed') and new.status='cancelled' then
    if new.administrator_resolution_id is null and old.status <> 'reserved' then
      raise exception 'INVALID_TRANSACTION_STATE';
    end if;
    v_allowed := array['status','cancelled_at','cancelled_by_user_id','cancellation_reason','administrator_resolution_id','updated_at'];
  elsif old.status in ('awaiting_buyer_confirmation','disputed') and new.status='completed' then
    if old.pickup_claimed_at is null then raise exception 'BUYER_CLAIM_REQUIRED'; end if;
    if new.administrator_resolution_id is null and (old.status <> 'awaiting_buyer_confirmation'
      or auth.uid() is distinct from old.seller_user_id or new.seller_confirmed_at is null) then
      raise exception 'INVALID_TRANSACTION_STATE';
    end if;
    v_allowed := array['status','seller_confirmed_at','completed_at','completed_by_user_id','administrator_resolution_id','updated_at'];
  else
    raise exception 'INVALID_TRANSACTION_STATE';
  end if;
  if (to_jsonb(new)-v_allowed) is distinct from (to_jsonb(old)-v_allowed) then
    raise exception 'TRANSACTION_IDENTITY_IMMUTABLE';
  end if;
  if new.administrator_resolution_id is not null then
    select * into v_resolution from private.transaction_resolutions where id=new.administrator_resolution_id;
    if not found or v_resolution.transaction_id <> old.id or v_resolution.outcome <> new.status::text
      or v_resolution.administrator_id is distinct from auth.uid()
      or v_resolution.administrator_id in (old.buyer_user_id,old.seller_user_id)
      or v_resolution.administrator_id is distinct from
        (case when new.status='completed' then new.completed_by_user_id else new.cancelled_by_user_id end)
      or v_resolution.resolved_at is distinct from
        (case when new.status='completed' then new.completed_at else new.cancelled_at end) then
      raise exception 'INVALID_ADMINISTRATOR_RESOLUTION';
    end if;
    perform private.require_transaction_administrator();
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create or replace function private.record_transaction_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_at timestamptz;
begin
  if tg_op='INSERT' then
    insert into public.transaction_events(transaction_id,actor_user_id,from_status,to_status,occurred_at)
      values(new.id,new.seller_user_id,null,'reserved',new.reserved_at);
    return new;
  end if;
  case new.status
    when 'awaiting_buyer_confirmation' then v_actor:=new.buyer_user_id; v_at:=new.pickup_claimed_at;
    when 'completed' then v_actor:=new.completed_by_user_id; v_at:=new.completed_at;
    when 'cancelled' then v_actor:=new.cancelled_by_user_id; v_at:=new.cancelled_at;
    else raise exception 'INVALID_TRANSACTION_STATE';
  end case;
  insert into public.transaction_events(transaction_id,actor_user_id,from_status,to_status,occurred_at,
    cancellation_reason,administrator_resolution_id)
    values(new.id,v_actor,old.status,new.status,v_at,new.cancellation_reason,new.administrator_resolution_id);
  if new.status='awaiting_buyer_confirmation' then
    insert into private.transaction_notification_outbox(transaction_id,kind,sequence_no,recipient_user_id)
      values(new.id,'pickup_claimed',0,new.seller_user_id);
  end if;
  return new;
end;
$$;

create function private.claim_pickup_impl(p_transaction_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=auth.uid(); v_t public.transactions%rowtype;
begin
  if v_actor is null then raise exception 'UNAUTHENTICATED'; end if;
  select * into v_t from public.transactions where id=p_transaction_id and buyer_user_id=v_actor;
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;
  perform 1 from public.listings where id=v_t.listing_id for update;
  select * into v_t from public.transactions where id=p_transaction_id for update;
  if v_t.pickup_claimed_at is not null then return v_t.id; end if; -- original receipt only
  if v_t.status <> 'reserved' then raise exception 'INVALID_TRANSACTION_STATE'; end if;
  perform private.require_transaction_eligible(v_t.id);
  update public.transactions set status='awaiting_buyer_confirmation',pickup_claimed_at=clock_timestamp()
    where id=v_t.id;
  return v_t.id;
end;
$$;

create function private.confirm_pickup_claim_impl(p_transaction_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=auth.uid(); v_t public.transactions%rowtype; v_now timestamptz;
begin
  if v_actor is null then raise exception 'UNAUTHENTICATED'; end if;
  select * into v_t from public.transactions where id=p_transaction_id and seller_user_id=v_actor;
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;
  perform 1 from public.listings where id=v_t.listing_id for update;
  select * into v_t from public.transactions where id=p_transaction_id for update;
  if v_t.status='completed' and v_t.seller_confirmed_at is not null then return v_t.id; end if;
  if v_t.status <> 'awaiting_buyer_confirmation' or v_t.pickup_claimed_at is null then
    raise exception 'BUYER_CLAIM_REQUIRED';
  end if;
  perform private.require_transaction_eligible(v_t.id);
  v_now:=clock_timestamp();
  update public.transactions set status='completed',seller_confirmed_at=v_now,completed_at=v_now,
    completed_by_user_id=v_actor where id=v_t.id;
  update public.listings set status='sold' where id=v_t.listing_id;
  return v_t.id;
end;
$$;

create function private.resolve_transaction_impl(p_transaction_id uuid,p_request_id uuid,p_outcome text,
  p_reason text,p_evidence_references jsonb,p_review_findings text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_t public.transactions%rowtype; v_r private.transaction_resolutions%rowtype;
begin
  v_actor:=private.require_transaction_administrator();
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  if p_outcome is null or p_outcome not in ('completed','cancelled') then raise exception 'INVALID_RESOLUTION_OUTCOME'; end if;
  if p_reason is null or length(p_reason)>1000
    or length(regexp_replace(p_reason,'[[:space:]]','','g'))<10 then raise exception 'RESOLUTION_REASON_REQUIRED'; end if;
  if p_review_findings is null or length(p_review_findings)>4000
    or length(regexp_replace(p_review_findings,'[[:space:]]','','g'))<20
    or p_evidence_references is null or not private.valid_resolution_evidence(p_evidence_references) then
    raise exception 'EVIDENCE_REVIEW_REQUIRED';
  end if;
  select * into v_t from public.transactions where id=p_transaction_id;
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;
  if v_actor in (v_t.buyer_user_id,v_t.seller_user_id) then raise exception 'ADMINISTRATOR_CONFLICT_OF_INTEREST'; end if;
  perform 1 from public.listings where id=v_t.listing_id for update;
  select * into v_t from public.transactions where id=p_transaction_id for update;
  select * into v_r from private.transaction_resolutions where administrator_id=v_actor and request_id=p_request_id;
  if found then
    if v_r.transaction_id<>p_transaction_id or v_r.outcome<>p_outcome
      or v_r.reason<>btrim(p_reason) or v_r.evidence_references<>p_evidence_references
      or v_r.review_findings<>btrim(p_review_findings) then raise exception 'RESOLUTION_REQUEST_CONFLICT'; end if;
    return v_t.id;
  end if;
  if v_t.status not in ('reserved','awaiting_buyer_confirmation','disputed') then raise exception 'INVALID_TRANSACTION_STATE'; end if;
  if p_outcome='completed' and v_t.pickup_claimed_at is null then raise exception 'BUYER_CLAIM_REQUIRED'; end if;
  -- Cancellation cannot reactivate an ineligible Listing, even for an admin.
  perform private.require_transaction_eligible(v_t.id);
  insert into private.transaction_resolutions(transaction_id,administrator_id,request_id,outcome,reason,evidence_references,review_findings)
    values(v_t.id,v_actor,p_request_id,p_outcome,btrim(p_reason),p_evidence_references,btrim(p_review_findings))
    on conflict (administrator_id,request_id) do nothing returning * into v_r;
  if not found then raise exception 'RESOLUTION_REQUEST_CONFLICT'; end if;
  if p_outcome='completed' then
    update public.transactions set status='completed',completed_at=v_r.resolved_at,
      completed_by_user_id=v_actor,administrator_resolution_id=v_r.id where id=v_t.id;
    update public.listings set status='sold' where id=v_t.listing_id;
  else
    update public.transactions set status='cancelled',cancelled_at=v_r.resolved_at,
      cancelled_by_user_id=v_actor,cancellation_reason=null,administrator_resolution_id=v_r.id where id=v_t.id;
    update public.listings set status='active' where id=v_t.listing_id;
  end if;
  return v_t.id;
end;
$$;

-- Explicit trusted-operator job only. NULL configuration disables each timer.
-- Reminders/escalations append notification intents; never change lifecycle.
create function private.enqueue_transaction_followups(p_now timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path = '' as $$
declare v_t public.transactions%rowtype; v_p private.transaction_notification_policy%rowtype;
  v_latest timestamptz; v_sequence integer; v_count integer:=0; v_added integer;
begin
  if p_now is null then raise exception 'TIME_REQUIRED'; end if;
  select * into strict v_p from private.transaction_notification_policy where singleton;
  for v_t in select * from public.transactions where status='awaiting_buyer_confirmation'
    order by id for update skip locked loop
    if v_p.reminder_interval is not null then
      select max(created_at),coalesce(max(sequence_no),0)+1 into v_latest,v_sequence
        from private.transaction_notification_outbox where transaction_id=v_t.id and kind='confirmation_reminder';
      if p_now >= coalesce(v_latest,v_t.pickup_claimed_at)+v_p.reminder_interval then
        insert into private.transaction_notification_outbox(transaction_id,kind,sequence_no,recipient_user_id,created_at)
          values(v_t.id,'confirmation_reminder',v_sequence,v_t.seller_user_id,p_now);
        v_count:=v_count+1;
      end if;
    end if;
    if v_p.escalation_after is not null and p_now>=v_t.pickup_claimed_at+v_p.escalation_after then
      insert into private.transaction_notification_outbox(transaction_id,kind,sequence_no,created_at)
        values(v_t.id,'administrator_escalation',0,p_now) on conflict do nothing;
      get diagnostics v_added = row_count; v_count:=v_count+v_added;
    end if;
  end loop;
  return v_count;
end;
$$;

create function public.claim_pickup(p_transaction_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select private.claim_pickup_impl(p_transaction_id);
$$;
create function public.confirm_pickup_claim(p_transaction_id uuid)
returns uuid language sql security invoker set search_path = '' as $$
  select private.confirm_pickup_claim_impl(p_transaction_id);
$$;
create function public.resolve_transaction(p_transaction_id uuid,p_request_id uuid,p_outcome text,
  p_reason text,p_evidence_references jsonb,p_review_findings text)
returns uuid language sql security invoker set search_path = '' as $$
  select private.resolve_transaction_impl(p_transaction_id,p_request_id,p_outcome,p_reason,p_evidence_references,p_review_findings);
$$;

revoke all on function private.require_transaction_administrator(),private.require_transaction_eligible(uuid),
  private.enqueue_transaction_followups(timestamptz),private.claim_pickup_impl(uuid),
  private.confirm_pickup_claim_impl(uuid),private.resolve_transaction_impl(uuid,uuid,text,text,jsonb,text),
  public.claim_pickup(uuid),public.confirm_pickup_claim(uuid),public.resolve_transaction(uuid,uuid,text,text,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function private.claim_pickup_impl(uuid),private.confirm_pickup_claim_impl(uuid),
  private.resolve_transaction_impl(uuid,uuid,text,text,jsonb,text),public.claim_pickup(uuid),
  public.confirm_pickup_claim(uuid),public.resolve_transaction(uuid,uuid,text,text,jsonb,text) to authenticated;
-- Guard/event function ACLs and participant table RLS are preserved by CREATE OR REPLACE.
