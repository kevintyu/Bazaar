# Migration 004 — Transactions and Reservations: implementation design

Status updated 2026-11-11: the reserve/cancel foundation is implemented and
applied **locally only**, with a forward-only audit-constraint correction.
See MIGRATION_004_README.md and MIGRATION_004_VALIDATION.md for exact implemented
scope and executed results. Pickup/confirmation/dispute/finalization sections
below remain a future design, not implemented behavior.

## Existing foundation and non-negotiable rules

Read AGENTS.md, DOMAIN_MODEL.md, DOMAIN_OPERATIONS.md, ER_MODEL.md and
DATABASE_SCHEMA.md together. The current user request authorizes beginning 004
and supersedes the old first-vertical-slice-only scope in AGENTS.md. No separate
Offer or Reservation entity; a Transaction starts at seller reservation from an
existing listing Conversation. Preserve cancelled/disputed transactions and
messages. Migration 001/002/compatibility/003 are already applied locally and
must not be renamed or rewritten. Use a new 14-digit timestamp migration.

Confirmed RESERVED messaging rule: no new Conversations, all existing
Conversations can continue. Reservation must not conclude competing buyers'
Conversations. Cancellation returns the Listing to ACTIVE and permits new ones.
Completion makes the Listing SOLD; the existing 003 trigger concludes every
Conversation for that Listing while retaining readable history.

## Data and integrity

`public.transactions` follows DATABASE_SCHEMA.md: UUID id; listing_id, shop_id,
conversation_id, buyer_user_id, seller_user_id; status; reserved_at;
seller_marked_picked_up_at; buyer_confirmation_deadline; buyer_confirmed_at;
seller_finalized_at; cancelled_at; cancelled_by_user_id; cancellation_reason;
disputed_at; completed_at; created_at; updated_at.

States: reserved, awaiting_buyer_confirmation, completed, cancelled, disputed.

- Foreign keys use RESTRICT, never cascading destructive deletion of evidence.
- Buyer and seller must differ.
- Add composite referenced uniqueness in a **new** migration so foreign keys
  enforce that transaction Listing, buyer and seller match its Conversation,
  and Listing/Shop/seller match the original Listing. RPC checks alone are not
  sufficient for these identity invariants.
- Partial UNIQUE(listing_id) WHERE status IN
  ('reserved','awaiting_buyer_confirmation','disputed') enforces one active
  Transaction including disputes. Cancelled history does not prevent re-reserving.
- Timestamp/state checks enforce coherent transitions (e.g. confirmation requires
  pickup mark and completion time; cancellation requires actor and time).
- Do not treat the Listing asking price as a negotiated final sale price. Whether
  the receipt needs an agreed amount/currency and immutable listing snapshot is
  an explicit open decision before adding those fields.
- Implemented append-only `transaction_events`: transaction_id, event type, actor,
  previous/new state, occurred_at and minimal structured metadata. Every event
  and state transition commit atomically; no client event-write grant. This is
  a proposed implementation detail for audit preservation, not a new business entity.

## Atomic commands and lock order

Public SECURITY INVOKER wrappers call guarded private SECURITY DEFINER helpers
with empty search_path and qualified names, matching existing conventions.
Never expose `private` through the Data API. Determine actor using auth.uid().

Use one consistent lock order: Listing -> Transaction -> Conversation(s) when
needed. Find immutable parent IDs first, then lock and revalidate. Never lock a
Conversation and then wait for its Listing: remove/completion locks Listing
before concluding Conversations. Existing send_message locks its Conversation
and reads Listing eligibility without a Listing row lock; preserve that ordering.
Recheck statuses after locks are acquired. Database statement failures roll back
the Listing, Transaction and audit event together.

### reserve_listing(conversation_id, request_id)

1. Authenticate seller, read Conversation's Listing ID, lock Listing FOR UPDATE.
2. Check caller is both Listing owner and Conversation seller; derive buyer and
   Shop from persisted rows, never from browser-supplied identities.
3. Check existing request-id receipt before attempting a new reservation.
   Implemented unique (seller_user_id, request_id) gives durable idempotence:
   exact retries return the original Transaction even after cancellation;
   reusing the key for a different Conversation fails. A genuinely new
   reservation after cancellation requires a new request ID.
4. Require ACTIVE/CLEAR Listing, active Conversation, eligible Shop/seller and
   eligible buyer. Account eligibility during later operations remains a policy
   decision below; reserve should follow existing active-account entry checks.
5. Insert RESERVED Transaction and reservation event; update Listing to RESERVED.
6. Commit. Concurrent reservations for different buyers serialize on the Listing;
   exactly one wins. The partial unique index is a second line of defense.

No new Conversation is created as a side effect. No messages are destroyed or
changed. Repeated clicks must not create multiple transactions.

### cancel_transaction(transaction_id, reason)

Buyer or seller only, before pickup (Transaction RESERVED). Lock Listing then
Transaction; verify participants/state and Listing RESERVED. Atomically record
cancellation actor/time/reason, set Transaction CANCELLED, return Listing ACTIVE,
and append an event. Retain the old Transaction; a later reserve creates a new ID.

Implemented retry contract: already-cancelled requests with the same actor/reason
return the original record; conflicting retries fail without modifying history.
Owner-confirmed 2026-11-11: optional free-text reason now; preselected options
plus free text later. Do not reuse listing-removal taxonomy. The foundation uses
a 1,000-character API limit and normalizes surrounding spaces/empty text.

