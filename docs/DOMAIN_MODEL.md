# Marketplace Domain Model v1

## Purpose

This document defines the core business model for a peer-to-peer marketplace built around individual sellers operating personal Shops.

It describes the domain independently of React, SQL, Supabase, or API implementation details.

## Core terminology

### User

A `User` represents one individual identity and account.

All users may buy.

Selling is an optional capability that can be enabled later without creating a second account.

A single User may act:

- as a buyer in one transaction;
- as a seller in another;
- as both across the marketplace.

### Buyer

A Buyer is a User acting as the prospective purchaser in relation to a particular Listing or Transaction.

Buyer is a role, not a separate entity.

### Seller

A Seller is a User with selling enabled who owns at least one Shop.

Seller is also a role, not a separate identity.

## Core entities

- `User`
- `Shop`
- `Listing`
- `Conversation`
- `Message`
- `Transaction`
- `Review`
- `Favorite`
- `Report`
- `Block`

Possible future entities, intentionally excluded from the core v1 model:

- `Notification`
- `ModerationAction`
- `ShopEntitlement`
- `Subscription`
- `Payment`

## High-level relationships

```text
User
├── owns → Shop
│          └── contains → Listing
│                         ├── Conversation
│                         │   └── Message
│                         └── Transaction
│                             └── Review
├── participates in → Conversation
├── participates in → Transaction
├── writes / receives → Review
├── favorites → Listing
├── creates → Report
└── blocks → User
```

## User rules

- All Users may buy.
- A buyer-only User may later enable selling.
- Enabling selling creates the first Shop.
- The architecture supports multiple Shops per User.
- The initial product rule grants one included Shop.
- Additional Shops may later require payment.
- Reputation belongs to the User identity, not to a Shop.

## Shop

A `Shop` is the seller's public marketplace selling profile.

It is attached to an individual User.

A Shop may contain:

- name;
- description;
- profile image;
- banner;
- default location;
- selling preferences;
- public seller reputation.

A Shop does not own reputation.

If a User later owns multiple Shops, all Shops remain connected to the same User-level seller reputation.

## Location model

A Shop has a default marketplace location.

The platform may privately know more precise location data than is shown publicly.

Public location precision may conceptually support:

- exact;
- neighborhood;
- city;
- general area.

A Listing inherits its Shop's location by default.

A Listing may override location.

Effective Listing location:

```text
Listing override
if absent:
Shop default location
```

Meetup location is not structured domain data in v1.

Buyer and seller arrange meetup/pickup details in private Conversation messages.

## Listing

A `Listing` represents one item offered for sale through a Shop.

A Listing belongs to exactly one Shop.

### Listing lifecycle

- `DRAFT`
- `ACTIVE`
- `RESERVED`
- `SOLD`
- `REMOVED`

There is intentionally no `EXPIRED` state in v1.

### Moderation status

Moderation is separate from lifecycle state.

Initial moderation states:

- `CLEAR`
- `UNDER_REVIEW`

A Listing may therefore be, for example:

```text
lifecycle = RESERVED
moderation = UNDER_REVIEW
```

### Draft

- not publicly visible;
- seller may edit freely;
- seller may permanently discard it.

### Active

- publicly available;
- may be discovered, favorited, and messaged about;
- seller may edit it;
- seller may reserve it;
- seller may remove it.

### Reserved

- reserved for exactly one buyer;
- only the seller initiates reservation;
- reservation is initiated from the specific buyer's Conversation;
- reservation creates a Transaction;
- only one active reservation/Transaction is allowed per Listing.

### Sold

A Listing becomes SOLD after its Transaction successfully completes.

### Removed

REMOVED is a soft removal for a Listing that has been publicly active.

Removed Listings:

- disappear from normal browsing;
- cannot receive new Conversations;
- may remain visible in limited form to users who previously favorited them;
- remain available internally for history, moderation, or analytics.

## Listing removal

An ACTIVE Listing may be removed by its seller.

A RESERVED Listing cannot be directly removed.

The seller must first cancel the reservation/Transaction, returning the Listing to ACTIVE.

The removal flow should collect a structured reason such as:

- sold elsewhere;
- no longer selling;
- item lost/damaged;
- duplicate/mistake;
- wants to change listing;
- other.

Removal reason is metadata, not a lifecycle state.

## Conversation

A `Conversation` is private communication between one buyer and one seller concerning one specific Listing.

Rules:

- every Conversation originates from one Listing;
- one Conversation has exactly one buyer and one seller;
- one buyer/listing pair should normally have one Conversation;
- negotiation is free-form;
- there is no formal Offer entity in v1.

Conversation deletion should usually mean hiding it from that participant's inbox rather than destructive deletion.

### Confirmed listing Conversation lifecycle

Owner-confirmed on 2026-11-11; this replaces the provisional RESERVED policy.

| Listing state | New Conversations | Existing Conversations |
|---|---|---|
| DRAFT | Blocked | Not applicable |
| ACTIVE | Allowed | Messaging allowed |
| RESERVED | Blocked | Messaging allowed for all existing participants |
| SOLD | Blocked | Concluded, read-only history |
| REMOVED | Blocked | Concluded, read-only history |

Reservation does not limit existing messaging to the selected buyer. Other buyers
who already have a Conversation may continue. Cancellation returning a Listing to
ACTIVE permits new Conversations again. Account, moderation and Shop eligibility
checks still apply; reservation does not bypass them.

Conversation history supports disputes and transaction history.

The structured Transaction is the official transaction record/receipt.

