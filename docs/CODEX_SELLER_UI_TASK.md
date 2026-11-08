# Codex implementation task — Seller UI vertical slice

## Objective

Integrate the provided seller-ui patch with the actual repository after reviewing `AGENTS.md`, `docs/DOMAIN_MODEL.md`, `docs/ER_MODEL.md`, `docs/DATABASE_SCHEMA.md`, `docs/DOMAIN_OPERATIONS.md`, and Migrations 001/002.

**Do not overwrite existing app code or auth integration blindly.**

## First, inspect (no modifications yet)

- Framework: Next.js App Router vs existing Vite/React architecture.
- TypeScript/React versions, `src` aliases, routing conventions, CSS system.
- Existing Supabase client (especially whether `@supabase/ssr` and cookie refresh are configured).
- Actual migrations, RPC signatures, Storage bucket and RLS policies.
- `auth.users` → `profiles` trigger and profile authorization.
- Existing tests and development credentials setup.

Report any mismatches before modifying the domain model.

## Implement after review

1. Seller home and shop selection.
2. First-shop activation via `activate_selling` (only if not already present).
3. Listings dashboard (owner-only).
4. Create DRAFT via `create_listing`.
5. Update editable listing content via narrowly granted `.update(...)`.
6. Upload to private Storage, followed by `attach_listing_image`; detach metadata before deleting Storage object.
7. Publish via `publish_listing`; explicit preconditions and useful error messages.
8. Remove ACTIVE listing with structured reason via `remove_listing`.
9. Public browse, Listing page and Shop pages using RLS-visible data only.
10. Public photo endpoint: verify public Listing + Shop + seller + image relationship **before** creating a short-lived signed URL; secret only server-side.

## Must preserve

- No Offer table or Reservation table.
- Listing owned by Shop, not separately by User in the domain.
- User-owned reputation, separate buyer/seller contexts.
- Seller controls reserved state (future slice).
- Listing visibility defaults private for drafts/removed items.
- Shop location private; public-facing location redaction to be added later.
- Lifecycle transitions through RPC, not client SQL status updates.

## Validate

- `npm run typecheck` and `npm run build`.
- Run local Supabase migrations on a disposable dev instance.
- Follow `docs/QA_CHECKLIST.md` including negative ownership tests.
- Test Storage permissions with owner, non-owner and anon accounts.
- No service key in client bundle, source maps, logs, or public env variables.
- Make sure no foreign-key join accidentally leaks private addresses.
- Test signed-image redirect before/after removal and when the seller is banned.
- Confirm rendering and auth behavior on direct navigation and refresh.
- If tests or services are unavailable, report the exact unverified items.

## Report at end

- Files changed and reasons.
- Commands run and results.
- RPC/schema changes needed (if any).
- Security/RLS results.
- UX issues and next recommended feature.
- Do not implement messaging/transactions yet.
