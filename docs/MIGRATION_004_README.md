# Migration 004 — reserve/cancel foundation

Implemented and applied locally on 2026-11-11. No production action performed.

## Files and migration order

After the four existing migrations, apply these **new** migrations in order:

1. `supabase/migrations/20261111210000_004_transactions_reservations.sql`
2. `supabase/migrations/20261111210100_004_audit_transition_constraint.sql`

Both are already applied in the inspected local stack. Do not rewrite either.
The second fixes a NULL loophole found by a new audit constraint test after the
first was applied. It explicitly requires the previous RESERVED state for a
cancellation event. Previously applied migrations remain byte-for-byte unchanged.

## Implemented behavior

- Seller reserves directly from an existing Listing Conversation.
- Listing, buyer, seller and Shop identities come from persisted data/auth.uid().
- Transaction creation, audit event and ACTIVE -> RESERVED change are atomic.
- One active Transaction per Listing, protected by a partial unique index and
  Listing row locks. Awaiting-confirmation and disputed states are included in
  that index for future expansion, but are not enabled by this foundation.
- Either participant may cancel before pickup; cancellation plus audit and
  RESERVED -> ACTIVE change are atomic. Historical Transactions are retained.
- Participant-only Transaction/event reads through RLS. Other existing buyers
  cannot read the selected buyer's Transaction. Anonymous reads and direct
  client mutations are denied. No client-supplied actor/participant IDs.
- Audit events are trigger-created and immutable. Transaction identity is
  immutable; only the single RESERVED -> CANCELLED transition is enabled.
- All existing Conversations may still send during RESERVED; new starts fail.
  Cancellation permits new Conversations again. Chat history is not deleted.

## RPC contract

```ts
// Generate once per reservation intent; reuse after a transport failure.
const requestId = crypto.randomUUID();
const { data: transactionId, error } = await supabase.rpc('reserve_listing', {
  p_conversation_id: conversationId,
  p_request_id: requestId,
});

await supabase.rpc('cancel_transaction', {
  p_transaction_id: transactionId,
  p_reason: 'Plans changed', // optional; omit or pass null for no reason
});
```

New reservation requires ACTIVE/CLEAR Listing, active Conversation, eligible
Shop/seller and active buyer. Wrong seller and missing Conversation share the
CONVERSATION_NOT_FOUND response to avoid disclosing unrelated Conversation data.

A (seller, request UUID) is a durable receipt. Exact retry returns the original
Transaction ID even after cancellation; another Conversation under that key
fails with RESERVATION_REQUEST_CONFLICT. A subsequent reservation needs a new
key and creates a new Transaction. Concurrent distinct requests cannot both
reserve one Listing. A failed operation does not consume the key.

Cancellation uses the original Transaction ID. Exact retry by the same actor
with the same normalized reason returns its receipt. A different actor/reason
fails with CANCELLATION_REQUEST_CONFLICT, preserving the original evidence.
Repeating an old cancellation cannot unreserve a newer Transaction.

## Confirmed cancellation policy

Owner answered on 2026-11-11:

- Block new cancellation until restrictions clear if either participant's account
  or the Shop is restricted, or the Listing is UNDER_REVIEW.
- Optional free-text reason now. Define preselected choices later, also retaining
  free text. No reason taxonomy or reputation effect is introduced.

The implementation checks both account statuses, Shop/seller eligibility and
CLEAR Listing moderation. It returns TRANSACTION_RESTRICTED without changing
Listing, Transaction or audit events. Restricted participants retain read access.
Receipt-only exact retries do not execute another cancellation and remain usable.

The text limit is 1,000 input characters. Surrounding spaces are trimmed; empty
text becomes null. Changed reasons cannot rewrite an already-cancelled receipt.

## Integrity and locking

Composite FKs enforce Transaction -> Conversation/Listing/buyer/seller and
Transaction -> Listing/Shop/seller identity. Existing references and new history
use RESTRICT, not destructive cascades. Public authenticated roles have SELECT
only on the new tables; guarded RPCs are the write path.

Lock order: Listing -> Transaction -> Conversation when needed. Reservation
rechecks Conversation after locking the Listing. Concurrent request UUID reuse
across different Listings is handled by the unique key and conflict verification
before either losing request changes its Listing.

Cross-table lifecycle changes are enforced through atomic domain operations,
not a backfill or reinterpretation of historical rows. Existing local test-only
RESERVED Listings without Transactions were preserved. Trusted database fixture
SQL can still construct such rows; ordinary API clients cannot mutate statuses.
No user history was inferred, deleted or rewritten to populate Transactions.

## Deliberately deferred

No mark_picked_up, confirm_pickup, dispute_pickup or timeout/finalization RPC.
The enum includes future names but a foundation CHECK and transition guard
reject unsupported states. Pickup/deadline/completion/dispute metadata will be
added with the approved lifecycle implementation in a future migration.

Still undecided: confirmation duration, deadline precedence, seller finalization,
dispute-resolution roles/outcomes, restrictions during pickup/confirmation/dispute,
blocking during active Transactions, and negotiated price/receipt snapshots.
Cancellation's restriction rule does not silently decide those other actions.
No UI, payments, reviews, transaction Realtime feed or production deployment.

## Validation

```powershell
python supabase/tests/test_migration_004.py
python supabase/tests/test_migration_002.py
python supabase/tests/test_chat_eligibility_compat.py
Get-Content supabase/tests/003_structural_checks.sql -Raw | docker exec -i supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -v ON_ERROR_STOP=1
node scripts/validate_messaging_003.mjs
```

These tests target the fixed local stack only and retain UUID-tagged fixtures.
The 004 suite uses real authenticated JWTs, competing independent requests,
controlled lock holders, and transaction-scoped failure injection. No service
key substitutes for participant authorization checks. Read
`MIGRATION_004_VALIDATION.md` for exact commands actually run, initial failure,
correction, results and limits; the list above is also the rerun recipe.
