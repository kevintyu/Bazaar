# Migration 004 foundation — local validation, 2026-11-11

Result: implemented and validated locally. No production connection/deployment.
Only reserve/cancel is enabled; pickup, confirmation, disputes and timeouts remain
future work. All earlier applied migration files remained unchanged.

## Repository and inspection

Working directory for all commands:
`C:\Users\duyue\Documents\ChatGPT\Bazaar`.

Read AGENTS.md, DOMAIN_MODEL.md, DOMAIN_OPERATIONS.md, ER_MODEL.md,
DATABASE_SCHEMA.md and MIGRATION_004_DESIGN.md. Inspected existing uncommitted
work, four migration files and live local applied history before changes.
No files in the synced ChatGPT project's sources directory were changed.

Read-only history command, run before and after:

```powershell
docker exec supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -c 'select version,name from supabase_migrations.schema_migrations order by version;'
Get-FileHash supabase/migrations/*.sql
```

Before: versions 20261025, 20261105, 20261109, 20261110.
After: those four plus 20261111210000 and 20261111210100.

## Owner decisions recorded this turn

- Block new cancellation until restrictions clear if either participant account
  or the Shop is restricted, or Listing moderation is UNDER_REVIEW.
- Optional free-text cancellation reason now; define preselected options later,
  alongside free text. No predefined taxonomy selected in this migration.

Implemented in guarded cancellation RPC, documented in domain sources and tested
for seller account, buyer account, Shop and Listing restrictions independently.

## New migrations and exact application command

1. `20261111210000_004_transactions_reservations.sql`: tables, identity FKs,
   single-active index, participant RLS, immutable history, reserve/cancel RPCs.
2. `20261111210100_004_audit_transition_constraint.sql`: forward-only correction
   for the audit transition CHECK's NULL case found during validation.

First, the foundation file was sent through a Python subprocess to this exact
psql command with `begin;` prepended and `rollback;` appended. DDL validation
returned exit 0 without retaining schema changes:

```powershell
docker exec -i supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
```

Then executed once for each new migration, after its file was written:

```powershell
npx --yes supabase@3.0.0 migration up --local
```

Both calls reported target `local stack (127.0.0.1:54322)` and applied only the
new pending file. No db reset, migration repair, production connection, or edits
to any already-applied file were performed. The corrective migration is separate
because the foundation was already applied when the audit flaw was found.

## Exact test commands and observed results

| Command | Actual outcome |
|---|---|
| `python supabase/tests/test_migration_004.py` (initial runner) | PASS: 32 tests in 27.697s: 20 existing Migration 002 tests plus 12 new foundation tests |
| `python supabase/tests/test_migration_004.py TransactionTests.test_13_audit_transition_null_cannot_bypass_check` | FAIL: 1 test; malformed audit transition was accepted by CHECK |
| `python supabase/tests/test_migration_004.py` (after correction and runner import fix) | PASS: 13 foundation tests in 20.419s |
| `python supabase/tests/test_migration_004.py TransactionTests.test_14_deterministic_listing_lock_order` | PASS: 1 additional foundation test in 12.910s |
| `python supabase/tests/test_chat_eligibility_compat.py` | PASS: 1 test in 0.152s |
| `Get-Content supabase/tests/003_structural_checks.sql -Raw \| docker exec -i supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -v ON_ERROR_STOP=1` | PASS: Migration 003 structural-check notice, exit 0 |
| `node scripts/validate_messaging_003.mjs` | PASS: all 7 groups, 0 failures |
| `git diff --check` | PASS: exit 0; tracked diffs only |

Initial runner imported the baseline unittest class directly, so unittest also
ran its 20 tests. That import was changed to a module import to keep the 004
runner scoped. The 20 tests genuinely ran and passed against the 004 database;
they were not separately rerun with the standalone 002 command this turn.

The final foundation coverage is 14 tests: 13 passed together, then the newly
added deterministic-lock test passed separately. No claim is made that a single
final 14-test invocation was run. Current runner discovers all 14 on a rerun.
No UI/TypeScript build was run because this change is SQL/docs/test code only.

The original audit CHECK used an expression that could evaluate to NULL when
`from_status` was NULL and `to_status` was CANCELLED; PostgreSQL accepts NULL in
CHECK. Test 13 reproduced this via trusted fixture SQL inside a rolled-back
transaction. No malformed audit event was committed. Ordinary clients already
had no event write grants. The follow-up constraint explicitly requires a
non-NULL previous RESERVED state; test 13 then passed. No other failures observed.

## What the foundation tests exercised

1. RLS, table grants, fixed SECURITY DEFINER search paths, absent future RPCs.
2. Seller-only reserve, buyer/outsider/anonymous denial, missing/null inputs and
   authenticated role without a user claim; rejected requests leave no rows.
