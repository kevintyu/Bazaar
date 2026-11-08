-- ============================================================
-- Marketplace
-- Migration 001: Accounts, Locations, Shops
--
-- Creates:
--   - required extensions
--   - account/shop enums
--   - profiles
--   - locations
--   - shops
--   - updated_at triggers
--   - automatic profile creation
--   - activate_selling() domain operation
--   - initial RLS policies
-- ============================================================


-- ============================================================
-- 1. EXTENSIONS
-- ============================================================

create schema if not exists extensions;

-- Existing PostGIS installations are not relocated by IF NOT EXISTS.
-- Fail explicitly rather than silently binding to an unexpected schema.
do $$
begin
    if exists (
        select 1
        from pg_catalog.pg_extension e
        join pg_catalog.pg_namespace n on n.oid = e.extnamespace
        where e.extname = 'postgis' and n.nspname <> 'extensions'
    ) then
        raise exception 'PostGIS must be installed in the extensions schema; review the existing installation before applying this migration';
    end if;
end;
$$;

create extension if not exists postgis
with schema extensions;


-- ============================================================
-- 2. ENUMS
-- ============================================================

create type public.account_status as enum (
    'active',
    'suspended',
    'banned'
);

create type public.shop_status as enum (
    'active',
    'suspended',
    'closed'
);

create type public.location_precision as enum (
    'exact',
    'neighborhood',
    'city',
    'general_area'
);


-- ============================================================
-- 3. PROFILES
-- ============================================================

create table public.profiles (
    id uuid primary key
        references auth.users(id)
        on delete restrict,

    display_name text not null,

    avatar_url text,

    selling_enabled boolean not null default false,

    status public.account_status
        not null
        default 'active',

    created_at timestamptz
        not null
        default now(),

    updated_at timestamptz
        not null
        default now(),

    constraint profiles_display_name_not_blank
        check (length(trim(display_name)) > 0)
);


-- ============================================================
-- 4. LOCATIONS
-- ============================================================

create table public.locations (
    id uuid primary key
        default gen_random_uuid(),

    owner_user_id uuid not null
        references public.profiles(id)
        on delete restrict,

    country_code varchar(2) not null,

    administrative_area text,

    locality text,

    postal_code text,

    -- Private / potentially precise representation.
    -- Do not expose this directly through public marketplace reads.
    formatted_address text,

    -- Exact coordinates where available.
    coordinates extensions.geography(Point, 4326),

    public_precision public.location_precision
        not null
        default 'neighborhood',

    created_at timestamptz
        not null
        default now(),

    updated_at timestamptz
        not null
        default now(),

    constraint locations_country_code_length
        check (char_length(country_code) = 2),

    constraint locations_country_code_uppercase
        check (country_code ~ '^[A-Z]{2}$'),

    -- Supports the composite FK from shops so a Shop cannot
    -- reference another User's Location.
    constraint locations_id_owner_unique
        unique (id, owner_user_id)
);


create index locations_coordinates_idx
on public.locations
using gist (coordinates);

create index locations_owner_user_idx
on public.locations (owner_user_id);


-- ============================================================
-- 5. SHOPS
-- ============================================================

create table public.shops (
    id uuid primary key
        default gen_random_uuid(),

    owner_user_id uuid not null
        references public.profiles(id)
        on delete restrict,

    display_name text not null,

    description text,

    profile_image_url text,

    banner_image_url text,

    default_location_id uuid not null,

    status public.shop_status
        not null
        default 'active',

    created_at timestamptz
        not null
        default now(),

    updated_at timestamptz
        not null
        default now(),

    constraint shops_display_name_not_blank
        check (length(trim(display_name)) > 0),

    constraint shops_default_location_owner_fk
        foreign key (
            default_location_id,
            owner_user_id
        )
        references public.locations (
            id,
            owner_user_id
        )
        on delete restrict
);


create index shops_owner_user_idx
on public.shops (owner_user_id);

create index shops_status_idx
on public.shops (status);


-- Intentionally NO unique(owner_user_id).
-- The data model supports multiple Shops per User even though
-- the initial product includes only one Shop.


