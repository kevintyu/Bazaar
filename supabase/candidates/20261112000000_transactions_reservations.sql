-- Marketplace Migration 004 — Transactions and Reservations (CANDIDATE)
-- This file is NOT applied to any database. Local integration and product
-- confirmation are required before promotion to an executable release.
--
-- Prerequisites: repository Migrations 001, 002, compatibility, 003.
-- Required columns:
--   listings(id, shop_id, owner_user_id, status, moderation_status)
--   conversations(id, listing_id, buyer_user_id, seller_user_id, status)
--   profiles(id,status), shops(id,status,owner_user_id)
--   private.shop_is_publicly_eligible(uuid)
--
-- Keep migrations already applied to Supabase unchanged. Adjust THIS
-- candidate to fit repository migration history before application.

DO $preflight$
BEGIN
  IF to_regclass('public.listings') IS NULL
    OR to_regclass('public.conversations') IS NULL
    OR to_regclass('public.profiles') IS NULL
    OR to_regprocedure('private.shop_is_publicly_eligible(uuid)') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_004_PREREQUISITES_MISSING';
  END IF;
END;
$preflight$;

-- 1. Types and policy ----------------------------------------------------
CREATE TYPE public.transaction_status AS ENUM (
  'reserved', 'awaiting_buyer_confirmation', 'completed', 'cancelled', 'disputed'
);

CREATE TYPE public.transaction_event_type AS ENUM (
  'reserved', 'seller_marked_picked_up', 'buyer_confirmed',
  'seller_finalized_after_timeout', 'cancelled', 'disputed'
);

-- Private setting, controlled by the operator; never user-writable.
-- Three days is a PROVISIONAL default, not a finalized product rule.
CREATE TABLE private.transaction_confirmation_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  confirmation_window interval NOT NULL
    CHECK (confirmation_window >= interval '1 hour'
       AND confirmation_window <= interval '30 days'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO private.transaction_confirmation_policy (singleton, confirmation_window)
VALUES (true, interval '3 days');
REVOKE ALL ON private.transaction_confirmation_policy FROM PUBLIC, anon, authenticated;

-- 2. Relational integrity ------------------------------------------------
-- Conversation seller/listing/buyer is sealed by the composite FK.
-- Unique constraints add composite referencing keys, not new domain entities.
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_transaction_identity_unique
  UNIQUE (id, listing_id, buyer_user_id, seller_user_id);

ALTER TABLE public.listings
  ADD CONSTRAINT listings_transaction_identity_unique
  UNIQUE (id, shop_id, owner_user_id);

CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL,
  shop_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  buyer_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  seller_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,

  status public.transaction_status NOT NULL DEFAULT 'reserved',
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seller_marked_picked_up_at timestamptz,
  buyer_confirmation_deadline timestamptz,
  buyer_confirmed_at timestamptz,
  seller_finalized_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES public.profiles(id),
  cancellation_reason text,
  disputed_at timestamptz,
  dispute_reason text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT transactions_listing_identity_fk FOREIGN KEY
    (listing_id, shop_id, seller_user_id)
    REFERENCES public.listings(id, shop_id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT transactions_conversation_identity_fk FOREIGN KEY
    (conversation_id, listing_id, buyer_user_id, seller_user_id)
    REFERENCES public.conversations(id, listing_id, buyer_user_id, seller_user_id)
    ON DELETE RESTRICT,
  CONSTRAINT transactions_participants_distinct
    CHECK (buyer_user_id <> seller_user_id),
  CONSTRAINT transactions_cancelled_by_participant
    CHECK (cancelled_by_user_id IS NULL OR
      cancelled_by_user_id IN (buyer_user_id, seller_user_id)),
  CONSTRAINT transactions_reason_lengths CHECK (
    (cancellation_reason IS NULL OR length(cancellation_reason) <= 500)
    AND (dispute_reason IS NULL OR length(dispute_reason) BETWEEN 1 AND 1000)
  ),
  CONSTRAINT transactions_status_metadata CHECK (
    (status <> 'reserved' OR (
      seller_marked_picked_up_at IS NULL AND completed_at IS NULL
      AND cancelled_at IS NULL AND disputed_at IS NULL
    ))
    AND (status <> 'awaiting_buyer_confirmation' OR (
      seller_marked_picked_up_at IS NOT NULL
      AND buyer_confirmation_deadline IS NOT NULL
      AND completed_at IS NULL AND cancelled_at IS NULL AND disputed_at IS NULL
    ))
    AND (status <> 'completed' OR (
      completed_at IS NOT NULL
      AND (buyer_confirmed_at IS NOT NULL OR seller_finalized_at IS NOT NULL)
    ))
    AND (status <> 'cancelled' OR (
      cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
      AND completed_at IS NULL
    ))
    AND (status <> 'disputed' OR (
      disputed_at IS NOT NULL AND dispute_reason IS NOT NULL
      AND seller_marked_picked_up_at IS NOT NULL
      AND buyer_confirmation_deadline IS NOT NULL
      AND completed_at IS NULL
    ))
  )
);

CREATE TRIGGER transactions_updated_at
BEFORE UPDATE ON public.transactions FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- Multiple cancelled attempts may exist. Only one active reservation at a time.
CREATE UNIQUE INDEX transactions_one_active_per_listing
ON public.transactions(listing_id)
WHERE status IN ('reserved', 'awaiting_buyer_confirmation', 'disputed');

-- Never complete the same Listing's sale twice.
CREATE UNIQUE INDEX transactions_one_completed_per_listing
ON public.transactions(listing_id)
WHERE status = 'completed';

CREATE INDEX transactions_buyer_inbox
ON public.transactions(buyer_user_id, created_at DESC);
CREATE INDEX transactions_seller_inbox
ON public.transactions(seller_user_id, created_at DESC);
CREATE INDEX transactions_listing_history
ON public.transactions(listing_id, created_at DESC);

-- Immutable domain-event history, independently readable by participants.
CREATE TABLE public.transaction_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  event_type public.transaction_event_type NOT NULL,
  details text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT transaction_event_details_length
    CHECK (details IS NULL OR length(details) <= 1000),
  CONSTRAINT transaction_event_once UNIQUE(transaction_id, event_type)
);
CREATE INDEX transaction_events_tx_time
ON public.transaction_events(transaction_id, occurred_at, id);

