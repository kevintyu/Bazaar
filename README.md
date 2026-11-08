# Marketplace — Seller UI vertical slice

This Next.js/TypeScript seller workflow is integrated with Domain Model v1 and
Supabase Migrations 001 and 002. The supplied App Router routes and browser-session
authentication have been preserved. Public pages use Migration 002's sanitized
RPCs, while seller content reads and edits remain protected by RLS.

See [the integration report](docs/SELLER_UI_INTEGRATION.md) for changes, validation,
and remaining limitations.

## Included routes

| Route | Purpose |
|---|---|
| `/auth` | Minimal email/password sign in / registration |
| `/sell` | Seller home and shop selection |
| `/sell/start` | Seller activation and first shop creation |
| `/sell/shops/[shopId]/listings` | Owner's listing dashboard |
| `/sell/shops/[shopId]/listings/new` | Create draft |
| `/sell/shops/[shopId]/listings/[listingId]` | Edit draft, photos, publish |
| `/browse` | Public active listings |
| `/listing/[listingId]` | Public item page |
| `/shop/[shopId]` | Public shop with eligible active listings |
| `/api/listings/[listingId]/images/[imageId]` | Public signed-image redirect with server-side authorization |

## Prerequisites

1. A Next.js 16 / React 19 / TypeScript application (or adapt these files to your existing framework).
2. Existing Migrations 001 and 002 have been reviewed, tested, and applied to a **development** Supabase database.
3. Supabase Auth is configured; email confirmation behavior and allowed redirect URLs checked.
4. A private `listing-images` Storage bucket from Migration 002.
5. Server-only Supabase secret/service key for the public image redirect route. **Never expose it to the browser.**
6. Seller has a Shop created through `activate_selling()`, or uses `/sell/start` to create one.

## Running as a standalone Next project

```bash
npm install
cp .env.local.example .env.local
# Fill in the actual values in .env.local
npm run dev
```

The integration was tested against the disposable local `bazaar-migration-test`
Supabase stack. The ignored `.env.local` created during integration contains only
that local stack's configuration. No hosted deployment was performed.

```bash
npm run typecheck
npm run build
npm run test:db
npx playwright install chromium
npm run test:e2e
```

Browser tests start the production build automatically on port 3000, use only
`http://127.0.0.1:54321`, and leave UUID-isolated fixtures in the disposable database.
Stop any other server on port 3000 before running them. They use the configured
local Docker container for negative-case fixtures; never point tests at production.

## Flow

1. Sign in or sign up at `/auth`.
2. Go to `/sell`; create a shop if none exists.
3. Click "New listing".
4. Enter title and price; click "Save draft". The listing is created using the `create_listing` RPC. This step must precede uploads because object keys include the listing ID.
5. Add photos. Each file uploads to `listing-images/<listing-id>/<image-id>.jpg|png|webp`, then `attach_listing_image` validates and records the object.
6. Set category and condition, then publish. The editor saves form values, then calls `publish_listing`.
7. The active Listing is visible at `/browse`, `/listing/[listingId]`, and the shop page.
8. The seller may remove an ACTIVE listing by choosing a structured reason from the dashboard; it uses `remove_listing`.
9. Drafts may be discarded after removing their images, via `discard_draft_listing`.

## Current UI limitations

- Owner operations use the existing browser Supabase session. Public reads use a server-side **anon** client and sanitized RPCs; raw Listing table reads are intentionally unavailable to anon. No cookie/SSR auth setup existed to replace.
- The public image endpoint uses an elevated server-only credential, but authorizes **every** requested image by checking Listing ACTIVE + CLEAR, Shop active, User active and selling enabled, and image-to-listing ownership. IDs, not arbitrary paths, are accepted.
- Returned signed URLs expire after 60 seconds; CDN/browser caches can still briefly retain images. Signed URLs can't be instantly revoked just by removing the Listing. Take this into account for moderation.
- Seller-owned image previews use a 10-minute signed URL.
- Public Shop visibility is temporarily limited to shops with at least one publicly eligible Listing because Migration 001's Shop RLS does not verify owner-account status. Replace this with a privacy-safe public-Shop query when ready.
- No precise public location labels yet. Implement a sanitized location API before showing geodata.
- Per-listing location overrides are supported by the backend but **not yet editable in this UI**; a secure owner-location selector is a separate feature.
- Categories are illustrative options only, not a legal policy engine. **Do not launch real listings before implementing prohibited-item/category enforcement and moderation.**
- Messaging, reservation, transactions and reviews are intentionally not part of this UI slice.
- For production, add request-level rate limiting and abuse protection to the signed-image route, richer image validation, abandoned Storage object cleanup, and standardized error handling.
- Buyer sign-in via this form is only the basic email/password path; email verification, recovery, OAuth, MFA and account management are future work.
- `NUMERIC(12,2)` prices are passed as JS numbers in this starter. Use decimal-safe parsing or minor units in production before adding payments.
- The starter does not yet impose an image-count limit or support drag-to-reorder.
- Browse shows the newest 40 eligible listings. Shop pages traverse the existing RPC's cursor pages to find up to 40 matching listings, so an older shop is not incorrectly hidden by a global limit. A dedicated shop-filtered public RPC is a future scalability improvement.
- Failed orphan cleanup can be retried in the editor, and draft discard also attempts cleanup. Owner preview URLs last 10 minutes; reload after expiry.

## Security model

The browser calls **explicit domain RPCs** to modify Listing states. It cannot directly mutate `listings.status`, `published_at`, or moderation fields. Metadata edits are limited to granted content columns.

The `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY` is used only inside `src/lib/supabase/admin.ts`, which is protected with the server-only import. Never create an `NEXT_PUBLIC_*` variable for this key.

## What Codex should test

See `docs/CODEX_SELLER_UI_TASK.md` and `docs/QA_CHECKLIST.md`.

## Product correctness caveat

The listing publisher checks the presence of a category, but **not** whether the category is prohibited globally or in the listing's jurisdiction. Treat the app as a local-development prototype until that policy is in place.
