# Migration 003 local validation — 2026-11-11

Repository: `C:\Users\duyue\Documents\ChatGPT\Bazaar`.
Result: **PASS for the executed backend/SDK validation suite**. Migration 004
has begun as an implementation design only; no 004 SQL/runtime tests are claimed.
No production endpoint was contacted. No migration was applied, renamed or edited.

## Inspection and applied history

Read AGENTS.md and DOMAIN_MODEL.md, DOMAIN_OPERATIONS.md, ER_MODEL.md,
DATABASE_SCHEMA.md before changes. Inspected migration SQL, test scripts and
existing uncommitted files. The original ChatGPT project mirror was read only.

Commands executed from this repository (PowerShell):

```powershell
npx --yes supabase@3.0.0 --version
npx --yes supabase@3.0.0 migration list --local
docker exec supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -c 'select version,name from supabase_migrations.schema_migrations order by version;'
Get-FileHash supabase/migrations/*.sql
```

CLI 3.0.0; installed Supabase JS 2.119.0. Applied local history before and after:

| Version | Name |
|---|---|
| 20261025 | 001_accounts_locations_shops |
| 20261105 | 002_listings_inventory |
| 20261109 | 002_chat_eligibility_compat |
| 20261110 | 003_conversations_messaging |

The CLI output labels matched versions as `remote`, but explicitly reported target
`local stack (127.0.0.1:54322)`; this was not a hosted/production history query.
The existing filenames use eight-digit versions; they are already applied and
were preserved. Any new migration should use a fresh 14-digit timestamp.

SHA-256 before and after matched exactly:

```text
001 0AFACDBFAE69066AADE57561B990BB02BAE04EA0A777244234A5FF10131905CA
002 7DFBAD00AC30C4D8F3942D086FC98C4356527DF14560EA96D8CC4789BCC31756
compat 86F9C5B9B273477C5EC14507AA3032DD95F67137AD531950E5EE9C92FFAA687D
003 C76BA59204E30DCAB05D8C45FB3BBFCC6F32CE552453EF3D2DAB1B9124042A56
```

## Local environment recovery

Initial `docker ps --format '{{.Names}} {{.Ports}}'` failed because Docker
Desktop's Linux engine pipe was unavailable. Started Docker Desktop hidden:

```powershell
Start-Process -FilePath 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -WindowStyle Hidden
npx --yes supabase@3.0.0 start
```

Existing database/Auth/REST/storage containers resumed, but Realtime was absent.
Restarted the local stack preserving its data (no reset, no --no-backup):

```powershell
npx --yes supabase@3.0.0 stop
npx --yes supabase@3.0.0 start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta,inbucket
```

Realtime then ran healthy. Despite the `inbucket` exclusion, CLI 3.0.0 started
the local mailpit/inbucket container. No application email was sent by this task.
The local stack is left running, including Realtime. UUID-tagged test accounts,
listings and messages are retained; no existing audit records were deleted.

## Exact test commands and outcomes

| Command | Outcome |
|---|---|
| `python supabase/tests/test_migration_002.py` | PASS: 20 tests, 6.434s |
| `python supabase/tests/test_chat_eligibility_compat.py` | PASS: 1 test, 0.170s; transaction rolled back |
| `Get-Content supabase/tests/003_structural_checks.sql -Raw \| docker exec -i supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -v ON_ERROR_STOP=1` | PASS: structural-check notice, exit 0 |
| `node scripts/validate_messaging_003.mjs` — first version/run | FAIL: 5 groups passed, Realtime first-message timeout |
| Same command — diagnostic system-event logging | PASS: all then-existing 6 groups |
| Same command — PostgreSQL-ready event gating added | PASS: all then-existing 6 groups |
| `docker restart supabase_realtime_bazaar-migration-test` then `node scripts/validate_messaging_003.mjs` | PASS: 7 groups, including added terminal/moderation checks |
| Same node command — other buyer's own-Conversation Realtime positive control added | PASS: final 7 groups, 0 failures |
| `node --check scripts/validate_messaging_003.mjs` | PASS, exit 0 |
| `git diff --check` | PASS, exit 0; checks tracked diffs only |

