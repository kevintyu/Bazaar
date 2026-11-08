-- Post-migration structural checks for Migration 002.
-- Run after both migrations in a local/test Supabase database.
-- Does NOT replace authenticated multi-user RLS integration tests.

do $$
begin
  if to_regclass('public.profiles') is null
     or to_regclass('public.shops') is null
     or to_regclass('public.locations') is null then
    raise exception 'Migration 001 prerequisite tables missing';
  end if;

  if to_regclass('public.listings') is null
     or to_regclass('public.listing_images') is null then
    raise exception 'Migration 002 tables missing';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'listings' and c.relrowsecurity
  ) then
    raise exception 'RLS not enabled on listings';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'listing_images' and c.relrowsecurity
  ) then
    raise exception 'RLS not enabled on listing_images';
  end if;

  if not exists (
    select 1 from storage.buckets
    where id = 'listing-images' and public = false
  ) then
    raise exception 'Private listing-images bucket missing';
  end if;

  if to_regprocedure('public.create_listing(uuid,text,numeric,text,text,text,public.listing_condition,uuid)') is null
    or to_regprocedure('public.publish_listing(uuid)') is null
    or to_regprocedure('public.remove_listing(uuid,public.listing_removal_reason,text)') is null
    or to_regprocedure('public.attach_listing_image(uuid,uuid,text,text)') is null
    or to_regprocedure('public.detach_listing_image(uuid)') is null then
    raise exception 'Required public domain RPC missing';
  end if;

  if has_table_privilege('authenticated', 'public.listings', 'INSERT')
    or has_table_privilege('authenticated', 'public.listings', 'DELETE')
    or has_column_privilege('authenticated', 'public.listings', 'status', 'UPDATE')
    or has_column_privilege('authenticated', 'public.listings', 'moderation_status', 'UPDATE')
    or has_column_privilege('authenticated', 'public.listings', 'owner_user_id', 'UPDATE') then
    raise exception 'Authenticated client has unsafe Listing write privileges';
  end if;

  if has_table_privilege('authenticated', 'public.listing_images', 'INSERT')
    or has_table_privilege('authenticated', 'public.listing_images', 'DELETE') then
    raise exception 'Authenticated client has unsafe image-metadata write privileges';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'listings'
      and indexname = 'listings_public_feed_idx'
  ) then
    raise exception 'Public feed index missing';
  end if;

  raise notice 'Migration 002 structural checks passed';
end;
$$;

do $$
begin
  if to_regnamespace('private') is null then raise exception 'private schema missing'; end if;
  if (select count(*) from pg_constraint where conrelid = 'public.listings'::regclass
      and contype = 'f' and conname in ('listings_shop_owner_fk','listings_location_owner_fk')
      and array_length(conkey,1) = 2) <> 2 then
    raise exception 'Composite ownership foreign keys missing';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'create_listing','attach_listing_image','detach_listing_image',
      'publish_listing','remove_listing','discard_draft_listing',
      'get_public_listing','browse_public_listings'
    ) and (p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false))
  ) then raise exception 'Public wrappers must be invoker with empty search_path'; end if;
  if has_schema_privilege('anon','private','CREATE')
    or has_schema_privilege('authenticated','private','CREATE') then
    raise exception 'Clients can create private functions';
  end if;
  if has_function_privilege('anon','public.publish_listing(uuid)','EXECUTE') then
    raise exception 'Anonymous mutation RPC access';
  end if;
  if to_regprocedure('public.discard_draft_listing(uuid)') is null then
    raise exception 'Draft discard RPC missing';
  end if;
  raise notice 'Migration 002 ownership/function checks passed';
end;
$$;
