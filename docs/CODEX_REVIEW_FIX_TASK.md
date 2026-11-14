# Codex task: reconcile and validate Migration 003 review fixes

Read `AGENTS.md`, `docs/DOMAIN_MODEL.md`, `docs/ER_MODEL.md`, `docs/DATABASE_SCHEMA.md`, and `docs/DOMAIN_OPERATIONS.md` first.

## Do not implement blindly

Inspect the actual repository versions of Migrations 001 and 002 and check their migration history. Original bundled Migration 002 already defines `private.shop_is_publicly_eligible(uuid)`; if the local repo does not, report the divergence and reconcile **the actual dependency** rather than inventing a duplicate helper in Migration 003.

If Migration 003 has already been applied to any shared database, do not edit the applied historical SQL. Instead create a new forward-only corrective migration. If not yet applied, replace the proposed Migration 003 with the corrected file.

## Product decision gate

Before final integration/production deployment, confirm with the owner:

- New conversations: ACTIVE only, or ACTIVE + RESERVED?
- Existing threads during RESERVED: continue or restrict to reserved buyer?
- SOLD/REMOVED: conclude and make chats read-only (matches archived-receipt concept), or allow a post-sale support exception?

The corrected SQL implements provisional defaults: ACTIVE-only new threads, all existing threads continue during RESERVED, SOLD/REMOVED conclude chats. Document the confirmed decisions in `docs/DOMAIN_MODEL.md`, then make SQL consistent with them.

## Engineering changes in the corrected proposal

- Fail-fast prerequisite check for Migration 002 helper.
- Validate actual body length and independent nonblank content in both DB and RPC.
- `clock_timestamp()` for message-created timestamps.
- `GREATEST()` for `last_message_at` and `last_read_at` paths.
- Read acknowledgement based on last persisted message time.
- Stronger structural test and authenticated concurrency smoke-test script.

## Validation

1. Apply 001 → 002 → corrected 003 in disposable local Supabase.
2. Run structural test SQL.
3. Set up two test users and active seller-owned listing. Run `scripts/test_messaging_003.mjs` (local endpoint only).
4. Execute deterministic two-session interleaving test from `docs/CONCURRENCY_TEST_003.md`.
5. Verify buyer/seller can read each other's conversation, while a third user cannot.
6. Verify unauthorized direct INSERT/UPDATE/DELETE on conversation/messages/inbox tables are denied.
7. Verify message retry idempotency and duplicate ID/body mismatch.
8. Verify exact 4,000-character body accepted, >4,000 rejected, whitespace-only rejected.
9. Verify per-user archived/hidden state is independent, and new inbound message resets it appropriately.
10. Verify changes to Listing RESERVED, SOLD, REMOVED produce the documented conversation behavior.
11. Verify Realtime delivery with the actual authenticated clients.
12. Confirm client-side Chat UI references remain compatible with RPC arguments and results.

## Deliverable

Report: files changed, applied migration strategy, relevant diff, all commands/tests and results, product decisions still unconfirmed, and any residual security or timing concerns. Do not implement Transactions/Migration 004 in this task.
