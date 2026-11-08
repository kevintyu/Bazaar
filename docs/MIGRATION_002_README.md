# Migration 002 — Listings and Inventory

## Files

- `supabase/migrations/20261105_002_listings_inventory.sql`
- `supabase/tests/002_structural_checks.sql`
- `docs/MIGRATION_002_README.md`
- `docs/CODEX_MIGRATION_002_TASK.md`

## Prerequisite

Migration 001 must already have created `public.profiles`, `public.locations`, `public.shops`, `public.set_updated_at()`, and the account/shop/location enums. This migration adds a composite uniqueness constraint on `(shops.id, shops.owner_user_id)` and copies `owner_user_id` onto `listings` *only* for composite foreign-key enforcement. The domain still models `Shop → Listing`, not `User → Listing` ownership.

Do not apply directly to an existing database before reviewing overlapping migrations and the existing `listing-images` bucket. The SQL expects that bucket ID not to exist already.

## What Migration 002 adds

- `listing_status`, `listing_moderation_status`, `listing_condition`, `listing_removal_reason` enums
- `public.listings`, `public.listing_images`
- seller/location composite foreign keys
- `private` non-exposed schema with gated `SECURITY DEFINER` implementations
- public `SECURITY INVOKER` RPC wrappers:
  - `create_listing(...)`
  - `attach_listing_image(...)`
  - `detach_listing_image(...)`
  - `publish_listing(uuid)`
  - `remove_listing(uuid, reason, details)`
  - `discard_draft_listing(uuid)`
- listing and listing-image RLS
- a **private** Storage bucket named `listing-images`, size capped at 10 MiB per image, JPEG/PNG/WebP
- owner-only Storage upload/read/delete policies
- sanitized `get_public_listing` and cursor-based `browse_public_listings` RPCs

## Correct image upload flow

1. Seller calls `create_listing(...)`; result is a Listing UUID in `draft` state.
2. Client generates a UUID for the image, and uploads through the **Supabase Storage API** to `listing-images/<listing-uuid>/<image-uuid>.jpg` (or jpeg/png/webp). Use `upsert: false`.
3. Client calls `attach_listing_image({p_listing_id, p_image_id, p_extension, p_alt_text})`.
4. The RPC checks the actual Storage object exists, that its uploader is the authenticated seller, and that the seller owns the Listing.
5. To remove: call `detach_listing_image` first, then delete the returned storage path using the Storage API. If that second step fails, retry cleanup; image metadata and blob deletion cannot be atomic together.
6. Seller calls `publish_listing(...)`; the Listing must have category, condition, an effective location, and at least one attached image with a Storage object.

**Public listing images:** Because the bucket is private, normal public image URLs will not work. Build a trusted Next.js endpoint that first verifies the Listing is public (active + clear + active Shop and seller), then uses a server-only Supabase secret/service credential to create short-lived signed URLs. The signing endpoint must not accept arbitrary Storage paths, and the credential must never be sent to the browser. For owners' drafts, use authenticated signed URLs subject to owner access. A signed URL can remain usable until it expires even after removal, so keep expiry short.

**Image lifecycle:** Do not grant Storage object overwrites. Attached objects cannot be deleted through normal client RLS until metadata is detached. Soft-removed Listings retain their image objects privately until a future retention/cleanup policy is implemented.

## Operations and state rules

- `create_listing` always creates `DRAFT`, and identifies the owner from `auth.uid()`.
- Listing edit grants cover only title, description, asking price, currency, category, condition, and location override.
- `publish_listing`: `DRAFT → ACTIVE`, checks ownership, active account/Shop, moderation `CLEAR`, required fields, existing image and effective location.
- `remove_listing`: `ACTIVE → REMOVED`, requires a structured reason and optionally up to 500 characters of notes.
- `RESERVED` and `SOLD` remain in the enum for future transaction features but are **not** settable by ordinary clients in this migration.
- `discard_draft_listing` only hard-deletes a draft after all linked metadata **and** storage objects have been cleaned up.

## Domain decisions not yet implemented