-- ============================================================
-- 6. UPDATED_AT HANDLING
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;


create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();


create trigger locations_set_updated_at
before update on public.locations
for each row
execute function public.set_updated_at();


create trigger shops_set_updated_at
before update on public.shops
for each row
execute function public.set_updated_at();


revoke execute
on function public.set_updated_at()
from public, anon, authenticated;


-- ============================================================
-- 7. AUTOMATIC PROFILE CREATION
-- ============================================================

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_display_name text;
begin

    v_display_name :=
        nullif(
            trim(new.raw_user_meta_data ->> 'display_name'),
            ''
        );

    if v_display_name is null
       and new.email is not null then

        v_display_name :=
            nullif(
                trim(split_part(new.email, '@', 1)),
                ''
            );

    end if;

    if v_display_name is null then
        v_display_name := 'User';
    end if;


    insert into public.profiles (
        id,
        display_name
    )
    values (
        new.id,
        v_display_name
    );

    return new;

end;
$$;


create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_auth_user();


revoke execute
on function public.handle_new_auth_user()
from public, anon, authenticated;


-- The insert trigger only handles future users. Populate existing users too.
insert into public.profiles (id, display_name)
select
    id,
    coalesce(
        nullif(trim(raw_user_meta_data ->> 'display_name'), ''),
        nullif(trim(split_part(email, '@', 1)), ''),
        'User'
    )
from auth.users
on conflict (id) do nothing;


-- ============================================================
-- 8. SELLER ACTIVATION DOMAIN OPERATION
-- ============================================================

