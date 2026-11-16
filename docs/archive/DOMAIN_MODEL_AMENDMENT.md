> Historical record, organized 2026-11-15. See the [folder index](README.md). Original proposals, commands, results,
> and paths below describe their original context, not current instructions.
> For current policy see [Domain Model](../DOMAIN_MODEL.md) and [Domain Operations](../DOMAIN_OPERATIONS.md).
> Seller-initiated pickup and timeout-completion proposals are superseded.

# Domain Model v1 — Approved Conversation Rule

**Decision status: APPROVED by product owner (November 11, 2026).**

Merge into `docs/DOMAIN_MODEL.md` and update `docs/DOMAIN_OPERATIONS.md`. Do not overwrite unrelated repository content or previously applied migrations.

## New Conversations

- A buyer may initiate a new listing-specific Conversation only while the Listing is `ACTIVE`, its moderation status is `CLEAR`, and its Shop and seller account are eligible.
- A `RESERVED` Listing **cannot receive new Conversations**.
- A `DRAFT`, `SOLD`, or `REMOVED` Listing cannot receive new Conversations.

## Existing Conversations

- Reserving a Listing **does not close existing Conversations**.
- Existing Conversations, including those with buyers who did not secure the reservation, may continue while the Listing is `RESERVED` (unless moderation/account restrictions apply).
- The reserved buyer continues using their original listing-specific Conversation to arrange pickup.
- Cancelling a reservation returns the Listing to `ACTIVE`; new Conversations may start again.
- Once the Listing becomes `SOLD` or `REMOVED`, its Conversations are concluded and read-only. Their history is retained for the participants.
- Each participant may independently archive or hide a Conversation from their own inbox; doing so does not delete marketplace history.

## Separation of responsibility

- Reservation and sale are **Transaction** state changes, not Message/Conversation data mutations.
- Seller initiates reservation within a Conversation; the actor's identity is taken from the authenticated account.
- There is no Offer entity and no separate Reservation entity.

## Product decisions still pending (do NOT silently resolve)

- Exact buyer pickup-confirmation timeout. Migration 004 candidate uses an operator-controlled **provisional** three-day default, stored with each transaction when pickup is marked.
- Dispute review/resolution by admins (the initial dispute action only freezes the Transaction in `DISPUTED`).
- Whether additional blocking/reporting restrictions apply to active/reserved Transactions.
- Whether completed transactions permit a separate post-sale support channel. The confirmed behavior for the original Listing Conversations is read-only once SOLD.