- Jurisdiction/prohibited-item policy engine. **Do not treat the publication checks as legal/regulatory compliance.** Integrate checks before public launch, or limit allowed categories manually while testing.
- Buyer messaging, reservations and transactions.
- Reviews and reputation.
- Neighborhood geocoding. Public Listing RPCs return a sanitized location label (neighborhood falls back to city); exact addresses are included only for explicitly selected `exact` precision. Raw coordinates are never returned. A public Shop DTO is still needed.
- Reordering image metadata, max-images-per-listing limit, media moderation and attachment scanning.
- Public feed ranking. Basic cursor pagination is already supplied by `browse_public_listings`.
- Image expiration/cleanup policy for removed listings.

## Validation

The reviewed migration has now been applied and reset successfully in the local
`bazaar-migration-test` Supabase project. All 20 standard-library Python integration
tests pass, including the supplied structural SQL checks, real Auth/REST/Storage
requests and concurrent mutations. Application-schema lint is clean; full-schema
lint reports bundled PostGIS diagnostics. See `MIGRATION_002_VALIDATION.md` for
the exact corrections, commands, environment, and outstanding launch work.

Reproduce locally (Docker must be running):

```powershell
npx --yes supabase@3.0.0 start --exclude studio,postgres-meta,realtime,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor
npx --yes supabase@3.0.0 db reset --local
python supabase/tests/test_migration_002.py
npx --yes supabase@3.0.0 db lint --local --schema public,private --level warning
```

Reset deletes the disposable local database. Tests create isolated UUID fixtures
and uploaded images there; another reset clears them. The test runner rejects an
unexpected API URL and uses only the named local Docker database container.
No remote project is linked. The SQL structural checks use `DO` assertions, not
pgTAP, and are executed by the Python runner with `psql ON_ERROR_STOP=1`.

Validation checklist:

1. Confirm the repo's current Supabase CLI/project versions and Migration 001 names/types.
2. Check migration ordering and conflicting table/bucket/function names.
3. Apply `supabase db reset` against a local development instance if the project is already configured for that.
4. Run `supabase/tests/002_structural_checks.sql` in that database.
5. Test two distinct authenticated accounts (owner vs non-owner), plus `anon`.
6. Verify security-definer functions live only in the **non-exposed `private` schema**, and that public wrappers properly check `auth.uid()`/ownership.
7. Verify seller cannot change lifecycle columns through `.from('listings').update(...)`.
8. Verify all negative and concurrency cases listed below.

### Required integration cases

| Case | Expected outcome |
|---|---|
| Seller creates draft in own active Shop | Succeeds; `DRAFT` |
| Buyer-only or suspended user creates Listing | Rejected |
| User creates Listing in another seller's Shop | Rejected |
| Listing overrides Location owned by another User | Rejected by FK/RPC |
| Owner updates title on draft | Succeeds |
| Owner directly sets `status = 'active'` | Rejected (column permission) |
| Owner publishes without category/condition | Rejected |
| Owner publishes with no image | Rejected |
| Owner publishes with no effective location | Rejected |
| Owner uploads image to someone else's Listing prefix | Rejected |
| Owner attaches non-existing Storage object | Rejected |
| Owner publishes valid draft | Succeeds once |
| Repeated publish | Rejected; published timestamp unchanged |
| Owner removes ACTIVE Listing with reason | `REMOVED`; not publicly visible |
| Owner directly removes RESERVED Listing | Rejected (once transaction state is implemented) |
| Anonymous user selects a removed/draft Listing | No row |
| Owner still selects own draft/removed Listing | Allowed |
| Anonymous user downloads private image without signed URL | Denied |
| Two concurrent attach requests to same Listing | Order remains unique |
| Deleting last image from ACTIVE Listing | Rejected |
| Detaching image then Storage deletion | Allowed; no metadata reference |
| Draft discard with leftover Storage objects | Rejected until cleaned |

### Known earlier-migration hardening item

Migration 001 placed `activate_selling()` as a `SECURITY DEFINER` function in the `public` (exposed) schema. The function does check `auth.uid()` and ownership, but current Supabase guidance recommends avoiding exposed SECURITY DEFINER functions. Ask Codex to assess moving that implementation into `private` with a thin `public` invoker wrapper in a **new follow-up migration**, without rewriting already-applied migration history. Do not silently change the behavior of seller activation.