-- 3. Read-only participant-scoped RLS ------------------------------------
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transactions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.transaction_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.transactions TO authenticated;
GRANT SELECT ON public.transaction_events TO authenticated;

CREATE POLICY transactions_participant_read
ON public.transactions FOR SELECT TO authenticated USING (
  buyer_user_id = (SELECT auth.uid())
  OR seller_user_id = (SELECT auth.uid())
);

CREATE FUNCTION private.is_transaction_participant(p_transaction_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = p_transaction_id
      AND (t.buyer_user_id = (SELECT auth.uid())
           OR t.seller_user_id = (SELECT auth.uid()))
  );
$$;
REVOKE ALL ON FUNCTION private.is_transaction_participant(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_transaction_participant(uuid)
TO authenticated;

CREATE POLICY transaction_events_participant_read
ON public.transaction_events FOR SELECT TO authenticated
USING (private.is_transaction_participant(transaction_id));

-- 4. Shared private helper -----------------------------------------------
-- Always lock Listing before Transaction in every transition. This is the
-- canonical lock order for reservation/close/cancellation concurrency.
CREATE FUNCTION private.lock_transaction_for_action(p_transaction_id uuid)
RETURNS public.transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_listing_id uuid;
  v_tx public.transactions%ROWTYPE;
BEGIN
  SELECT t.listing_id INTO v_listing_id
  FROM public.transactions t WHERE t.id = p_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM public.listings l
    WHERE l.id = v_listing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT t.* INTO v_tx FROM public.transactions t
    WHERE t.id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_tx;
END;
$$;

-- 5. Seller reserves for THIS buyer in THIS listing-specific conversation.
CREATE FUNCTION private.reserve_listing_impl(p_conversation_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_c public.conversations%ROWTYPE;
  v_l public.listings%ROWTYPE;
  v_tx_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  -- Read only the identity tuple before acquiring the Listing row lock.
  SELECT c.* INTO v_c FROM public.conversations c WHERE c.id = p_conversation_id;
  IF NOT FOUND OR v_c.seller_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_OWNED_BY_SELLER' USING ERRCODE = 'P0001';
  END IF;

  SELECT l.* INTO v_l FROM public.listings l
  WHERE l.id = v_c.listing_id FOR UPDATE;
  IF NOT FOUND OR v_l.owner_user_id IS DISTINCT FROM v_actor
     OR v_l.status <> 'active' OR v_l.moderation_status <> 'clear'
     OR NOT private.shop_is_publicly_eligible(v_l.shop_id) THEN
    RAISE EXCEPTION 'LISTING_NOT_ELIGIBLE_FOR_RESERVATION' USING ERRCODE = 'P0001';
  END IF;

  -- Re-read the Conversation after taking Listing lock, so a racing
  -- completion/removal cannot leave stale eligibility in this operation.
  SELECT c.* INTO v_c FROM public.conversations c WHERE c.id = p_conversation_id;
  IF NOT FOUND OR v_c.status <> 'active'
     OR v_c.listing_id <> v_l.id OR v_c.seller_user_id <> v_actor THEN
    RAISE EXCEPTION 'CONVERSATION_NOT_ACTIVE' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = v_c.buyer_user_id AND p.status = 'active'
  ) THEN
    RAISE EXCEPTION 'BUYER_NOT_ACTIVE' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.transactions (
    listing_id, shop_id, conversation_id, buyer_user_id, seller_user_id
  ) VALUES (
    v_l.id, v_l.shop_id, v_c.id, v_c.buyer_user_id, v_actor
  ) RETURNING id INTO v_tx_id;

  UPDATE public.listings SET status = 'reserved' WHERE id = v_l.id;

  INSERT INTO public.transaction_events (
    transaction_id, actor_user_id, event_type
  ) VALUES (v_tx_id, v_actor, 'reserved');

  RETURN v_tx_id;
END;
$$;

-- 6. Cancel before pickup. Both buyer and seller can cancel RESERVEd.
CREATE FUNCTION private.cancel_transaction_impl(
  p_transaction_id uuid, p_reason text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  v_tx := private.lock_transaction_for_action(p_transaction_id);
  IF v_actor NOT IN (v_tx.buyer_user_id, v_tx.seller_user_id) THEN
    RAISE EXCEPTION 'NOT_TRANSACTION_PARTICIPANT' USING ERRCODE = 'P0001';
  END IF;
  IF v_tx.status <> 'reserved' THEN
    RAISE EXCEPTION 'CANNOT_CANCEL_AFTER_PICKUP' USING ERRCODE = 'P0001';
  END IF;
  IF length(coalesce(p_reason, '')) > 500 THEN
    RAISE EXCEPTION 'REASON_TOO_LONG' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = v_tx.listing_id AND l.status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'INCONSISTENT_LISTING_STATE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.transactions SET
    status = 'cancelled', cancelled_at = clock_timestamp(),
    cancelled_by_user_id = v_actor,
    cancellation_reason = nullif(btrim(p_reason), '')
  WHERE id = v_tx.id;

  UPDATE public.listings SET status = 'active' WHERE id = v_tx.listing_id;

  INSERT INTO public.transaction_events (
    transaction_id, actor_user_id, event_type, details
  ) VALUES (v_tx.id, v_actor, 'cancelled', nullif(btrim(p_reason), ''));

  RETURN v_tx.id;
END;
$$;

-- 7. Seller reports handing over the item. This is NOT proof of receipt.
CREATE FUNCTION private.mark_picked_up_impl(p_transaction_id uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_window interval;
  v_now timestamptz;
  v_deadline timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  v_tx := private.lock_transaction_for_action(p_transaction_id);
  IF v_actor IS DISTINCT FROM v_tx.seller_user_id THEN
    RAISE EXCEPTION 'SELLER_ONLY' USING ERRCODE = 'P0001';
  END IF;
  IF v_tx.status <> 'reserved' OR NOT EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = v_tx.listing_id AND l.status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_STATE' USING ERRCODE = 'P0001';
  END IF;

  SELECT confirmation_window INTO v_window
  FROM private.transaction_confirmation_policy WHERE singleton = true;
  IF v_window IS NULL THEN
    RAISE EXCEPTION 'CONFIRMATION_POLICY_MISSING' USING ERRCODE = 'P0001';
  END IF;
  v_now := clock_timestamp();
  v_deadline := v_now + v_window;

  UPDATE public.transactions SET
    status = 'awaiting_buyer_confirmation',
    seller_marked_picked_up_at = v_now,
    buyer_confirmation_deadline = v_deadline
  WHERE id = v_tx.id;

  INSERT INTO public.transaction_events (
    transaction_id, actor_user_id, event_type
  ) VALUES (v_tx.id, v_actor, 'seller_marked_picked_up');

  RETURN v_deadline;
END;
$$;

-- 8. Buyer confirms item pickup: atomically completes and sells.
CREATE FUNCTION private.confirm_pickup_impl(p_transaction_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  v_tx := private.lock_transaction_for_action(p_transaction_id);
  IF v_actor IS DISTINCT FROM v_tx.buyer_user_id THEN
    RAISE EXCEPTION 'BUYER_ONLY' USING ERRCODE = 'P0001';
  END IF;
  IF v_tx.status <> 'awaiting_buyer_confirmation' OR NOT EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = v_tx.listing_id AND l.status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_STATE' USING ERRCODE = 'P0001';
  END IF;
  v_now := clock_timestamp();
  UPDATE public.transactions SET
    status = 'completed', buyer_confirmed_at = v_now, completed_at = v_now
  WHERE id = v_tx.id;
  UPDATE public.listings SET status = 'sold' WHERE id = v_tx.listing_id;
  -- Migration 003 trigger concludes Listing conversations when SOLD.
  INSERT INTO public.transaction_events (
    transaction_id, actor_user_id, event_type
  ) VALUES (v_tx.id, v_actor, 'buyer_confirmed');
  RETURN v_tx.id;
END;
$$;

-- 9. Buyer disputes pickup; ADMIN resolution flow is future work.
CREATE FUNCTION private.dispute_pickup_impl(
  p_transaction_id uuid, p_reason text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  v_tx := private.lock_transaction_for_action(p_transaction_id);
  IF v_actor IS DISTINCT FROM v_tx.buyer_user_id THEN
    RAISE EXCEPTION 'BUYER_ONLY' USING ERRCODE = 'P0001';
  END IF;
  IF v_tx.status <> 'awaiting_buyer_confirmation' THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_STATE' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0
     OR length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'INVALID_DISPUTE_REASON' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.transactions SET
    status = 'disputed', disputed_at = clock_timestamp(),
    dispute_reason = p_reason
  WHERE id = v_tx.id;

  INSERT INTO public.transaction_events (
    transaction_id, actor_user_id, event_type, details
  ) VALUES (v_tx.id, v_actor, 'disputed', p_reason);
  -- Listing intentionally remains RESERVED; do not automatically
  -- set moderation UNDER_REVIEW (only admins may do so).
  RETURN v_tx.id;
END;
$$;

-- 10. Seller may finalize after the stored deadline, unless disputed.
CREATE FUNCTION private.finalize_unconfirmed_pickup_impl(p_transaction_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  v_tx := private.lock_transaction_for_action(p_transaction_id);
  IF v_actor IS DISTINCT FROM v_tx.seller_user_id THEN
    RAISE EXCEPTION 'SELLER_ONLY' USING ERRCODE = 'P0001';
  END IF;
  v_now := clock_timestamp();
  IF v_tx.status <> 'awaiting_buyer_confirmation'
     OR v_tx.buyer_confirmation_deadline IS NULL
     OR v_now < v_tx.buyer_confirmation_deadline
     OR NOT EXISTS (SELECT 1 FROM public.listings l
                    WHERE l.id = v_tx.listing_id AND l.status = 'reserved') THEN
    RAISE EXCEPTION 'CONFIRMATION_DEADLINE_NOT_REACHED_OR_INVALID_STATE'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.transactions SET
    status = 'completed', seller_finalized_at = v_now, completed_at = v_now
  WHERE id = v_tx.id;
  UPDATE public.listings SET status = 'sold' WHERE id = v_tx.listing_id;
  INSERT INTO public.transaction_events (
    transaction_id, actor_user_id, event_type
  ) VALUES (v_tx.id, v_actor, 'seller_finalized_after_timeout');
  RETURN v_tx.id;
END;
$$;

-- 11. Exposed INVOKER wrappers; guarded implementations stay in `private`.
CREATE FUNCTION public.reserve_listing(p_conversation_id uuid)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT private.reserve_listing_impl(p_conversation_id);
$$;

CREATE FUNCTION public.cancel_transaction(
  p_transaction_id uuid, p_reason text DEFAULT NULL
)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT private.cancel_transaction_impl(p_transaction_id, p_reason);
$$;

CREATE FUNCTION public.mark_picked_up(p_transaction_id uuid)
RETURNS timestamptz LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT private.mark_picked_up_impl(p_transaction_id);
$$;

CREATE FUNCTION public.confirm_pickup(p_transaction_id uuid)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT private.confirm_pickup_impl(p_transaction_id);
$$;

CREATE FUNCTION public.dispute_pickup(p_transaction_id uuid, p_reason text)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT private.dispute_pickup_impl(p_transaction_id, p_reason);
$$;

CREATE FUNCTION public.finalize_unconfirmed_pickup(p_transaction_id uuid)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT private.finalize_unconfirmed_pickup_impl(p_transaction_id);
$$;

-- PostgreSQL grants function EXECUTE to PUBLIC by default, revoke it.
REVOKE ALL ON FUNCTION private.lock_transaction_for_action(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reserve_listing_impl(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.cancel_transaction_impl(uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.mark_picked_up_impl(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.confirm_pickup_impl(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.dispute_pickup_impl(uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.finalize_unconfirmed_pickup_impl(uuid)
  FROM PUBLIC, anon, authenticated;

-- Caller must use PUBLIC wrappers; wrappers invoke these guarded functions.
-- No authenticated EXECUTE grant on lock_transaction_for_action(): it can
-- return a transaction record and is invoked only from private SECURITY DEFINER code.
GRANT EXECUTE ON FUNCTION private.reserve_listing_impl(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION private.cancel_transaction_impl(uuid,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION private.mark_picked_up_impl(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION private.confirm_pickup_impl(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION private.dispute_pickup_impl(uuid,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION private.finalize_unconfirmed_pickup_impl(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.reserve_listing(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_transaction(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_picked_up(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_pickup(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispute_pickup(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_unconfirmed_pickup(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_listing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_transaction(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_picked_up(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_pickup(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispute_pickup(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_unconfirmed_pickup(uuid) TO authenticated;

-- END CANDIDATE Migration 004.