## Message

A `Message` belongs to a Conversation.

v1 may initially support:

- text messages;
- system messages.

Future types may include images or other attachments.

## Transaction

A `Transaction` begins when a seller reserves a Listing for a specific buyer.

There is no separate Reservation entity.

### Transaction states

- `RESERVED`
- `AWAITING_BUYER_CONFIRMATION`
- `COMPLETED`
- `CANCELLED`
- `DISPUTED`

### Reservation

Seller selects "Reserve for this buyer" inside a Listing Conversation.

This:

- creates the Transaction;
- associates the specific buyer;
- moves the Listing from ACTIVE to RESERVED.

### Cancellation

Before pickup, buyer or seller may cancel.

Cancellation:

- moves Transaction to CANCELLED;
- returns Listing to ACTIVE;
- preserves cancelled Transaction history.

Owner-confirmed 2026-11-11 for Migration 004:

- A new cancellation is blocked while either participant account or the Shop is
  restricted, or the Listing is UNDER_REVIEW. It can be retried after restrictions
  clear; restrictions do not destroy the Transaction or its readable history.
- Cancellation currently accepts optional free text. Preselected reason options
  will be defined later, alongside a free-text reason; no taxonomy is chosen yet.
- This restriction decision concerns cancellation only; pickup, confirmation,
  dispute and blocking policies remain open where previously marked TBD.

### Pickup confirmation

After handing over the item, seller selects "Mark as picked up."

Transaction moves:

```text
RESERVED → AWAITING_BUYER_CONFIRMATION
```

The buyer may:

- confirm pickup;
- dispute pickup.

Buyer confirmation:

```text
Transaction → COMPLETED
Listing → SOLD
```

Buyer dispute:

```text
Transaction → DISPUTED
```

If buyer does not respond, seller may eventually be allowed to finalize after a configurable timeout.

Exact timeout is TBD.

## Review and reputation

Reviews are available only after a `COMPLETED` Transaction.

Both parties may review each other:

- buyer reviews seller;
- seller reviews buyer.

Each participant may leave at most one Review of the other participant per Transaction.

Reviews remain tied to individual User IDs.

Reviews record the role being reviewed:

- `BUYER`
- `SELLER`

This supports separate reputation views:

```text
Buyer reputation
Seller reputation
```

Creating another Shop does not reset reputation.

### Blind reviews

Submitted Reviews should initially remain hidden from the other participant.

Reviews become visible when:

- both parties have submitted; or
- the review window expires.

Exact review-window duration is TBD.

Initial review format:

- 1–5 stars;
- optional written comment.

## Favorite

A Favorite represents a User saving a Listing.

A removed Listing may remain visible in Favorites in a limited "no longer available" form.

## Block

A Block represents one User blocking another.

Blocking should restrict future interaction.

Blocking must not automatically destroy:

- active Transactions;
- disputes;
- required history;
- moderation evidence.

Behavior during an active Transaction is TBD.

## Report

A Report represents a User flagging marketplace content or behavior.

Reportable targets may include:

- User;
- Listing;
- Conversation;
- Message;
- Review.

A Report does not automatically change the target's moderation state.

Moderation/admin systems determine enforcement.

## Marketplace policy

Marketplace policy conceptually has two layers:

- platform-wide rules;
- jurisdiction-specific rules.

Applicable jurisdiction is determined from effective Listing location.

Because meetup location exists only in chat in v1, meetup location is not used for automatic policy enforcement.

## Core invariants

### Identity

- every Shop belongs to a User;
- every Listing belongs to exactly one Shop;
- reputation belongs to User identity, not Shop identity.

### Listings

- a RESERVED Listing has only one active buyer;
- a RESERVED Listing cannot be directly removed;
- a SOLD Listing represents a completed Transaction;
- moderation state is separate from lifecycle state.

### Conversations

- every Conversation originates from exactly one Listing;
- every Conversation has one buyer and one seller;
- a buyer/listing pair should normally have only one Conversation.

### Transactions

- every Transaction concerns exactly one Listing;
- every Transaction has one buyer and one seller;
- a Transaction begins when seller reserves a Listing;
- only one active Transaction may reserve a Listing at a time.

### Reviews

- only COMPLETED Transactions permit Reviews;
- each participant may leave at most one Review of the other participant per Transaction;
- Reviews remain attached to User identity.

## Intentionally excluded from v1

- formal Offer entity;
- separate Reservation entity;
- integrated payments;
- shipping;
- auctions;
- automatic listing expiration;
- structured meetup scheduling;
- seller employee accounts;
- complex review categories;
- promoted listings;
- paid Shop entitlement implementation.

## Open questions

### Transactions

- exact buyer-confirmation timeout;
- exact seller-finalization behavior after timeout;
- dispute-resolution workflow;
- cancellation reason taxonomy;
- whether cancellation behavior affects visible or internal reputation.

### Reviews

- review submission window;
- exact blind-review publication timing;
- edit/delete policy;
- public responses.

### Listings

- whether removed Listings can be restored;
- whether sold Listings remain publicly visible;
- reserved Listing visibility;
- maximum image count;
- which fields become immutable after reservation.

### Conversations

- retention period;
- attachment types;
- any future separate post-sale support conversation type (listing Conversations remain read-only after SOLD).

### Blocking

- behavior during active Transactions.

### Shops

- additional-Shop billing;
- multi-Shop branding;
- future multi-user Shop management.

### Moderation

- admin action set;
- active-Transaction behavior during suspension;
- jurisdiction policy maintenance.
