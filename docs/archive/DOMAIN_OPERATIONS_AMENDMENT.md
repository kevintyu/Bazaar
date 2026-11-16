> Historical record, organized 2026-11-15. See the [folder index](README.md). Original proposals, commands, results,
> and paths below describe their original context, not current instructions.
> For current policy see [Domain Model](../DOMAIN_MODEL.md) and [Domain Operations](../DOMAIN_OPERATIONS.md).
> Seller-initiated pickup and timeout-completion proposals are superseded.

# Domain Operations — Transactions and Reservation Contract v0.1

## Explicit commands (candidate Migration 004)

| API function | Allowed actor | Preconditions | Atomic outcome |
|---|---|---|---|
| `reserve_listing(p_conversation_id)` | Seller only | Conversation ACTIVE, Listing ACTIVE + CLEAR, Shop/seller eligible, buyer ACTIVE | Transaction RESERVED; Listing RESERVED; audit event |
| `cancel_transaction(p_transaction_id, p_reason)` | Buyer or Seller | Transaction RESERVED (before pickup) | Transaction CANCELLED; Listing ACTIVE; audit event |
| `mark_picked_up(p_transaction_id)` | Seller only | Transaction RESERVED, Listing RESERVED | Transaction AWAITING_BUYER_CONFIRMATION, stored deadline; audit event |
| `confirm_pickup(p_transaction_id)` | Buyer only | Transaction AWAITING_BUYER_CONFIRMATION | Transaction COMPLETED; Listing SOLD; conversations concluded; event |
| `dispute_pickup(p_transaction_id, p_reason)` | Buyer only | Transaction AWAITING_BUYER_CONFIRMATION | Transaction DISPUTED; Listing stays RESERVED; event |
| `finalize_unconfirmed_pickup(p_transaction_id)` | Seller only | AWAITING_BUYER_CONFIRMATION, stored deadline reached, not disputed | Transaction COMPLETED; Listing SOLD; conversations concluded; event |

## Domain invariants

- A seller chooses the buyer from an existing listing-specific Conversation. Buyer identity is **never** supplied arbitrarily by the browser.
- A Listing may have multiple historical cancelled Transactions but at most **one active** Transaction at any time.
- Active Transaction statuses are `RESERVED`, `AWAITING_BUYER_CONFIRMATION`, `DISPUTED`.
- The partial unique index is a database-level backstop; transitions also take the Listing row lock.
- Reservation status changes are atomic with Transaction persistence.
- Cancellation returns the Listing to ACTIVE and immediately enables new Conversations.
- After seller-reported pickup, the buyer must confirm or dispute; ordinary cancellation is no longer permitted.
- A dispute prevents seller timeout finalization. The item stays RESERVED pending admin resolution.
- Only a successful completion changes Listing state to SOLD.
- Listing lifecycle and admin-controlled moderation remain separate.
- Timeouts are measured against the **stored deadline**, not an ever-changing configuration value.
- Chat history remains available after sale. The original conversations become read-only.
- Reviews remain unavailable until a Transaction is `COMPLETED`; implementing Reviews is a future slice.

## Open implementation decisions

- Which transactions may be edited/cancelled when an account or shop is suspended? Initial candidate permits participant cancellation and buyer confirmation/dispute based on participation and state; admin tooling still needed for exceptional cases.
- Confirmation-window default: candidate stores `3 days` as a provisional operator-only setting, not a finalized promise to users.
- Admin dispute-resolution operations are deferred. A disputed item will remain RESERVED until that work is implemented.
- Whether seller-finalization should be automatic vs manually initiated: **candidate is manual** (seller action after deadline), matching the original product direction.
