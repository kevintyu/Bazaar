# Marketplace Domain Operations v0.1

## Purpose

Define business actions exposed by the application.

The UI should request domain actions instead of arbitrarily mutating lifecycle fields.

Preferred pattern:

```text
UI intent
→ domain operation
→ validate
→ atomic database change
→ domain result
```

## Current vertical slice

```text
User
→ activate selling
→ Shop
→ Listing draft
→ publish Listing
→ public marketplace browsing
```

## Queries

Initial queries:

```text
getCurrentProfile()
getMyShops()
getShop()
getPublicShop()
getListing()
getPublicListing()
getShopListings()
browseListings()
```

Queries read state and should not perform hidden lifecycle mutations.

## Commands

Initial state-changing operations:

```text
activateSelling()
updateShop()
updateShopLocation()
createListing()
updateListing()
addListingImage()
removeListingImage()
publishListing()
removeListing()
```

Future:

```text
startConversation()
sendMessage()
reserveListing()
cancelTransaction()
markPickedUp()
confirmPickup()
disputePickup()
finalizeTimedOutTransaction()
submitReview()
blockUser()
reportListing()
reportUser()
reportMessage()
reportReview()
```

## activateSelling()

### Goal

Convert a buyer-only User into a seller and create their initial Shop.

### Preconditions

- authenticated;
- Profile exists;
- Profile status ACTIVE;
- selling is not already enabled.

### Inputs

Conceptually:

```ts
interface ActivateSellingInput {
  shopName: string;
  shopDescription?: string;

  location: {
    countryCode: string;
    administrativeArea?: string;
    locality?: string;
    postalCode?: string;
    formattedAddress?: string;
    latitude?: number;
    longitude?: number;
    publicPrecision:
      | "exact"
      | "neighborhood"
      | "city"
      | "general_area";
  };
}
```

### Atomic operation

```text
BEGIN

lock Profile

validate account

create Location

create Shop

set Profile.selling_enabled = true

COMMIT
```

If any step fails, roll back all steps.

Ownership must come from `auth.uid()`.

The browser must not provide `owner_user_id`.

## updateShop()

May update seller-controlled presentation fields such as:

- display name;
- description;
- profile image;
- banner.

Must not allow normal clients to directly mutate:

- `owner_user_id`;
- status;
- domain-controlled fields.

## updateShopLocation()

Location is sensitive and should have a dedicated operation.

Validate:

- country code;
- precision;
- coordinates supplied as both latitude and longitude or neither;
- latitude and longitude ranges.

## createListing()

### Goal

Create a new Listing in `DRAFT`.

### Preconditions

- authenticated;
- selling enabled;
- account ACTIVE;
- Shop exists;
- current User owns Shop;
- Shop ACTIVE.

### Result

```text
Listing.status = DRAFT
Listing.moderation_status = CLEAR
```

Draft does not automatically publish.

## updateListing()

v1 editable fields:

- title;
- description;
- asking price;
- currency;
- category;
- condition;
- optional location override.

State rules:

- DRAFT: freely editable;
- ACTIVE: editable;
- RESERVED: rules TBD;
- SOLD: mostly immutable;
- REMOVED: limited or none.

## Listing images

Suggested flow:

```text
create Listing draft
→ receive listingId
→ upload Storage object
→ create listing_images row
```

Suggested Storage path:

```text
listings/{listingId}/{imageId}.jpg
```

Do not use a user-controlled filename as the authoritative object identifier.

## publishListing()

### Preconditions

- current User owns Listing Shop;
- Profile ACTIVE;
- Shop ACTIVE;
- Listing status DRAFT;
- moderation CLEAR.

Initial publication requirements may include:

- title;
- asking price;
- currency;
- category;
- condition;
- at least one image;
- effective location.

### Effective location

```text
Listing.location_override
or
Shop.default_location
```

If no effective location exists, publication fails.

### Future policy check

Publication is the natural boundary for:

```text
effective location
→ jurisdiction
→ platform + jurisdiction policy
```

### Atomic operation

```text
BEGIN

lock Listing

validate ownership/state/content

validate image requirement

resolve effective location

validate policy

set status ACTIVE
set published_at

COMMIT
```

## removeListing()

### ACTIVE Listing

Seller may remove.

Collect structured reason.

Operation:

```text
ACTIVE → REMOVED
```

Set:

- `removal_reason`;
- `removed_at`.

### DRAFT Listing

Draft may be permanently discarded because it has never been public.

### RESERVED Listing

Future rule:

- cannot directly remove;
- must cancel Transaction first;
- Listing returns to ACTIVE;
- seller may then remove.

## Public reads

Do not return raw database rows directly.

Use public DTOs that intentionally exclude sensitive/internal fields.

### Public Shop should not expose

Unless explicitly allowed by location precision:

- exact formatted residential address;
- raw coordinates;
- internal status metadata;
- owner-sensitive identifiers.

### Public Listing should not expose

- raw location IDs;
- exact private location;
- moderation internals;
- internal removal metadata;
- owner-only control fields.

## Error model

Prefer stable domain error codes.

Examples:

