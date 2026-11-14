# Codex Task — Integrate and Validate Marketplace Migration 003

Read `AGENTS.md`, then the domain documentation under `docs/`. Inspect the real repo before modifying files.

## Goal

Integrate `supabase/migrations/20261110_003_conversations_messaging.sql` and run `supabase/tests/003_structural_checks.sql` in a disposable local Supabase environment. Build **only** the conversation/messaging backend; do not start transaction/reservation backend or a chat UI in this task.

## First: inspect compatibility

1. Verify Migrations 001 and 002 really exist and apply cleanly in this repo.
2. Verify `public.listings.owner_user_id` and `private.shop_is_publicly_eligible(uuid)` names/types match Migration 002.
3. Check for overlapping `conversations`, `messages`, `conversation_user_states`, Realtime publications, enum names, or trigger names. Do not duplicate existing objects.
4. Verify `private` is not among the Supabase Data API's exposed schemas. Do not expose private `SECURITY DEFINER` functions.
5. Confirm the current project's Supabase CLI / Postgres / Realtime versions and auth conventions.
6. If migration history was already applied remotely, do **not** rewrite earlier applied migrations; propose a follow-up corrective migration where necessary.

## Integrate and validate

1. Add or adapt the migration minimally, preserving the documented domain model.
2. Run local `supabase db reset` or equivalent against a disposable dev database.
3. Run `003_structural_checks.sql`.
4. Verify `anon` has no chat read/write permissions and authenticated users have no direct chat row mutations.
5. Test with at least three independent accounts: Seller, Buyer A, Buyer B, plus an unauthenticated client. Use real Supabase client/JWT context, not just ad hoc SQL inserts that bypass RLS.
6. Run the behavior matrix in `docs/MIGRATION_003_README.md`, including two simultaneous retries with the same client UUID and send/remove concurrency.
7. Verify Postgres Changes publication is configured and a participant receives a real event while an unrelated authenticated user does not.
8. Inspect `pg_proc`, schema privileges, function ownership, and all SECURITY DEFINER search paths for security issues.
9. Check message text limits and errors, owner impersonation attempts, draft/removed/reserved/under-review eligibility, and whether RLS reveals any unintended content.
10. Add minimal automated integration tests consistent with existing repo test conventions.

## Architectural constraints

- Each conversation originates from exactly one Listing.
- Its seller is the Listing's actual Shop owner.
- One buyer/listing pair has one Conversation.
- Negotiation is free-form; **no Offer object**.
- No separate Reservation entity.
- Seller will later have `Reserve for this buyer` in the chat UI, implemented with Transactions in the next migration.
- A conversation can be independently archived/hidden by either participant.
- Hiding chat is not permanent data destruction.
- Existing histories stay accessible for receipts/disputes after a Listing sells or is removed.
- No new chat writes after a Listing is SOLD or REMOVED.
- Do not implement payments, attachments, reviews, blocking or moderation UI here.

## Known design checks

- `start_conversation()` and `send_message()` are separate RPCs; this may produce empty threads. Don't silently change to a combined operation without documenting it.
- Owner-confirmed: RESERVED blocks new Conversations and allows all existing Conversations to continue. Preserve applied SQL; use forward-only corrections if needed.
- Supabase currently recommends Broadcast for higher scalability; Postgres Changes is an intentional MVP tradeoff.
- Stronger anti-spam/rate limits and user blocking are future needs; note risks without expanding scope.
- Per-user hide/unhide and archive state must not allow users to modify someone else's inbox state.

## Report when finished

- Exact files changed
- Migrations applied / local commands run
- Structural test outcome
- RLS test outcome across Seller / Buyer A / Buyer B / anon
- Realtime delivery tests
- Any SQL corrections and reasons
- Unresolved risks or domain-model conflicts

Do not deploy to production or implement the chat UI unless asked.
