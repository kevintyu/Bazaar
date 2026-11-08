-- Marketplace / Migration 002: Listings + Inventory
-- Depends on Migration 001: public.profiles, locations, shops and their enums.
-- Intended for a clean, Supabase-managed PostgreSQL environment.
-- REVIEW against existing migrations before applying. The accompanying
-- README documents intentionally deferred policy enforcement.

-- 1. Listing types ---------------------------------------------------------
create type public.listing_status as enum (
  'draft', 'active', 'reserved', 'sold', 'removed'
);
create type public.listing_moderation_status as enum (
  'clear', 'under_review'
);
create type public.listing_condition as enum (
  'new', 'like_new', 'good', 'fair', 'poor'
);
create type public.listing_removal_reason as enum (
  'sold_elsewhere', 'no_longer_selling', 'item_lost_or_damaged',
  'duplicate_or_mistake', 'wants_to_change_listing', 'other'
);

-- 2. Listings --------------------------------------------------------------
alter table public.shops add constraint shops_id_owner_unique unique (id, owner_user_id);
-- Drafts intentionally permit NULL content; publication requires completeness.
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  -- Enforcement copy only: Listings still belong to Shops.
  owner_user_id uuid not null,
  constraint listings_shop_owner_fk foreign key (shop_id, owner_user_id)
    references public.shops(id, owner_user_id) on delete restrict,
  title text,
  description text,
  asking_price numeric(12,2),
  currency varchar(3),
  category_key text,
  condition public.listing_condition,
  status public.listing_status not null default 'draft',
  moderation_status public.listing_moderation_status not null default 'clear',
  location_override_id uuid,
  constraint listings_location_owner_fk foreign key (location_override_id, owner_user_id)
    references public.locations(id, owner_user_id) on delete restrict,
  removal_reason public.listing_removal_reason,
  removal_details text,
  published_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listings_valid_title check (
    title is null or (length(btrim(title)) between 1 and 120)
  ),
  constraint listings_valid_description check (
    description is null or length(description) <= 5000
  ),
  constraint listings_valid_price check (
    asking_price is null or (asking_price >= 0 and asking_price <> 'NaN'::numeric)
  ),
  constraint listings_valid_currency check (
    currency is null or currency ~ '^[A-Z]{3}$'
  ),
  constraint listings_valid_category check (
    category_key is null or length(btrim(category_key)) between 1 and 80
  ),
  constraint listings_publication_timestamp check (
    status = 'draft' or published_at is not null
  ),
  constraint listings_active_content check (
    status <> 'active' or (title is not null and asking_price is not null
      and currency is not null and category_key is not null and condition is not null)
  ),
  constraint listings_removal_details_length check (length(removal_details) <= 500),
  constraint listings_removed_metadata check (
    status <> 'removed' or (removed_at is not null and removal_reason is not null)
  )
);

create index listings_shop_idx on public.listings(shop_id);
create index listings_effective_location_override_idx on public.listings(location_override_id)
  where location_override_id is not null;
create index listings_public_feed_idx
  on public.listings (published_at desc, id desc)
  where status = 'active' and moderation_status = 'clear';

-- Existing Migration 001 created public.set_updated_at().
create trigger listings_set_updated_at
before update on public.listings
for each row execute function public.set_updated_at();

-- 3. Listing images --------------------------------------------------------
-- Only a private Storage bucket is used; storage_path is a bucket-relative path.
create table public.listing_images (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete restrict,
  storage_path text not null unique,
  alt_text text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint listing_images_valid_order check (sort_order >= 0),
  constraint listing_images_path_for_listing check (
    storage_path ~ (
      '^' || listing_id::text ||
      '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$'
    )
  ),
  constraint listing_images_one_position unique (listing_id, sort_order)
);
create index listing_images_listing_idx on public.listing_images(listing_id);

-- 4. Non-exposed private schema ------------------------------------------
-- Ensure 'private' is NOT in Supabase's exposed Data API schemas.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