```text
UNAUTHENTICATED
ACCOUNT_NOT_ACTIVE
SELLING_ALREADY_ENABLED
SELLING_NOT_ENABLED
SHOP_NOT_FOUND
SHOP_NOT_OWNED
SHOP_NOT_ACTIVE
LOCATION_REQUIRED
INVALID_LOCATION
LISTING_NOT_FOUND
LISTING_NOT_OWNED
INVALID_LISTING_STATE
LISTING_INCOMPLETE
IMAGE_REQUIRED
POLICY_VIOLATION
INVALID_PRICE
INVALID_CURRENCY
INVALID_CATEGORY
```

Translate these into user-facing wording in the UI layer.

## Testing expectations

For each domain operation test:

- success;
- unauthenticated request;
- non-owner;
- invalid state;
- missing data;
- repeated submission;
- rollback on failure.

Critical atomicity examples:

### Seller activation

If Shop creation fails:

```text
selling_enabled must remain false
```

### Publication

If validation fails:

```text
Listing must remain DRAFT
```

### Future reservation

If Transaction creation fails:

```text
Listing must remain ACTIVE
```

### Future completion

If Transaction completion fails:

```text
Listing must remain RESERVED
```

## Current implementation milestone

Implement first:

```text
profiles
locations
shops
```

with:

```text
activate_selling()
```

Then:

```text
listings
listing_images
```

with:

```text
create_listing()
publish_listing()
remove_listing()
```

Do not introduce messaging/Transaction/Review complexity until this vertical slice works end-to-end.

## Messaging operations (Migration 003)

Owner-confirmed 2026-11-11: a RESERVED Listing blocks new Conversations while
all existing Conversations may continue, including those of other buyers.

### startConversation() / start_conversation()

Requires an authenticated active buyer distinct from the seller, an ACTIVE,
CLEAR Listing, and an eligible Shop/seller. Buyer and seller identities are
system-derived. Repeated requests return the existing buyer/listing Conversation
only while these start eligibility checks pass. Calling start_conversation on a
RESERVED Listing is rejected even for an existing buyer; reopen by reading the
existing Conversation ID instead. It does not delete or conclude that Conversation.

### sendMessage() / send_message()

Only a Conversation participant may send. New text requires an active caller,
active Conversation, ACTIVE or RESERVED Listing, CLEAR moderation and eligible
Shop/seller. All existing buyers may continue during RESERVED. SOLD and REMOVED
conclude Conversations and prevent new messages; participant history remains.
Exact retries of an already committed sender/client-message-ID and body return
the original message ID even after conclusion. Changed body or Conversation
under the same sender/client-message-ID is rejected.

Cancellation returning the Listing to ACTIVE reopens eligibility for new
Conversations. Per-user archive/hide retains history and does not alter the
other participant's inbox. No applied migration is rewritten for this decision.

## Reservation/cancellation foundation (Migration 004, implemented locally)

### reserveListing() / reserve_listing(p_conversation_id, p_request_id)

Seller-only. Identities derive from the existing Conversation and Listing and
`auth.uid()`. Requires ACTIVE/CLEAR Listing, active Conversation, eligible
Shop/seller and active buyer. Atomically create a RESERVED Transaction, append
its reservation audit event, and move Listing ACTIVE -> RESERVED. A unique index
protects the single active Transaction even under competing requests.

The client creates one request UUID per reservation intent and preserves it on
transport retries. The (seller, request UUID) receipt is durable: exact retry
returns the original Transaction ID even after cancellation; a different
Conversation under the same key fails. A new reservation after cancellation
uses a new request UUID. A retry never reserves again or mutates newer history.

### cancelTransaction() / cancel_transaction(p_transaction_id, p_reason = null)

Either participant may cancel a RESERVED Transaction before pickup. Atomic
cancellation records actor/time/reason and an audit event, changes Transaction
to CANCELLED, and returns Listing to ACTIVE. Cancelled records remain immutable;
a later reservation creates a different Transaction. Nonparticipants cannot
read or mutate the selected buyer's Transaction or its events.

Owner-confirmed 2026-11-11: new cancellation fails with TRANSACTION_RESTRICTED
if either participant account is not ACTIVE, the Shop/seller is ineligible, or
Listing moderation is not CLEAR. No automatic cancellation or history deletion
occurs; participants retain read access. Clear restrictions before retrying.

Reason is optional free text for now; preselected options are deferred. The API
accepts up to 1,000 characters, trims surrounding spaces, and maps empty text to
null. Exact repeat by the same cancellation actor with the same normalized reason
returns the existing receipt, including after a newer reservation. Another actor
or changed reason receives CANCELLATION_REQUEST_CONFLICT; history is not rewritten.
Returning an existing receipt is not a new cancellation and bypasses new-action
eligibility checks.

Lock order is Listing -> Transaction -> Conversation when applicable. Direct
client writes to Transactions/events are revoked; RLS permits participant reads.
The append-only audit event and Listing change share the RPC database transaction.

### Explicitly not enabled by the foundation

No pickup, buyer-confirmation, dispute, timeout or seller-finalization RPC exists.
Although the status enum reserves those names, a CHECK constraint and transition
guard allow only RESERVED/CANCELLED in this phase. A future migration must add
approved policies, metadata and transitions. No default timeout was selected.
