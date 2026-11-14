# Messaging concurrency test — Migration 003

Run only against disposable local Supabase with test accounts and test listings.

## Automated authenticated smoke test

From the repository with `@supabase/supabase-js` installed:

```bash
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_ANON_KEY=<local-anon-key> \
TEST_BUYER_EMAIL=<buyer@example.test> \
TEST_BUYER_PASSWORD=<password> \
TEST_SELLER_EMAIL=<seller@example.test> \
TEST_SELLER_PASSWORD=<password> \
TEST_LISTING_ID=<active-listing-uuid> \
node scripts/test_messaging_003.mjs
```

This is a smoke test; it does not reliably force the adverse interleaving every time.

## Deterministic two-session timestamp test

A regression can be exposed by two SQL connections, each authenticated as the same buyer or seller with `request.jwt.claim.sub` and `role authenticated` set **only in the local test database**. Create an ACTIVE test Listing and Conversation, then:

**Session A** — begin first but deliberately submit its message later:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '<BUYER_UUID>', true);
SELECT pg_sleep(5);
SELECT public.send_message('<CONVERSATION_UUID>', 'A late request', '<UUID_A>');
COMMIT;
```

**Session B** — run while Session A sleeps:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '<BUYER_UUID>', true);
SELECT public.send_message('<CONVERSATION_UUID>', 'B earlier completion', '<UUID_B>');
COMMIT;
```

Under the old implementation, Session A's `now()` timestamp can predate Session B's even though A's insert happens later, causing the trigger to overwrite `last_message_at` with an older value.

After both commits, verify:

```sql
SELECT id, last_message_at FROM public.conversations
WHERE id = '<CONVERSATION_UUID>';

SELECT max(created_at) FROM public.messages
WHERE conversation_id = '<CONVERSATION_UUID>';
```

`last_message_at` must equal the maximum `created_at` among persisted messages for that Conversation.

For each participant, record `last_read_at` before concurrent activity; after sends and read acknowledgements, assert the value never decreases. To force wait states, hold a row lock in one SQL session while the other executes a message or mark-read call.

**Important:** if the runtime uses a role with different permissions or the local Supabase JWT settings differ, adapt the test to correctly simulate authenticated requests. Don't run with `service_role` as a substitute for RLS testing.

## Complete local integration runner (2026-11-11)

```powershell
node scripts/validate_messaging_003.mjs
```

Requires the existing local `bazaar-migration-test` stack, Docker, the pinned
Supabase CLI 3.0.0 via npx, and installed Supabase JS dependencies. The runner
reads local CLI status without printing keys and rejects any unexpected API/DB
host. It creates four real local Auth accounts and UUID-tagged test fixtures;
these are retained as local audit history, not destructively cleaned up.

Tests use authenticated clients for RPC/RLS and WebSocket delivery. Privileged
local SQL is limited to fixture setup, inspecting assertions, and controlled
multi-session transactions that explicitly SET ROLE authenticated and auth.uid.
It is never used as a substitute for participant RLS checks.

Coverage: official RESERVED lifecycle, 16 simultaneous identical-message-ID
sends, competing content and cross-Conversation ID collisions, body limits,
participant/inbox isolation, terminal history, moderation/account restrictions,
concurrent timestamps, 12 send/remove races, both deterministic lock orders,
three-user Realtime delivery/isolation with an other-Conversation positive
control, and disconnect/reconnect plus persisted-history deduplication.

The test waits for both socket subscription and the server's PostgreSQL-ready
system event. Socket connection alone is insufficient startup readiness.
History recovery is explicitly fetched and merged by message UUID; no claim
that WebSocket transport replays missed events is made. This tests SDK clients,
not browser UI rendering or a production chat frontend. See the validation
report for exact executed outcomes, including the initial failed run.