First failure details: subscriptions reported socket SUBSCRIBED but both
participants did not receive the first message within 15 seconds, shortly after
Realtime startup. Publication entries and replication slots existed. The next
run passed before the readiness change, so the precise initial server cause is
not proven. The runner now waits for an explicit PostgreSQL subscription-ready
system event as well as the socket join. It passed again after restarting
Realtime; do not erase the initial failure or claim a database bug was fixed.

Final run fixture Shop: `cf148764-3bba-4396-b858-ffe21b35ce24`.

## Final executed coverage

1. RESERVED: seller and two existing buyers can send; a new buyer cannot start;
   even an existing buyer's start RPC rejects while RESERVED; returning fixture
   Listing to ACTIVE allows a new Conversation. These state changes are local
   fixture SQL, **not** a claimed Transaction cancellation implementation.
2. Sixteen simultaneous sends with the same sender/client UUID return one message
   ID and persist exactly one row. Concurrent changed bodies and cross-Conversation
   UUID reuse produce one winner and MESSAGE_ID_REUSE_CONFLICT for the other.
3. 4000-character accepted body, 4001-character and whitespace-only rejection;
   participant/third-party/anonymous access checks; direct writes and sender/system
   spoofing rejected; per-user hide/archive isolated and inbound message resurfaces.
4. SOLD concludes chat and retains participant history; post-SOLD writes fail.
   UNDER_REVIEW and suspended sender fail without persisting messages. Self-chat denied.
5. Parallel messages/read acknowledgements preserve last_message_at maximum and
   the buyer's nondecreasing last_read_at.
6. Twelve simultaneous send/remove runs plus forced send-first and remove-first
   transactions. Removal commits, all chats conclude, post-conclusion sends fail;
   send-first retains one message, remove-first retains none. Exact successful-send
   retry after conclusion returns its original ID. No deadlock observed.
7. Real WebSocket Postgres Changes between authenticated SDK clients: seller and
   buyer receive each other's events. Another buyer receives a positive-control
   event in their own Conversation but no private event from the tested one.
   Disconnect buyer, send while offline, reconnect, fetch persisted history,
   merge by message UUID, and receive subsequent live messages. Four unique
   messages recovered without duplicates in the merged view.

Local psql catalog inspection also confirmed the eight messaging/compatibility
private helpers are owned by postgres, SECURITY DEFINER, with empty search_path.
Existing regression tests verify the private schema is not exposed through REST.

## Limits and remaining decisions

- Backend integration and SDK clients were tested, not two visible browser tabs,
  browser rendering, a chat UI, network chaos, long-duration soak, or load limits.
  There is no messaging frontend in this repository yet.
- Outsider event absence was observed through bounded test windows, supported by
  positive-control delivery and REST/RLS checks; it is not an unbounded security proof.
- The original `scripts/test_messaging_003.mjs` was inspected but **not executed**
  in this task; the new runner covers and extends its core cases.
- No fresh migration replay/reset was performed; validation used inspected,
  already-applied local history. No 004 migration was applied or tested.
- No current blocker to starting 004 design remains. Open product decisions:
  confirmation timeout duration; seller finalization and deadline precedence;
  dispute resolution roles/outcomes; cancellation reasons; suspension/moderation
  during active transactions; final sale price/receipt snapshots. These were not
  silently finalized. See MIGRATION_004_DESIGN.md.

## Files changed by this task

Updated:
- docs/DOMAIN_MODEL.md
- docs/DOMAIN_OPERATIONS.md
- docs/MESSAGING_POLICY_DECISION.md
- docs/MIGRATION_003_README.md
- docs/CODEX_MIGRATION_003_TASK.md
- docs/MIGRATION_003_REVIEW_RESPONSE.md
- docs/CONCURRENCY_TEST_003.md

Added:
- scripts/validate_messaging_003.mjs
- docs/MIGRATION_003_VALIDATION.md
- docs/MIGRATION_004_DESIGN.md

Several updated documentation files were already untracked at task start.
Existing untracked migrations, patch, other task docs and tests were preserved.
No changes committed, no production action performed.

## If the user says proceed

Start implementing the 004 reserve/cancel foundation as a new forward-only
migration, with atomicity, RLS, idempotence, competing reservations and rollback
tests. Use the design to resolve or explicitly gate the open deadline/dispute
policies before enabling dependent lifecycle operations. Rerun 002/003 locally
after 004 changes. The 004 implementation and its runtime tests remain next work.
