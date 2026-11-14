-- Marketplace: forward-only prerequisite compatibility migration for Chat 003.
-- Apply AFTER the repository's Migration 002 and BEFORE Migration 003.
-- NOTE: Compare this predicate with the effective listing/shop eligibility
-- rules in YOUR repository before applying. Do not silently change policy.
-- If the helper exists, this migration leaves its definition unchanged.
-- If Migration 002 has already been applied, this is a NEW migration: do not
-- edit or re-run previously applied SQL to add a missing function.
-- Predicate matches 002's publish_listing/can_write_listing_media rules.
-- Public listing reads check active Shop/account but not selling_enabled;
-- chat eligibility deliberately follows the existing seller-write gate.

DO $preflight$
BEGIN
  IF to_regclass('public.shops') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regnamespace('private') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITES_MISSING: shops, profiles, or private schema';
  END IF;
END;
$preflight$;

DO $install$
BEGIN
  IF to_regprocedure('private.shop_is_publicly_eligible(uuid)') IS NULL THEN
    EXECUTE $function_ddl$
      CREATE FUNCTION private.shop_is_publicly_eligible(p_shop_id uuid)
      RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = ''
      AS $function_body$
        SELECT EXISTS (
          SELECT 1
          FROM public.shops s
          JOIN public.profiles p ON p.id = s.owner_user_id
          WHERE s.id = p_shop_id
            AND s.status = 'active'
            AND p.status = 'active'
            AND p.selling_enabled = true
        );
      $function_body$;
    $function_ddl$;
    -- Only trusted SECURITY DEFINER chat operations need this helper.
    -- Do not expose a new client-callable eligibility oracle.
    REVOKE ALL ON FUNCTION private.shop_is_publicly_eligible(uuid)
      FROM PUBLIC, anon, authenticated;
  END IF;
END;
$install$;

-- An existing helper's definition, ownership and permissions are untouched.
-- Keep private out of the PostgREST exposed schemas.

DO $verify$
DECLARE
  v_result_type oid;
BEGIN
  SELECT prorettype INTO v_result_type
  FROM pg_proc
  WHERE oid = 'private.shop_is_publicly_eligible(uuid)'::regprocedure;
  IF v_result_type <> 'pg_catalog.bool'::regtype THEN
    RAISE EXCEPTION 'INVALID_HELPER_RETURN_TYPE: expected boolean';
  END IF;
END;
$verify$;

-- Do NOT run 003 until a test fixture verifies:
--   eligible: active shop + active seller account + selling enabled
--   ineligible: suspended/closed shop, suspended/banned seller,
--               selling disabled, nonexistent shop.
-- If repository policy differs, adjust in a new migration before 003.