3. Correct Listing/Shop/Conversation/buyer/seller binding; participant reads;
   no visibility to another existing buyer or outsider; direct mutation denied;
   existing chat still works, new chat and direct removal blocked while reserved.
4. Twelve simultaneous identical request UUIDs return one Transaction and event.
   Reusing a key for a different Conversation conflicts. Concurrent reuse across
   two Listings reserves exactly one and leaves the loser ACTIVE.
5. Six competing-buyer races: exactly one active Transaction and one winner each.
6. Draft/sold/removed/moderated, restricted Shop/seller and suspended buyer denials.
7. Buyer and seller cancellations, retained event history, new reservation with
   new ID, durable old reserve/cancel retries that cannot affect newer reservation.
8. Nonparticipant/anonymous/missing cancellation denial; text boundary checks;
   both actors blocked under each restriction; history readable; operation succeeds
   after restrictions clear. No partial audit row when blocked.
9. Eight simultaneous identical cancellations produce one cancellation event;
   competing actors preserve one winner's evidence; cancel/re-reserve race produces
   valid serialized state and no overwritten historical transaction.
10. Five reserve/remove races plus reserve/start/send overlap, with chat continuity
    and no observed deadlock.
11. Composite FK mismatches, active-slot uniqueness, immutable identity/history,
    and rejection of unimplemented state transitions even via trusted fixture SQL.
12. Fault injection at the Listing transition, after Transaction/event writes:
    both reserve and cancel roll back all three effects. Temporary trigger DDL
    and fixtures for the fault check are enclosed in rollback transactions.
13. Audit NULL-transition regression test described above.
14. Deterministic reserve-first/remove-second, remove-first/reserve-second, and
    cancel-first/reserve-second operations. The first authenticated SQL session
    holds locks for three seconds; pg_stat_activity/pg_blocking_pids proves the
    second request waits. After commit it revalidates state: invalid removal or
    reservation rejects, while reservation after cancellation succeeds.

Messaging regression again covered same-message-ID concurrency, send/remove
races, RESERVED behavior, participant isolation, Realtime positive control,
disconnect/reconnect and persisted history recovery. It used authenticated SDK
clients, not browser UI tabs. Fixture Shop for that run:
`d50b54e6-8fdd-4b90-8048-f5d8c74c83ac`.

## Preservation evidence

Earlier SHA-256 values matched before and after this turn:

```text
001 0AFACDBFAE69066AADE57561B990BB02BAE04EA0A777244234A5FF10131905CA
002 7DFBAD00AC30C4D8F3942D086FC98C4356527DF14560EA96D8CC4789BCC31756
compat 86F9C5B9B273477C5EC14507AA3032DD95F67137AD531950E5EE9C92FFAA687D
003 C76BA59204E30DCAB05D8C45FB3BBFCC6F32CE552453EF3D2DAB1B9124042A56
004 foundation 6BCE20BAE3ED953BFC059CA07B8D644513E8E9AFEFD7F07FCEBE0AAA4877F342
004 correction F10FB3A38514DB4CCEF8645ECF0E600F817EB01524EEC3554AABCD86F254F2CF
```

## Changed files this turn

Added:
- supabase/migrations/20261111210000_004_transactions_reservations.sql
- supabase/migrations/20261111210100_004_audit_transition_constraint.sql
- supabase/tests/test_migration_004.py
- docs/MIGRATION_004_README.md
- docs/MIGRATION_004_VALIDATION.md

Updated:
- docs/DOMAIN_MODEL.md
- docs/DOMAIN_OPERATIONS.md
- docs/DATABASE_SCHEMA.md
- docs/ER_MODEL.md
- docs/MIGRATION_004_DESIGN.md

Earlier uncommitted/untracked work was retained. No commit created. Local test
fixtures remain as UUID-tagged history. Generated Python import cache was removed.

## Remaining scope and next proceed

No unresolved technical blocker remains for this reserve/cancel foundation.
No fresh full-stack migration replay or browser UI test was run. Existing trusted
fixture SQL can create legacy RESERVED Listings without Transactions; this
migration did not rewrite that historical test data. API lifecycle atomicity is
provided by the guarded RPCs, with relational identity and uniqueness constraints.

Next: determine the buyer-confirmation window and restriction rules for pickup/
confirmation, then implement seller pickup marking and buyer confirmation in a
new forward-only migration with local role, race, deadline and rollback tests.
Seller timeout finalization, dispute resolution, blocking effects and final-price
receipt snapshots remain undecided. No arbitrary deadline or automatic sale was
introduced, and cancellation policy was not extended silently to other operations.
