# Marketplace Engineering Instructions

## Project goal

Build a peer-to-peer marketplace centered around individual sellers
operating personal shops.

## Architecture

Frontend:
- React / Next.js
- TypeScript

Backend:
- Supabase
- PostgreSQL
- PostGIS
- Supabase Auth
- Supabase Storage

## Source of truth

Before implementing domain behavior, read:

- docs/DOMAIN_MODEL.md
- docs/ER_MODEL.md
- docs/DATABASE_SCHEMA.md
- docs/DOMAIN_OPERATIONS.md

Do not change established domain rules without explicitly documenting
the proposed change.

## Core domain rules

- One User represents one individual identity.
- All Users may buy.
- Selling is an optional capability.
- Enabling selling creates the first Shop.
- A User may eventually own multiple Shops.
- Listings belong to Shops.
- Reputation belongs to Users, not Shops.
- Negotiation is free-form through Conversations.
- Reservation creates a Transaction.
- There is no Offer entity.
- There is no separate Reservation entity.
- Exact location data must not be publicly exposed by default.
- Lifecycle state transitions should use explicit domain operations.

## Database rules

- PostgreSQL is the source of truth.
- Use RLS for authorization.
- Use RPC/database transactions for atomic lifecycle changes.
- Never trust user IDs supplied by the browser when auth.uid() can
  determine the acting user.
- Avoid destructive deletes where marketplace history matters.

## Coding standards

- TypeScript
- Prefer feature-based organization.
- Separate commands from queries.
- Keep business logic out of React components.
- Validate inputs at application boundaries.
- Add tests for state transitions and authorization.

## Current implementation phase

Implement the first vertical slice:

User
→ activate selling
→ Shop
→ Listing draft
→ publish Listing
→ public marketplace browsing

Do not implement messaging, transactions, reviews, or payments yet.