### mark_picked_up(transaction_id)

Seller only, RESERVED -> AWAITING_BUYER_CONFIRMATION. Record server pickup-mark
time and snapshot the configured confirmation window into an absolute deadline.
Listing remains RESERVED, and the same active-transaction uniqueness applies.
Exact retry returns the original mark/deadline and must never extend the window.

The window is not chosen yet. Proposed configuration lives in a private policy
row, writable only by trusted administration. No browser-supplied deadline or
hardcoded default. If unconfigured, fail with a clear configuration error rather
than manufacture a deadline. This gating proposal needs review before activation.

### confirm_pickup(transaction_id)

Buyer only, AWAITING_BUYER_CONFIRMATION -> COMPLETED, Listing RESERVED -> SOLD,
with buyer_confirmed_at and completed_at from server time and an audit event.
The Listing's existing trigger concludes all Conversations. Repeated successful
confirmation returns the same result. Seller/outsider confirmation is rejected.

Whether buyer confirmation remains possible after the deadline depends on the
finalization decision below; do not interpret a deadline alone as automatic sale.

### dispute_pickup(transaction_id)

Buyer only from AWAITING_BUYER_CONFIRMATION under the established lifecycle.
Record disputed_at plus supporting evidence reference/reason according to the
pending dispute policy. Set Transaction DISPUTED, keep Listing RESERVED, retain
all records and prevent a second active Transaction. No seller completion,
cancellation shortcut, or automatic unreserve can bypass a dispute.

Dispute resolution requires an explicitly approved trusted role and outcome
workflow; no general client `update status` or unreviewed admin bypass.

### finalize_timed_out_transaction(transaction_id)

Do not enable yet. The domain says the seller *may eventually* be allowed to
finalize. A deadline is not authorization. Duration, grace periods, late buyer
confirmation/dispute precedence, moderation restrictions, and timeout actor
(seller versus job) need a product decision first. No cron or auto-completion
is introduced by this design.

## Role-based access

| Actor | Read Transaction/audit | Reserve | Cancel before pickup | Mark pickup | Confirm | Dispute |
|---|---|---|---|---|---|---|
| Seller participant | Yes | Own Listing, from its Conversation | Yes | Yes | No | No under current model |
| Buyer participant | Yes | No | Yes | No | Yes | Yes |
| Other buyer with Conversation | No access to selected buyer's Transaction | No | No | No | No | No |
| Unrelated authenticated user | No | No | No | No | No | No |
| Anonymous | No | No | No | No | No | No |

Enable RLS; authenticated SELECT only for the two transaction participants.
Audit rows follow the parent Transaction's participant policy. Revoke direct
INSERT/UPDATE/DELETE from anon/authenticated; all lifecycle changes go through
RPCs. Test both table ACLs and RLS through real JWTs. Trusted service/database
roles are not proof of participant access control. No public transaction feed.

Owner-confirmed 2026-11-11: block new cancellation while either account or the
Shop is restricted, or the Listing is UNDER_REVIEW. Participant history stays
readable. Effects on pickup/confirmation/dispute and blocking remain unresolved;
the cancellation decision does not silently decide those other operations.

## Implementation test plan (foundation results in MIGRATION_004_VALIDATION.md)

Use new disposable local fixtures and independent authenticated clients, plus
controlled SQL sessions for deterministic lock order. Never target production.

1. Seller reserve succeeds; buyer, outsider, anonymous and wrong seller fail.
   Missing Conversation, draft/removed/sold/moderated Listing, self-purchase and
   inconsistent composite identities fail without partial rows.
2. Two simultaneous buyers: one reservation wins, one active Transaction exists,
   Listing and selected Conversation identities agree. Same request UUID returns
   the same ID; changed target conflicts; a retry after cancellation cannot reserve again.
3. Cancellation by either participant returns Listing ACTIVE and retains history.
   Outsider cancellation and cancellation after pickup fail. Re-reserve creates
   a separate historical record; concurrent cancel/reserve obeys serial order.
4. Reserve/remove and reserve/new-Conversation races have one valid serialized
   outcome; reserve/send does not deadlock and existing chat continues.
5. Inject failures after transaction/event writes and before Listing transition;
   verify entire operation rolls back. Repeat for cancel and completion.
6. Seller pickup mark sets one stable deadline from test-only configuration;
   repeated mark cannot extend it. Missing configuration and invalid role fail.
7. Buyer confirmation sells Listing and concludes every Conversation atomically;
   participant history remains readable and new messages are denied.
8. Buyer dispute keeps the active slot and Listing reservation. Race confirm vs
   dispute; only one transition wins. No direct mutation or seller override.
9. Test both sides of the exact deadline boundary only after timeout policy is
   accepted; use test clock/configuration, not long sleeps or production clocks.
10. Real JWT/RLS reads for seller, selected buyer, other existing buyer, unrelated
    user and anonymous client; immutable audit rows and no direct status writes.
11. Rerun Migration 002 and the complete 003 suite after applying 004 locally.
    If 003's fixture-only direct RESERVED changes conflict with new consistency
    checks, adapt fixture setup to use real reservation RPCs, not weaken invariants.

## Next implementation step

Reserve/cancel and audit history are now implemented. Next, settle the confirmation
window and applicable account/moderation rules, then implement and test pickup
marking and buyer confirmation in another forward-only migration. Keep seller
finalization and dispute-resolution outcomes gated until their policy is explicit.
Do not treat future design sections or their test plan as executed code/tests.
