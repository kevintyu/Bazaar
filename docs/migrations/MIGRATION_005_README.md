# Migration 005: pickup claims and restricted resolution

Applied locally on 2026-11-24: [20261124000100_005_pickup_claims_resolution.sql](../../supabase/migrations/20261124000100_005_pickup_claims_resolution.sql).
Product authority remains [Domain Model](../DOMAIN_MODEL.md) and [Domain Operations](../DOMAIN_OPERATIONS.md).

## Compatibility

This extends the seven applied migrations without recreating transaction tables,
enums or audit infrastructure. Reservation UUID receipts, participant cancellation,
identity foreign keys, participant read policies and the single-active-transaction
index remain in place. The archived full Migration 004 candidate is not applied.

The existing enum `awaiting_buyer_confirmation` is deliberately retained as the
storage value for **buyer pickup claimed, awaiting seller confirmation**. Its name
does not authorize seller-first completion. Clients must use this semantic mapping.

## Public operations

All operations return the transaction UUID. Acting identity comes from `auth.uid()`.

| RPC | Contract |
|---|---|
| `claim_pickup(p_transaction_id uuid)` | Buyer only; RESERVED to pending, retaining RESERVED Listing. Records claim time, audit event and seller notification intent atomically. |
| `confirm_pickup_claim(p_transaction_id uuid)` | Seller only; requires pending buyer claim. Completes Transaction and marks Listing SOLD atomically; existing messaging trigger concludes Conversations. |
| `resolve_transaction(p_transaction_id uuid, p_request_id uuid, p_outcome text, p_reason text, p_evidence_references jsonb, p_review_findings text)` | Authorized nonparticipant administrator; outcome `completed` or `cancelled`. Completion requires a recorded buyer claim in pending/DISPUTED state. Cancellation also accepts RESERVED. |

New actions require active participant accounts, eligible Shop/seller and CLEAR
Listing moderation. Administrator cancellation cannot override restrictions; an
eligible cancellation returns the Listing to ACTIVE. Normal participant cancellation
remains RESERVED-only. No claim withdrawal or public dispute-initiation RPC is added.

Repeated claims and seller confirmations return their original receipts. Admin
retries require the same administrator request UUID, transaction and normalized
payload, including ordered evidence references. Changed payload/key reuse fails.
Listing then Transaction row locks serialize competing decisions. State changes,
events, resolution evidence and initial notification intent share one transaction.

## Database objects and access

- Transactions gain claim, seller-confirmation and completion timestamps,
  completion actor and opaque administrator resolution ID.
- Events gain the opaque resolution ID. Existing append-only audit is retained.
- Lifecycle metadata/transition constraints and guard/event functions are extended.
- Private tables hold administrator membership, immutable resolutions, notification
  policy and immutable notification intents. RLS is enabled with no API-role grants.
- Public SECURITY INVOKER wrappers call guarded private SECURITY DEFINER functions
  with empty search paths. Only authenticated callers receive wrapper execution.
- Direct client lifecycle writes remain denied. Participant reads do not disclose
  confidential evidence or administrator justification.

## Administrator provisioning and evidence

A trusted database operator manages `private.transaction_administrators` membership
and its `enabled` flag. Membership must never derive from client metadata. The
administrator must have an ACTIVE account and cannot be either participant.
Provisioning is not exposed through an API; no production membership was created.

Reason: at least 10 non-whitespace characters, maximum 1,000 stored characters.
Review findings: at least 20 non-whitespace characters, maximum 4,000. Evidence:
1–20 nonblank JSON string references, each at most 1,000 characters. A resolution
records administrator, decision, timestamp, reason, findings and references and
cannot be updated or deleted through the application. Public cancellation reasons
do not copy confidential administrator evidence.

These validations require a recorded review attestation; they cannot establish
whether external evidence is true or a human actually reviewed it. Evidence
sufficiency, storage/access/retention, review tooling, operator provisioning process
and any second-review requirement still need operational policy.

## Notifications and timing

There was no existing notification delivery infrastructure. The durable private
outbox records initial seller intents atomically. The owner-only
`private.enqueue_transaction_followups(p_now timestamptz)` can enqueue reminders
and one administrator escalation per Transaction. Both policy intervals default to
NULL (disabled); positive intervals are configurable by a trusted operator.

No scheduler, delivery adapter or external notifications are installed. Delivery
must recheck pending state, deduplicate by outbox ID, and keep delivery receipts in
separate storage because intents are immutable. A NULL escalation recipient denotes
the administrator audience, not an arbitrary public recipient. Cadence, escalation
timing and delivery channel remain unapproved. No confirmation deadline exists;
elapsed time and escalation never change lifecycle state.

See [local validation](../validation/MIGRATION_005_VALIDATION.md).
