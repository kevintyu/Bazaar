# Migration 003 — Review Response (Corrected)

## Current status (2026-11-11)

Migration 003 is applied locally. Historical review below is retained; RESERVED policy is now owner-confirmed in MESSAGING_POLICY_DECISION.md. Never rewrite applied migrations.

## Historical status

This is a corrected replacement for the original **unapplied** Migration 003. Do **not** change an already-applied migration in place; if it has been applied anywhere, create a new forward-only corrective migration instead. Do not run against production until validated locally and reviewed.

## Reviewer finding 1: Missing `private.shop_is_publicly_eligible(uuid)`

**Disagreed as a description of the original migration bundle:** Migration 002, file `20261105_002_listings_inventory.sql`, already creates that helper at approximately line 182, and grants execution at approximately line 218.

However, the actual repository may have a different or incomplete Migration 002. Corrected Migration 003 adds an explicit **fail-fast prerequisite check**. If it fails, reconcile the installed Migration 002; do not create a duplicate function with potentially different eligibility rules in Migration 003.

## Reviewer finding 2: Whitespace bypasses 4,000-character limit

**Accepted.** Previously, `char_length(btrim(body))` checked a trimmed copy while the full string was stored. The corrected SQL uses both:

- `char_length(body) BETWEEN 1 AND 4000`, measured on exactly what is stored;
- `body ~ '[^[:space:]]'`, requiring at least one non-whitespace character.

The RPC applies the same validation before inserting. Accepted message content is not silently trimmed.

## Reviewer finding 3: Timestamps regress under concurrency

**Accepted.** PostgreSQL `now()` is the transaction start time and may predate another request that commits first. The corrected migration:

- uses `clock_timestamp()` for new message `created_at` values;
- updates `conversations.last_message_at` with `GREATEST(old, new.created_at)`;
- updates sender `last_read_at` with `GREATEST(old, new.created_at)`;
- updates `mark_conversation_read()` to acknowledge only the newest currently recorded message time, never overwrite with an older transaction timestamp;
- uses `clock_timestamp()` for archive/hide and conversation conclusion timestamps.

This keeps stored inbox timestamps nondecreasing. It does **not** implement an exact client *last-seen message cursor*, which remains a future improvement for rigorous unread semantics during races.

## Reviewer finding 4: Undecided product choices

**Accepted.** Temporary MVP defaults in this corrected migration are:

| Action | Default in corrected Migration 003 | Decision status |
|---|---|---|
| Start NEW conversation on ACTIVE listing | Allowed | Established |
| Start NEW conversation on RESERVED listing | **Blocked** | Owner-confirmed 2026-11-11 |
| Continue EXISTING conversation when RESERVED | Allowed (while Listing/Shop otherwise eligible) | Owner-confirmed 2026-11-11 |
| Send messages after SOLD | **Blocked** (Conversation concluded) | Consistent with concluded/archived chat as receipt; confirm exception policy |
| Send messages after REMOVED | Blocked (Conversation concluded) | Consistent with removal rule |

These policies need to be recorded as adopted decisions before production. If the team chooses a different behavior, update both the SQL and documentation **before** integrating the migration. Do not leave contradictions with `docs/DOMAIN_MODEL.md`.

## Runtime validation required

Structural checks by themselves do not prove correctness. Test against a disposable local Supabase environment with three authenticated users (seller, buyer, stranger):

1. Seller's listing is ACTIVE. Buyer starts conversation; seller and buyer can read; stranger cannot.
2. Buyer can send message, seller can reply; messages appear to the correct users.
3. Repeat `send_message` with the same client ID and identical body; it returns the same message ID.
4. Repeat with same client ID and different body; it fails.
5. A body with 4,000 characters including surrounding spaces succeeds when not whitespace-only; a 4,001-character body fails.
6. A whitespace-only body fails even if <=4,000 characters.
7. Parallel sends/mark-read operations do not regress `last_message_at` or `last_read_at`.
8. Moving a listing to RESERVED blocks *new* conversations but preserves existing chat (owner-confirmed behavior).
9. Moving a listing to SOLD or REMOVED concludes associated conversations; messages become read-only history.
10. Archiving/hiding for one user does not affect the other user's inbox state; new inbound messages may resurface hidden threads.

See `CONCURRENCY_TEST_003.md` and `scripts/test_messaging_003.mjs` for further test details.