create or replace function public.activate_selling(
    p_shop_name text,
    p_shop_description text default null,

    p_country_code varchar default null,
    p_administrative_area text default null,
    p_locality text default null,
    p_postal_code text default null,
    p_formatted_address text default null,

    p_latitude double precision default null,
    p_longitude double precision default null,

    p_public_precision public.location_precision
        default 'neighborhood'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid;
    v_profile public.profiles%rowtype;
    v_location_id uuid;
    v_shop_id uuid;
    v_coordinates extensions.geography(Point, 4326);
begin

    -- Authentication
    v_user_id := auth.uid();

    if v_user_id is null then
        raise exception 'UNAUTHENTICATED'
            using errcode = 'P0001';
    end if;


    -- Validate Shop name
    if p_shop_name is null
       or length(trim(p_shop_name)) = 0 then

        raise exception 'SHOP_NAME_REQUIRED'
            using errcode = 'P0001';

    end if;


    -- Validate country
    if p_country_code is null
       or upper(trim(p_country_code)) !~ '^[A-Z]{2}$' then

        raise exception 'INVALID_COUNTRY_CODE'
            using errcode = 'P0001';

    end if;


    if p_public_precision is null then
        raise exception 'INVALID_LOCATION'
            using errcode = 'P0001';
    end if;

    -- Coordinates must be supplied together or omitted together.
    if
        (
            p_latitude is null
            and p_longitude is not null
        )
        or
        (
            p_latitude is not null
            and p_longitude is null
        )
    then

        raise exception 'INVALID_COORDINATES'
            using errcode = 'P0001';

    end if;


    if p_latitude is not null then

        if p_latitude < -90
           or p_latitude > 90 then

            raise exception 'INVALID_LATITUDE'
                using errcode = 'P0001';

        end if;


        if p_longitude < -180
           or p_longitude > 180 then

            raise exception 'INVALID_LONGITUDE'
                using errcode = 'P0001';

        end if;


        v_coordinates :=
            extensions.st_setsrid(
                extensions.st_makepoint(
                    p_longitude,
                    p_latitude
                ),
                4326
            )::extensions.geography;

    end if;


    -- Lock Profile to prevent duplicate concurrent activation.
    select *
    into v_profile
    from public.profiles
    where id = v_user_id
    for update;


    if not found then
        raise exception 'PROFILE_NOT_FOUND'
            using errcode = 'P0001';
    end if;


    if v_profile.status <> 'active' then
        raise exception 'ACCOUNT_NOT_ACTIVE'
            using errcode = 'P0001';
    end if;


    if v_profile.selling_enabled then
        raise exception 'SELLING_ALREADY_ENABLED'
            using errcode = 'P0001';
    end if;


    -- Defensive check against an inconsistent pre-existing Shop.
    if exists (
        select 1
        from public.shops
        where owner_user_id = v_user_id
    ) then

        raise exception 'SELLER_SHOP_ALREADY_EXISTS'
            using errcode = 'P0001';

    end if;


    -- Create default Location.
    insert into public.locations (
        owner_user_id,
        country_code,
        administrative_area,
        locality,
        postal_code,
        formatted_address,
        coordinates,
        public_precision
    )
    values (
        v_user_id,
        upper(trim(p_country_code)),
        nullif(trim(p_administrative_area), ''),
        nullif(trim(p_locality), ''),
        nullif(trim(p_postal_code), ''),
        nullif(trim(p_formatted_address), ''),
        v_coordinates,
        p_public_precision
    )
    returning id into v_location_id;


    -- Create initial Shop.
    insert into public.shops (
        owner_user_id,
        display_name,
        description,
        default_location_id
    )
    values (
        v_user_id,
        trim(p_shop_name),
        nullif(trim(p_shop_description), ''),
        v_location_id
    )
    returning id into v_shop_id;


    -- Enable selling only after Location + Shop creation succeed.
    update public.profiles
    set selling_enabled = true
    where id = v_user_id;


    return v_shop_id;

end;
$$;


revoke all
on function public.activate_selling(
    text,
    text,
    varchar,
    text,
    text,
    text,
    text,
    double precision,
    double precision,
    public.location_precision
)
from public, anon, authenticated;


grant execute
on function public.activate_selling(
    text,
    text,
    varchar,
    text,
    text,
    text,
    text,
    double precision,
    double precision,
    public.location_precision
)
to authenticated;


-- ============================================================
-- 9. ENABLE ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles
enable row level security;

alter table public.locations
enable row level security;

alter table public.shops
enable row level security;


-- ============================================================
-- 10. PROFILES RLS
-- ============================================================

create policy profiles_select_own
on public.profiles
for select
to authenticated
using (
    id = auth.uid()
);


create policy profiles_update_own
on public.profiles
for update
to authenticated
using (
    id = auth.uid()
)
with check (
    id = auth.uid()
);


-- ============================================================
-- 11. LOCATIONS RLS
-- ============================================================

create policy locations_select_own
on public.locations
for select
to authenticated
using (
    owner_user_id = auth.uid()
);


-- Location writes belong to validated domain operations. Activation creates
-- the first Location; a dedicated updateShopLocation operation can follow.


-- ============================================================
-- 12. SHOPS RLS
-- ============================================================

create policy shops_select_active_public
on public.shops
for select
to anon, authenticated
using (
    status = 'active'
);


create policy shops_select_own
on public.shops
for select
to authenticated
using (
    owner_user_id = auth.uid()
);


create policy shops_update_own
on public.shops
for update
to authenticated
using (
    owner_user_id = auth.uid()
)
with check (
    owner_user_id = auth.uid()
);


-- No direct Shop INSERT policy.
-- Initial Shop creation must go through activate_selling().
--
-- No direct Shop DELETE policy.
-- Shops should later be closed via an explicit domain operation.


-- ============================================================
-- 13. TABLE PRIVILEGES
-- ============================================================

revoke all
on public.profiles
from public, anon, authenticated;

revoke all
on public.locations
from public, anon, authenticated;

revoke all
on public.shops
from public, anon, authenticated;


-- Profiles

grant select
on public.profiles
to authenticated;

grant update (
    display_name,
    avatar_url
)
on public.profiles
to authenticated;


-- Locations

grant select
on public.locations
to authenticated;


-- Shops

grant select
on public.shops
to anon, authenticated;

grant update (
    display_name,
    description,
    profile_image_url,
    banner_image_url
)
on public.shops
to authenticated;


-- ============================================================
-- END MIGRATION
-- ============================================================
