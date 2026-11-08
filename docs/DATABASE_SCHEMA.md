# Marketplace Database Schema v0.1

## Platform

Target database:

- PostgreSQL
- Supabase
- PostGIS for geographic search

## Authentication

Use:

```text
auth.users
```

for authentication.

Use:

```text
public.profiles
```

for marketplace identity.

## Tables

### profiles

Conceptual fields:

```text
id
display_name
avatar_url
selling_enabled
status
created_at
updated_at
```

Rules:

- `id` references `auth.users(id)`;
- all users may buy;
- `selling_enabled` controls seller capability;
- status is domain-controlled.

### locations

Conceptual fields:

```text
id
owner_user_id
country_code
administrative_area
locality
postal_code
formatted_address
coordinates
public_precision
created_at
updated_at
```

Recommended geographic type:

```sql
geography(Point, 4326)
```

Exact locations are private.

Public Shop/Listing reads should return a sanitized location representation.

### shops

Conceptual fields:

```text
id
owner_user_id
display_name
description
profile_image_url
banner_image_url
default_location_id
status
created_at
updated_at
```

No unique constraint on `owner_user_id`.

Multiple Shops per User are structurally supported.

### listings

Conceptual fields:

```text
id
shop_id
title
description
asking_price
currency
category_key
condition
status
moderation_status
location_override_id
removal_reason
published_at
removed_at
created_at
updated_at
```

Listing lifecycle enum:

```text
draft
active
reserved
sold
removed
```

Moderation enum:

```text
clear
under_review
```

### listing_images

```text
id
listing_id
storage_path
alt_text
sort_order
created_at
```

Prefer a separate table over an image array.

### conversations

```text
id
listing_id
buyer_user_id
seller_user_id
status
created_at
concluded_at
```

Global Conversation states:

```text
active
concluded
```

Recommended uniqueness:

```text
UNIQUE(listing_id, buyer_user_id)
```

### conversation_user_states

```text
conversation_id
user_id
archived_at
hidden_at
last_read_at
```

Primary key:

```text
(conversation_id, user_id)
```

### messages

```text
id
conversation_id
sender_user_id
type
body
created_at
deleted_at
```

Initial message types:

```text
text
system
```

### transactions

```text
id
listing_id
shop_id
conversation_id
buyer_user_id
seller_user_id
status
reserved_at
seller_marked_picked_up_at
buyer_confirmation_deadline
buyer_confirmed_at
seller_finalized_at
cancelled_at
cancelled_by_user_id
cancellation_reason
disputed_at
completed_at
created_at
updated_at
```

Transaction states:

```text
reserved
awaiting_buyer_confirmation
completed
cancelled
disputed
```

Only one active Transaction may exist per Listing.

Recommended partial unique index:

```sql
create unique index one_active_transaction_per_listing
on public.transactions (listing_id)
where status in (
  'reserved',
  'awaiting_buyer_confirmation',
  'disputed'
);
```

### reviews

```text
id
transaction_id
reviewer_user_id
reviewed_user_id
reviewed_role
rating
comment
submitted_at
published_at
updated_at
deleted_at
```

Role:

```text
buyer
seller
```

Constraints:

- rating 1–5;
- reviewer cannot review self;
- one Review per reviewer per Transaction.

### favorites

```text
user_id
listing_id
created_at
```

Primary key:

```text
(user_id, listing_id)
```

### blocks

```text
blocker_user_id
blocked_user_id
created_at
```

Primary key:

```text
(blocker_user_id, blocked_user_id)
```

Blocker cannot equal blocked User.

### reports

Recommended target-specific nullable foreign keys:

```text
id
reporter_user_id
reported_user_id
listing_id
conversation_id
message_id
review_id
reason_code
details
status
created_at
resolved_at
```

Exactly one target should be populated.

Recommended PostgreSQL check:

```sql
check (
  num_nonnulls(
    reported_user_id,
    listing_id,
    conversation_id,
    message_id,
    review_id
  ) = 1
)
```

## Database-enforced rules

Prefer DB constraints for:

- valid foreign keys;
- one Shop owner per Shop;
- one Shop per Listing;
- buyer/seller cannot be the same User in a Conversation/Transaction;
- one buyer/listing Conversation;
- one active Transaction per Listing;
- Review rating range;
- no self-review;
- one Review per reviewer per Transaction;
- one Favorite per User/Listing;
- no self-block;
- exactly one Report target.

## Application/domain-enforced rules

Backend/domain operations should enforce:

- seller owns the relevant Shop;
- Conversation seller matches Shop owner;
- Listing is in a valid state for each transition;
- reservation creates Transaction + updates Listing atomically;
- cancellation updates Transaction + Listing atomically;
- pickup confirmation updates Transaction + Listing atomically;
- Reviews only after completed Transactions;
- reviewer/reviewed users are Transaction participants;
- jurisdiction policy checks before publication.

## RLS responsibilities

RLS should enforce row authorization, not the full lifecycle state machine.

Examples:

- Users update their own Profile;
- only Location owner can access exact Location row;
- active Shops may be publicly readable;
- owner edits Shop;
- public sees allowed Listings only;
- only Conversation participants read Messages;
- only Transaction participants read Transaction rows;
- only published Reviews are visible to other users;
- only Favorite owner reads/writes Favorites;
- only blocker manages their own Block rows.

## Protected/domain-controlled fields

Do not give normal clients unrestricted mutation access to:

- account status;
- selling capability;
- Shop status;
- Listing lifecycle status;
- Listing moderation status;
- `published_at`;
- `removed_at`;
- Transaction status;
- Review `published_at`.

Prefer explicit domain RPCs or trusted server operations.

## Current implementation order

### Phase 1

```text
profiles
locations
shops
```

Implement:

- authentication profile creation;
- seller activation;
- Shop profile;
- location privacy.

### Phase 2

```text
listings
listing_images
favorites
```

Implement:

- draft Listing;
- edit Listing;
- publish Listing;
- public Listing;
- public Shop;
- marketplace browse.

### Phase 3

```text
conversations
conversation_user_states
messages
```

### Phase 4

```text
transactions
```

### Phase 5

```text
reviews
blocks
reports
```