-- 5. Private bucket --------------------------------------------------------
-- Never flip this bucket to public: draft images must remain private.
-- 10 MiB per image; fail on an existing bucket rather than overwrite its configuration.
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'listing-images', 'listing-images', false, 10485760,
  array['image/jpeg','image/png','image/webp']::text[]
);

-- Path convention: {listing_uuid}/{image_uuid}.{jpg|jpeg|png|webp}
-- Reject malformed paths BEFORE casting segments to uuid.
create function private.listing_id_from_media_path(p_path text)
returns uuid
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$'
    then split_part(p_path, '/', 1)::uuid
    else null::uuid
  end;
$$;
revoke all on function private.listing_id_from_media_path(text)
  from public, anon, authenticated;

-- Serialize Storage mutations with attach/detach/publish/discard on the parent.
-- No caller-supplied actor; unreferenced objects alone may be deleted.
create function private.can_write_listing_media(p_path text, p_deleting boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_l public.listings%rowtype;
begin
  select l.* into v_l from public.listings l
  where l.id = private.listing_id_from_media_path(p_path) for update;
  if not found or v_l.owner_user_id is distinct from auth.uid()
     or v_l.status not in ('draft','active') then return false; end if;
  if not exists (
    select 1 from public.shops s join public.profiles p on p.id = s.owner_user_id
    where s.id = v_l.shop_id and s.status = 'active'
      and p.status = 'active' and p.selling_enabled
  ) then return false; end if;
  if p_deleting and exists (
    select 1 from public.listing_images where storage_path = p_path
  ) then return false; end if;
  return true;
end;
$$;
revoke all on function private.can_write_listing_media(text,boolean) from public,anon,authenticated;
grant execute on function private.can_write_listing_media(text,boolean) to authenticated;

create function private.can_owner_read_listing_media(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.listings l
    join public.shops s on s.id = l.shop_id
    where l.id = private.listing_id_from_media_path(p_path)
      and s.owner_user_id = auth.uid()
  );
$$;
revoke all on function private.can_owner_read_listing_media(text)
  from public, anon, authenticated;
grant execute on function private.can_owner_read_listing_media(text)
  to authenticated;

-- Storage object RLS: private images remain invisible to other users.
create policy listing_media_owner_upload
on storage.objects for insert to authenticated
with check (
  bucket_id = 'listing-images'
  and private.can_write_listing_media(name, false)
);

create policy listing_media_owner_read
on storage.objects for select to authenticated
using (
  bucket_id = 'listing-images'
  and private.can_owner_read_listing_media(name)
);

create policy listing_media_owner_delete_unattached
on storage.objects for delete to authenticated
using (
  bucket_id = 'listing-images'
  and private.can_write_listing_media(name, true)
);
-- No UPDATE policy: overwriting published images is not supported.

-- 6. Listing permissions ---------------------------------------------------
alter table public.listings enable row level security;
alter table public.listing_images enable row level security;

-- Owner may see all of their Listings, including drafts and removed ones.
create policy listings_owner_read
on public.listings for select to authenticated
using (
  exists (
    select 1 from public.shops s
    where s.id = shop_id and s.owner_user_id = (select auth.uid())
  )
);

-- Only DRAFT and ACTIVE content fields can be edited directly; state fields
-- have no UPDATE grant and are changed only by domain RPCs.
create policy listings_owner_edit_content
on public.listings for update to authenticated
using (
  status in ('draft','active')
  and exists (
    select 1 from public.shops s
    where s.id = shop_id and s.owner_user_id = (select auth.uid())
  )
)
with check (
  status in ('draft','active')
  and exists (
    select 1 from public.shops s
    where s.id = shop_id and s.owner_user_id = (select auth.uid())
  )
);

create policy listing_images_owner_read
on public.listing_images for select to authenticated
using (
  exists (
    select 1 from public.listings l
    join public.shops s on s.id = l.shop_id
    where l.id = listing_id and s.owner_user_id = (select auth.uid())
  )
);

-- Do not expose raw Listing rows (including location_override_id) publicly.
-- Public browsing uses sanitized RPC results defined later in this migration.
revoke all on public.listings from public, anon, authenticated;
revoke all on public.listing_images from public, anon, authenticated;

grant select on public.listings to authenticated;
grant update (
  title, description, asking_price, currency, category_key, condition,
  location_override_id
) on public.listings to authenticated;
grant select on public.listing_images to authenticated;

-- 7. Seller operations: definer code lives outside exposed API schema ------
create function private.create_listing(
  p_shop_id uuid, p_title text default null, p_asking_price numeric default null,
  p_currency text default null, p_description text default null,
  p_category_key text default null, p_condition public.listing_condition default null,
  p_location_override_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_shop public.shops%rowtype;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;
  if p_shop_id is null then
    raise exception 'SHOP_REQUIRED' using errcode = 'P0001';
  end if;

  select s.* into v_shop
  from public.shops s
  where s.id = p_shop_id and s.owner_user_id = v_actor;
  if not found then
    raise exception 'SHOP_NOT_OWNED' using errcode = 'P0001';
  end if;

  select p.* into v_profile from public.profiles p where p.id = v_actor;
  if v_profile.status <> 'active' or not v_profile.selling_enabled
     or v_shop.status <> 'active' then
    raise exception 'SELLING_NOT_ALLOWED' using errcode = 'P0001';
  end if;

  insert into public.listings (
    shop_id, owner_user_id, title, asking_price, currency, description,
    category_key, condition, location_override_id
  ) values (
    p_shop_id, v_actor, nullif(btrim(p_title), ''), p_asking_price,
    upper(nullif(btrim(p_currency), '')), p_description,
    nullif(btrim(p_category_key), ''), p_condition, p_location_override_id
  )
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function private.create_listing(uuid,text,numeric,text,text,text,public.listing_condition,uuid) from public,anon,authenticated;
grant execute on function private.create_listing(uuid,text,numeric,text,text,text,public.listing_condition,uuid) to authenticated;

create function public.create_listing(
  p_shop_id uuid, p_title text default null, p_asking_price numeric default null,
  p_currency text default null, p_description text default null,
  p_category_key text default null, p_condition public.listing_condition default null,
  p_location_override_id uuid default null
)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.create_listing(p_shop_id, p_title, p_asking_price, p_currency,
  p_description, p_category_key, p_condition, p_location_override_id); $$;
revoke all on function public.create_listing(uuid,text,numeric,text,text,text,public.listing_condition,uuid) from public,anon,authenticated;
grant execute on function public.create_listing(uuid,text,numeric,text,text,text,public.listing_condition,uuid) to authenticated;

-- Image commands lock the same parent as publication and Storage mutations.
create function private.attach_listing_image(
  p_listing_id uuid, p_image_id uuid, p_extension text, p_alt_text text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_l public.listings%rowtype;
  v_path text;
  v_order integer;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;
  select * into v_l from public.listings where id = p_listing_id for update;
  if not found then raise exception 'LISTING_NOT_FOUND'; end if;
  if v_l.owner_user_id is distinct from auth.uid() then
    raise exception 'LISTING_NOT_OWNED';
  end if;
  if v_l.status not in ('draft','active') then raise exception 'INVALID_LISTING_STATE'; end if;
  if not exists (
    select 1 from public.shops s join public.profiles p on p.id = s.owner_user_id
    where s.id = v_l.shop_id and s.status = 'active'
      and p.status = 'active' and p.selling_enabled
  ) then raise exception 'SELLING_NOT_ALLOWED'; end if;
  if p_image_id is null or p_extension is null or p_extension not in ('jpg','jpeg','png','webp') then
    raise exception 'INVALID_IMAGE_PATH';
  end if;
  v_path := p_listing_id::text || '/' || p_image_id::text || '.' || p_extension;
  perform 1 from storage.objects
    where bucket_id = 'listing-images' and name = v_path
      and owner_id = auth.uid()::text for update;
  if not found then raise exception 'IMAGE_MISSING_OR_NOT_OWNED'; end if;
  select coalesce(max(sort_order), -1) + 1 into v_order
    from public.listing_images where listing_id = p_listing_id;
  insert into public.listing_images(id, listing_id, storage_path, alt_text, sort_order)
    values (p_image_id, p_listing_id, v_path, p_alt_text, v_order);
  return p_image_id;
end;
$$;
revoke all on function private.attach_listing_image(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function private.attach_listing_image(uuid,uuid,text,text) to authenticated;

create function public.attach_listing_image(
  p_listing_id uuid, p_image_id uuid, p_extension text, p_alt_text text default null
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.attach_listing_image(p_listing_id,p_image_id,p_extension,p_alt_text); $$;
revoke all on function public.attach_listing_image(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.attach_listing_image(uuid,uuid,text,text) to authenticated;

create function private.detach_listing_image(p_image_id uuid)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v_l public.listings%rowtype;
  v_image public.listing_images%rowtype;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select l.* into v_l from public.listings l
    join public.listing_images i on i.listing_id = l.id
    where i.id = p_image_id for update of l;
  if not found then raise exception 'IMAGE_NOT_FOUND'; end if;
  if v_l.owner_user_id is distinct from auth.uid() then raise exception 'LISTING_NOT_OWNED'; end if;
  if v_l.status not in ('draft','active') then raise exception 'INVALID_LISTING_STATE'; end if;
  if not exists (
    select 1 from public.shops s join public.profiles p on p.id = s.owner_user_id
    where s.id = v_l.shop_id and s.status = 'active'
      and p.status = 'active' and p.selling_enabled
  ) then raise exception 'SELLING_NOT_ALLOWED'; end if;
  select * into v_image from public.listing_images where id = p_image_id;
  if not found then raise exception 'IMAGE_NOT_FOUND'; end if;
  if v_l.status = 'active' and
    (select count(*) from public.listing_images where listing_id = v_l.id) <= 1 then
    raise exception 'LAST_ACTIVE_IMAGE_REQUIRED';
  end if;
  delete from public.listing_images where id = p_image_id;
  return v_image.storage_path;
end;
$$;
revoke all on function private.detach_listing_image(uuid) from public,anon,authenticated;
grant execute on function private.detach_listing_image(uuid) to authenticated;

create function public.detach_listing_image(p_image_id uuid)
returns text language sql security invoker set search_path = ''
as $$ select private.detach_listing_image(p_image_id); $$;
revoke all on function public.detach_listing_image(uuid) from public,anon,authenticated;
grant execute on function public.detach_listing_image(uuid) to authenticated;

create function private.discard_draft_listing(p_listing_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_l public.listings%rowtype;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select * into v_l from public.listings where id = p_listing_id for update;
  if not found then raise exception 'LISTING_NOT_FOUND'; end if;
  if v_l.owner_user_id is distinct from auth.uid() then raise exception 'LISTING_NOT_OWNED'; end if;
  if v_l.status <> 'draft' then raise exception 'INVALID_LISTING_STATE'; end if;
  if exists (select 1 from public.listing_images where listing_id = p_listing_id)
    or exists (select 1 from storage.objects where bucket_id = 'listing-images'
      and split_part(name,'/',1) = p_listing_id::text) then
    raise exception 'LISTING_IMAGES_REQUIRE_CLEANUP';
  end if;
  delete from public.listings where id = p_listing_id;
  return p_listing_id;
end;
$$;
revoke all on function private.discard_draft_listing(uuid) from public,anon,authenticated;
grant execute on function private.discard_draft_listing(uuid) to authenticated;

create function public.discard_draft_listing(p_listing_id uuid)
returns uuid language sql security invoker set search_path = ''
as $$ select private.discard_draft_listing(p_listing_id); $$;
revoke all on function public.discard_draft_listing(uuid) from public,anon,authenticated;
grant execute on function public.discard_draft_listing(uuid) to authenticated;

create function private.publish_listing(p_listing_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_l public.listings%rowtype;
  v_s public.shops%rowtype;
  v_p public.profiles%rowtype;
begin
  if v_actor is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select l.* into v_l from public.listings l
  where l.id = p_listing_id for update;
  if not found then
    raise exception 'LISTING_NOT_FOUND' using errcode = 'P0001';
  end if;
  select s.* into v_s from public.shops s where s.id = v_l.shop_id;
  if v_s.owner_user_id is distinct from v_actor then
    raise exception 'LISTING_NOT_OWNED' using errcode = 'P0001';
  end if;
  select p.* into v_p from public.profiles p where p.id = v_actor;
  if v_p.status <> 'active' or not v_p.selling_enabled
     or v_s.status <> 'active' then
    raise exception 'SELLING_NOT_ALLOWED' using errcode = 'P0001';
  end if;
  if v_l.status <> 'draft' or v_l.moderation_status <> 'clear' then
    raise exception 'INVALID_LISTING_STATE' using errcode = 'P0001';
  end if;
  if v_l.title is null or length(btrim(v_l.title)) = 0
     or v_l.asking_price is null or v_l.currency is null
     or v_l.category_key is null or length(btrim(v_l.category_key)) = 0
     or v_l.condition is null then
    raise exception 'LISTING_INCOMPLETE' using errcode = 'P0001';
  end if;
  if coalesce(v_l.location_override_id, v_s.default_location_id) is null then
    raise exception 'LOCATION_REQUIRED' using errcode = 'P0001';
  end if;

  -- A metadata row alone is insufficient: every referenced object must exist.
  if not exists (
    select 1 from public.listing_images li where li.listing_id = v_l.id
  ) then
    raise exception 'IMAGE_REQUIRED' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.listing_images li
    where li.listing_id = v_l.id
      and not exists (
        select 1 from storage.objects o
        where o.bucket_id = 'listing-images'
          and o.name = li.storage_path
      )
  ) then
    raise exception 'IMAGE_MISSING_STORAGE_OBJECT' using errcode = 'P0001';
  end if;

  -- NOTE: jurisdiction-specific prohibited-item policy engine is deferred.
  -- Do NOT launch this publicly until policy enforcement is implemented.
  update public.listings
    set status = 'active', published_at = now()
    where id = v_l.id;

  return v_l.id;
end;
$$;
revoke all on function private.publish_listing(uuid) from public,anon,authenticated;
grant execute on function private.publish_listing(uuid) to authenticated;

create function public.publish_listing(p_listing_id uuid)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.publish_listing(p_listing_id); $$;
revoke all on function public.publish_listing(uuid) from public,anon,authenticated;
grant execute on function public.publish_listing(uuid) to authenticated;

create function private.remove_listing(
  p_listing_id uuid,
  p_reason public.listing_removal_reason,
  p_details text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_l public.listings%rowtype;
  v_owner uuid;
begin
  if v_actor is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;
  if p_reason is null then
    raise exception 'REMOVAL_REASON_REQUIRED' using errcode = 'P0001';
  end if;
  select l.* into v_l from public.listings l
  where l.id = p_listing_id for update;
  if not found then
    raise exception 'LISTING_NOT_FOUND' using errcode = 'P0001';
  end if;
  select s.owner_user_id into v_owner
  from public.shops s where s.id = v_l.shop_id;
  if v_owner is distinct from v_actor then
    raise exception 'LISTING_NOT_OWNED' using errcode = 'P0001';
  end if;
  if v_l.status <> 'active' then
    raise exception 'INVALID_LISTING_STATE' using errcode = 'P0001';
  end if;
  if p_details is not null and length(p_details) > 500 then
    raise exception 'REMOVAL_DETAILS_TOO_LONG' using errcode = 'P0001';
  end if;
  update public.listings
    set status = 'removed', removal_reason = p_reason,
        removal_details = nullif(btrim(p_details), ''), removed_at = now()
    where id = p_listing_id;
  return p_listing_id;
end;
$$;
revoke all on function private.remove_listing(uuid, public.listing_removal_reason, text)
  from public,anon,authenticated;
grant execute on function private.remove_listing(uuid, public.listing_removal_reason, text)
  to authenticated;

create function public.remove_listing(
  p_listing_id uuid,
  p_reason public.listing_removal_reason,
  p_details text default null
)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.remove_listing(p_listing_id, p_reason, p_details); $$;
revoke all on function public.remove_listing(uuid, public.listing_removal_reason, text)
  from public,anon,authenticated;
grant execute on function public.remove_listing(uuid, public.listing_removal_reason, text)
  to authenticated;

-- 8. Public-safe read API --------------------------------------------------
-- Exact address is returned ONLY if owner explicitly selects 'exact'.
-- Neighborhood currently falls back to city because Migration 001 does not
-- store a separate neighborhood field. No raw coordinates are ever returned.
create function private.public_location_label(p_location_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case loc.public_precision
    when 'exact' then coalesce(
      nullif(btrim(loc.formatted_address), ''),
      concat_ws(', ', loc.locality, loc.administrative_area, loc.country_code)
    )
    when 'general_area' then
      concat_ws(', ', loc.administrative_area, loc.country_code)
    else concat_ws(', ', loc.locality, loc.administrative_area, loc.country_code)
  end
  from public.locations loc where loc.id = p_location_id;
$$;
revoke all on function private.public_location_label(uuid) from public,anon,authenticated;

create function private.public_listing_json(p_listing_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', l.id,
    'title', l.title,
    'description', l.description,
    'askingPrice', l.asking_price,
    'currency', l.currency,
    'categoryKey', l.category_key,
    'condition', l.condition,
    'status', l.status,
    'publishedAt', l.published_at,
    'publicLocation', private.public_location_label(
      coalesce(l.location_override_id, s.default_location_id)
    ),
    'shop', jsonb_build_object(
      'id', s.id,
      'displayName', s.display_name,
      'profileImageUrl', s.profile_image_url
    ),
    'images', coalesce((
      select jsonb_agg(
        jsonb_build_object('storagePath', li.storage_path, 'altText', li.alt_text)
        order by li.sort_order, li.id
      )
      from public.listing_images li where li.listing_id = l.id
    ), '[]'::jsonb)
  )
  from public.listings l
  join public.shops s on s.id = l.shop_id
  join public.profiles p on p.id = s.owner_user_id
  where l.id = p_listing_id
    and l.status = 'active'
    and l.moderation_status = 'clear'
    and s.status = 'active'
    and p.status = 'active';
$$;
revoke all on function private.public_listing_json(uuid) from public,anon,authenticated;
grant execute on function private.public_listing_json(uuid) to anon, authenticated;

create function public.get_public_listing(p_listing_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.public_listing_json(p_listing_id); $$;
revoke all on function public.get_public_listing(uuid) from public,anon,authenticated;
grant execute on function public.get_public_listing(uuid) to anon, authenticated;

create function private.browse_public_listings(
  p_limit integer default 20,
  p_before_published_at timestamptz default null,
  p_before_id uuid default null
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (p_before_published_at is null) <> (p_before_id is null) then
    raise exception 'INVALID_CURSOR' using errcode = 'P0001';
  end if;
  return query
    select private.public_listing_json(l.id)
    from public.listings l
    join public.shops s on s.id = l.shop_id
    join public.profiles p on p.id = s.owner_user_id
    where l.status = 'active'
      and l.moderation_status = 'clear'
      and s.status = 'active'
      and p.status = 'active'
      and (
        p_before_published_at is null
        or (l.published_at, l.id) < (p_before_published_at, p_before_id)
      )
    order by l.published_at desc, l.id desc
    limit least(greatest(coalesce(p_limit,20),1),50);
end;
$$;
revoke all on function private.browse_public_listings(integer,timestamptz,uuid)
  from public,anon,authenticated;
grant execute on function private.browse_public_listings(integer,timestamptz,uuid)
  to anon, authenticated;

create function public.browse_public_listings(
  p_limit integer default 20,
  p_before_published_at timestamptz default null,
  p_before_id uuid default null
)
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.browse_public_listings(
    p_limit, p_before_published_at, p_before_id
  );
$$;
revoke all on function public.browse_public_listings(integer,timestamptz,uuid)
  from public,anon,authenticated;
grant execute on function public.browse_public_listings(integer,timestamptz,uuid)
  to anon, authenticated;

-- End Migration 002.
