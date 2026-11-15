# Migration 003 — Remaining validation before Migration 004 approval

The prior Work report in this conversation stated Migration 003 structural checks and 20 database regression tests passed locally. That report is not equivalent to a fresh independent test execution here, and it explicitly left Realtime validation and provisional messaging rules outstanding.

**Confirmed owner rule:** NEW Conversations on RESERVED Listings are BLOCKED. EXISTING Conversations continue; SOLD/REMOVED conversations are read-only. This is the authoritative expected behavior going forward.

## Prerequisites

- Actual repository's 001 → 002 → compatibility → 003 applied in a disposable local Supabase instance.
- Two buyer accounts, one seller account, and one unrelated fourth account or anonymous client.
- At least one ACTIVE+CLEAR seller-owned Listing and a second disposable Listing for send/remove race tests.
- `supabase_realtime` publication includes `public.messages` and (if used) `public.conversations`.
- Do not use a service-role client for participant isolation tests.

## Test matrix

| Test | Expected |
|---|---|
| Seller, buyer A subscribe to same conversation | Both receive new private INSERT messages |
| Buyer B/stranger subscribes to A's conversation | No private INSERT event or row visibility |
| Anonymous subscriber | Cannot receive conversation messages |
| Disconnect seller, send from buyer, reconnect | Missing messages fetched from PostgreSQL, with no duplicates |
| Same sender/client UUID sent 8 times simultaneously | One persisted row, same message UUID on all successful retries |
| Same UUID different body | Explicit conflict, never a second row |
| Concurrent send and Listing removal | An in-flight send before removal may commit; after removal commits, all new sends rejected |
| Under-review Listing | No new chats or ordinary sends |
| RESERVED Listing | No new conversation; existing conversations continue |
| SOLD Listing | Conversation concluded, historical messages accessible, new sends rejected |
| Hidden/archived thread receives new inbound message | Recipient inbox is unhidden/unarchived |
| Monotone timestamps in concurrent messages | `last_message_at` equals MAX(`messages.created_at`), read timestamps never decrease |

## Execution guidance

1. Run the repository's existing database tests and Migration 003 structural test.
2. Run `scripts/realtime_003_local.mjs` with real local JWT credentials for seller, buyer, stranger, and an ACTIVE Listing ID.
3. Run existing Migration 003 concurrency tests (including deterministic multi-session send/remove ordering, not just Promise.all() smoke tests).
4. Test confirmed `RESERVED` behavior with an actual RESERVED fixture *after* a Transaction migration is available, or with an isolated test fixture that can legally set the status; do not claim it passed until it runs.
5. Run a browser-to-browser conversation test with two authenticated sessions (typing, reload, reconnect, hidden/archived inbox behavior).
6. Record actual commands, results and unresolved failures; do not claim these tests ran simply because scripts exist.

### Supabase Realtime documentation

https://supabase.com/docs/guides/realtime/postgres-changes

## Blocking decision

Migration 004 is a candidate until the above tests pass and actual migration history is reconciled. Do not deploy Migration 004 to production as a way of avoiding the Messaging tests.
