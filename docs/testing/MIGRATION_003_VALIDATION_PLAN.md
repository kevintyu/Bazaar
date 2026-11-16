# Migration 003 — Reusable validation checklist

Status, 2026-11-15: the backend and browser checks were executed on 2026-11-14;
see [results](../validation/VALIDATION_2026_11_14.md). This checklist is a rerun
reference, not a statement that validation remains outstanding. The reserve/
cancel foundation already exists; the separate full-lifecycle candidate is
archived and must not be applied.

This checklist originated before full Realtime validation. Those historical gaps
were subsequently tested; consult the linked dated report for outcomes and limits.
A future rerun must report its own actual results rather than reuse old pass claims.

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

## Historical integration gate

The original bundle treated Migration 004 as a candidate. That statement is historical; the applied reserve/cancel foundation is documented separately. Do not deploy Migration 004 to production as a way of avoiding the Messaging tests.
