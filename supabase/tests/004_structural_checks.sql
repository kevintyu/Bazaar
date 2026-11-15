-- Structural checks for candidate Migration 004.
-- Run only AFTER applying 004 to disposable local Supabase.
-- Does not validate live JWT permissions or actual concurrency.
DO $checks$
DECLARE
  v_table text;
  v_rpc text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['transactions', 'transaction_events'] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'Missing table %', v_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid = ('public.' || v_table)::regclass AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS disabled on %', v_table;
    END IF;
    IF has_table_privilege('anon', 'public.'||v_table, 'SELECT')
       OR has_table_privilege('authenticated', 'public.'||v_table, 'INSERT')
       OR has_table_privilege('authenticated', 'public.'||v_table, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.'||v_table, 'DELETE') THEN
      RAISE EXCEPTION 'Insecure table grant on %', v_table;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='transactions_one_active_per_listing'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%disputed%') THEN
    RAISE EXCEPTION 'Active Transaction unique constraint missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transactions'::regclass
      AND conname = 'transactions_conversation_identity_fk' AND contype='f') THEN
    RAISE EXCEPTION 'Transaction participant/conversation FK missing';
  END IF;

  FOREACH v_rpc IN ARRAY ARRAY[
    'reserve_listing(uuid)',
    'cancel_transaction(uuid,text)',
    'mark_picked_up(uuid)',
    'confirm_pickup(uuid)',
    'dispute_pickup(uuid,text)',
    'finalize_unconfirmed_pickup(uuid)'
  ] LOOP
    IF to_regprocedure('public.'||v_rpc) IS NULL THEN
      RAISE EXCEPTION 'Missing public transaction RPC %', v_rpc;
    END IF;
    IF NOT has_function_privilege('authenticated','public.'||v_rpc,'EXECUTE') THEN
      RAISE EXCEPTION 'Authenticated EXECUTE missing for %', v_rpc;
    END IF;
    IF has_function_privilege('anon','public.'||v_rpc,'EXECUTE') THEN
      RAISE EXCEPTION 'Anonymous EXECUTE permitted for %', v_rpc;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM private.transaction_confirmation_policy
    WHERE singleton = true AND confirmation_window > interval '0 seconds'
  ) THEN
    RAISE EXCEPTION 'Missing confirmation-window policy';
  END IF;

  RAISE NOTICE 'Migration 004 structural checks passed (integration unverified)';
END;
$checks$;
