# Marketplace Engineering Instructions

## Project goal

Build a peer-to-peer marketplace centered around individual sellers operating personal shops.

The product should make local person-to-person commerce feel more like browsing trusted individual storefronts than a generic classifieds feed.

## Current stack direction

- React / Next.js
- TypeScript
- Supabase
- PostgreSQL
- PostGIS
- Supabase Auth
- Supabase Storage
- Row Level Security (RLS)

## Source of truth

Before implementing or changing domain behavior, read:

- `docs/DOMAIN_MODEL.md`
- `docs/ER_MODEL.md`
- `docs/DATABASE_SCHEMA.md`
- `docs/DOMAIN_OPERATIONS.md`

Do not silently change established domain rules for implementation convenience.

If an implementation problem suggests the domain model should change:

1. explain the conflict;
2. propose the smallest domain change;
3. do not implement that domain change until it is explicitly accepted and documented.

## Core domain principles

- One `User` represents one individual identity.
- All users may buy.
- Selling is an optional capability.
- Enabling selling creates the user's first `Shop`.
- A user may eventually own multiple Shops.
- A `Shop` is the seller's public selling profile.
- `Listing`s belong to Shops, not directly to Users.
- Reputation belongs permanently to the User identity.
- Buyer reputation and seller reputation are separate role-based views of the same User's review history.
- Negotiation is free-form through private Conversations.
- There is no formal `Offer` entity in v1.
- There is no separate `Reservation` entity in v1.
- A `Transaction` begins when a seller reserves a Listing for a buyer.
- Only one active Transaction may reserve a Listing at a time.
- Exact location data must not be publicly exposed by default.
- A Shop has a default location.
- A Listing may override its Shop location.
- Meetup details are arranged in chat and are not structured domain data in v1.
- Listing lifecycle state and moderation state are separate concerns.
- Historical marketplace records should generally be preserved rather than destructively deleted.
- State transitions should be implemented as explicit domain operations, not arbitrary client-side row updates.

## Listing lifecycle

Core Listing states:

- `DRAFT`
- `ACTIVE`
- `RESERVED`
- `SOLD`
- `REMOVED`

Moderation status is separate:

- `CLEAR`
- `UNDER_REVIEW`

Important rules:

- Seller publishes `DRAFT -> ACTIVE`.
- Seller reserves an `ACTIVE` Listing for exactly one buyer.
- Reservation creates a Transaction and moves `ACTIVE -> RESERVED`.
- A reserved Listing cannot be directly removed.
- Reservation must be cancelled first, returning the Listing to `ACTIVE`.
- Successful Transaction completion moves `RESERVED -> SOLD`.
- `REMOVED` is a soft removal for Listings that have been publicly active.
- Drafts may be permanently discarded because they have no public marketplace history.

## Transaction lifecycle

Core Transaction states:

- `RESERVED`
- `AWAITING_BUYER_CONFIRMATION`
- `COMPLETED`
- `CANCELLED`
- `DISPUTED`

Important rules:

- Seller creates the Transaction by reserving a Listing for a specific buyer.
- Buyer or seller may cancel before pickup.
- Seller marks the item as picked up.
- This starts the buyer-confirmation window.
- Buyer may confirm pickup or dispute.
- Buyer confirmation completes the Transaction and marks the Listing sold.
- After a configurable timeout, the seller may eventually be allowed to finalize if the buyer does not respond.
- Exact timeout duration is intentionally TBD.

## Conversations

- Every Conversation originates from one specific Listing.
- A Conversation has exactly one buyer and one seller.
- A buyer should normally have at most one Conversation per Listing.
- Negotiation is free-form.
- The seller has a "Reserve for this buyer" action inside the Listing Conversation.
- Conversation deletion should generally mean hidden from that participant's inbox, not immediate destructive deletion.
- Structured Transaction data is the official receipt.
- Conversation history is supporting communication evidence.

## Reviews and reputation

- Reviews are only available after a `COMPLETED` Transaction.
- Both buyer and seller may review each other.
- Each participant may leave at most one Review of the other participant per Transaction.
- Reviews belong to User identities.
- Reviews record the role of the reviewed user: `BUYER` or `SELLER`.
- Reputation should be presented separately for buyer behavior and seller behavior.
- Creating another Shop does not reset reputation.
- Reviews should initially be blind:
  - submitted reviews remain hidden from the other participant;
  - reviews become public once both parties submit or the review window expires.
- Exact review-window duration is TBD.

## Locations and privacy

- Exact location records are sensitive.
- Do not expose exact coordinates or formatted residential addresses through normal public Shop or Listing reads.
- Public location should respect seller-selected precision.
- Effective Listing location is:
  1. Listing location override, if present;
  2. otherwise Shop default location.
- Effective Listing location determines jurisdiction for future marketplace-policy rules.

## Marketplace policy

- Platform-wide rules and jurisdiction-specific rules are conceptually separate.
- Jurisdiction is determined by effective Listing location.
- Meetup location is not used for automated policy enforcement in v1 because meetup details are only discussed in chat.
- Do not build a large policy engine until Listing categories and MVP behavior are stable.

## Database rules

- PostgreSQL is the source of truth for relational integrity.
- Use RLS for authorization.
- Use explicit RPC/database transactions for atomic lifecycle transitions.
- Never trust a user ID supplied by the browser when `auth.uid()` can determine the acting user.
- Protect domain-controlled fields such as:
  - Listing status
  - moderation status
  - transaction status
  - publication timestamps
  - review publication timestamps
- Avoid unrestricted client updates to lifecycle fields.
- Prefer soft removal when marketplace history matters.
- Preserve cancelled Transaction history rather than overwriting it.

## Architectural pattern

Prefer:

UI intent
→ domain operation
→ validate business rules
→ atomic database change
→ return domain result

Avoid:

UI
→ arbitrary direct row mutation

## Code organization

Prefer feature-based organization.

Example:

```text
src/
├── features/
│   ├── account/
│   ├── shops/
│   └── listings/
```

Separate:

- commands/services that mutate state;
- queries that read state;
- validators;
- TypeScript types.

Keep business rules out of React components.

## Validation

Use validation at multiple levels:

- form/UI validation for UX;
- application/domain validation for business rules;
- database constraints for integrity;
- RLS for authorization.

## Testing expectations

For every important domain operation, test:

- happy path;
- unauthenticated access;
- ownership violations;
- invalid state;
- missing required data;
- duplicate/repeated submissions;
- atomic rollback behavior.

Especially protect against partial state updates.

## Current implementation phase

Implement the first vertical slice:

User
→ activate selling
→ create first Shop
→ create Listing draft
→ edit Listing
→ publish Listing
→ view Listing publicly
→ browse public Shop/Listings

Do not implement yet:

- messaging;
- reservations;
- transactions;
- reviews;
- payments;
- shipping;
- auctions;
- subscriptions;
- promoted listings.

## Current backend milestone

The next backend work should start from:

- `profiles`
- `locations`
- `shops`

Then add:

- `listings`
- `listing_images`

Initial seller/listing domain operations:

- `activate_selling()`
- `create_listing()`
- `publish_listing()`
- `remove_listing()`

## Working style for Codex

Before making changes:

1. inspect the repository;
2. read this file and the docs listed above;
3. summarize the current state;
4. propose the smallest implementation plan.

When implementing:

- keep changes scoped;
- avoid unrelated refactors;
- run relevant tests/checks;
- report the exact files changed;
- explain any migration or schema implications;
- surface domain conflicts instead of silently resolving them.
