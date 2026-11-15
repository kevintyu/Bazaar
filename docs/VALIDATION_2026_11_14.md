# Chat policy, Migration 003 validation and Migration 004 candidate review

Date: 2026-11-14. Local development only; no production access. Working directory:
`C:\Users\duyue\Documents\ChatGPT\Bazaar`.

## Policy and repository reconciliation

Owner reconfirmed ACTIVE new/existing chat, RESERVED existing chat only, and
SOLD/REMOVED read-only message history. The domain documents already contained
these rules; they now record reconfirmation and clarify that per-user inbox
archive/hide/read state remains editable. README and task expectations agree.

The supplied operations amendment describes a full-lifecycle candidate. Its
compatible future contract was merged into DOMAIN_OPERATIONS.md as NOT enabled.
It does not override existing owner-confirmed cancellation restrictions or the
durable reservation request UUID contract. No three-day timeout was approved.

Inspection found SIX migrations already applied, not merely 001–003:

| Version | Name |
|---|---|
| 20261025 | 001_accounts_locations_shops |
| 20261105 | 002_listings_inventory |
| 20261109 | 002_chat_eligibility_compat |
| 20261110 | 003_conversations_messaging |
| 20261111210000 | 004_transactions_reservations |
| 20261111210100 | 004_audit_transition_constraint |

All six files retain their initial SHA-256 hashes, matching the preservation
table in MIGRATION_004_VALIDATION.md. No applied file was rewritten or renamed.
The only new applied version is 20261114000100_003_realtime_anonymous_isolation.
No reset or migration repair was used; validation exercised the existing local
database with additional UUID-tagged fixtures. This is not a fresh-database replay.

## Found and fixed: anonymous Realtime activity envelopes

A filtered anonymous subscription was rejected. An UNFILTERED anonymous
subscription received one empty record per message, while full database reads
were denied. No message body, ID or participant data was observed, but table
activity was observable. A strict zero-event test correctly failed (4 != 0).

Inspected the installed realtime.apply_rls function: its missing-primary-key-
privilege branch emits an `Error 401: Unauthorized` envelope BEFORE row-policy
evaluation. This is distinct from authorized access to a message.

Forward-only correction grants anon only SELECT(id) on messages/conversations
and installs restrictive SELECT policies with USING(false). This permits the
Realtime authorization probe to reach RLS, which denies all rows. It does not
grant table-wide SELECT, content access or writes. Existing participant policies
and private-schema exposure are unchanged. Never replace the restrictive denial
with a permissive anonymous-read policy.

Final real-browser test: anonymous unfiltered and stranger filtered subscriptions
received ZERO message INSERT and Conversation UPDATE events. Anonymous ID queries
returned []; SELECT(*) remained denied. Buyer/seller delivery continued working.

## Commands and outcomes

Docker was initially stopped. Started it with:

```powershell
Start-Process -FilePath 'C:/Program Files/Docker/Docker/Docker Desktop.exe' -WindowStyle Hidden
docker ps -a --format '{{.Names}} {{.Status}}'
docker exec supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -c "select version,name from supabase_migrations.schema_migrations order by version;"
Get-FileHash supabase/migrations/*.sql
```

The existing containers, including Realtime, resumed. Scripts obtain local keys
from CLI status without printing credentials and use only loopback endpoints.

| Command | Final result |
|---|---|
| `npx.cmd --yes supabase@3.0.0 migration up --local` | Applied only 20261114000100 |
| `Get-Content supabase/tests/003_structural_checks.sql -Raw \| docker exec -i supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -v ON_ERROR_STOP=1` | PASS |
| `python supabase/tests/test_chat_eligibility_compat.py` | PASS, 1 test; rolled-back fixtures |
| `python supabase/tests/test_migration_002.py` | PASS, 20 tests, final run 6.157s |
| `python supabase/tests/test_migration_004.py` | PASS, all 14 foundation tests, final run 28.448s |
| `node scripts/validate_messaging_003.mjs` | PASS, all 7 groups, zero failures |
| `node scripts/test_messaging_003_browser.mjs` | PASS after forward correction |

Messaging SDK coverage includes separate real JWT accounts, participant/stranger
RLS, same UUID simultaneous sends and conflicts, 4,000-character limits,
moderation/terminal state, inbox independence, timestamp maxima, 12 send/remove
races and deterministic send-first/remove-first interleavings. RESERVED tests
use trusted isolated fixtures; the 004 tests also exercise real reserve/cancel RPCs.

The browser test uses installed Chrome with independent Playwright contexts and
the locally installed Supabase browser SDK. It types into a test-only textarea,
sends with real JWTs, receives bidirectional events, reloads a disconnected buyer,
fetches missed history, merges by message ID, and verifies live recovery. It tests
hidden/archive reset, retained history and inbox operations after removal. This
is a transport test harness, not a newly implemented product Chat UI or typing
indicator feature. No app build was needed: application code was not changed.

Initial browser harness failures: bundled Chromium was absent (switched to
installed Chrome); filtered anonymous subscription was denied instead of becoming
ready (handled explicitly); unfiltered anonymous zero-event assertion failed
(fixed with new migration). These were not silently counted as passing runs.

## Migration 004 candidate: not safe to apply

The unapplied `20261112000000_transactions_reservations.sql` was moved unchanged
from supabase/migrations to supabase/candidates to prevent accidental application.
SHA-256 before/after: 2C275D985CBB661B8F7660174585D2D1AA9EAEF6A211B555A5AB1FE8223F033B.

A local compatibility probe, enclosed in a transaction, failed:

```powershell
$candidateSql = Get-Content supabase/migrations/20261112000000_transactions_reservations.sql -Raw
"BEGIN;`n$candidateSql`nROLLBACK;" | docker exec -i supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -v ON_ERROR_STOP=1
```

This was run BEFORE moving the file. Result: `type "transaction_status" already
exists`; exit 1 closed the connection and rolled back the transaction. Nothing
was entered into applied migration history. Full candidate structural and
pickup/completion/dispute/deadline integration tests were NOT run because the
candidate cannot apply to this schema. Existing foundation tests did run and pass.

Concrete review findings:

1. Duplicate type, tables, composite constraints and cancellation functions
   collide with the applied foundation. Event IDs also differ (existing UUID
   vs proposed bigint), and candidate event_type/details replace existing
   from_status/to_status/cancellation_reason audit data. Do not recreate history.
2. Candidate reserve_listing(uuid) drops the existing required request UUID and
   retry semantics. Cancellation drops repeat-receipt behavior, reduces reason
   length from 1,000 to 500, and omits approved account/shop/moderation restrictions.
3. Merely adding candidate columns/functions is insufficient: the existing
   transactions_foundation_states CHECK, guard_transaction_history trigger,
   record_transaction_event trigger and corrected audit CHECK reject or cannot
   record pickup/completion/dispute transitions. They need coordinated forward
   changes and backfill-compatible event representation.
4. Candidate lock helper locks Listing/Transaction BEFORE checking participation;
   preserve the existing foundation's authorization prefilter in an extension.
5. Static candidate positives: seller selects buyer via Conversation; composite
   identity FKs, single-active index, participant RLS, transactional status/event
   writes, fixed search paths, Listing-before-Transaction locking. Finalization
   checks the stored deadline and awaiting-confirmation state, so disputed state
   is rejected. Completion updates SOLD, invoking the existing chat conclusion
   trigger. These full-lifecycle behaviors are not runtime-validated here.

## Files changed in this task

- docs/DOMAIN_MODEL.md
- docs/DOMAIN_OPERATIONS.md
- docs/CODEX_MIGRATION_003_TASK.md
- docs/MIGRATION_003_README.md
- docs/MIGRATION_003_VALIDATION.md (link to current execution)
- docs/MIGRATION_004_VALIDATION.md (link to current review)
- docs/VALIDATION_2026_11_14.md (this report)
- scripts/test_messaging_003_browser.mjs (new)
- supabase/migrations/20261114000100_003_realtime_anonymous_isolation.sql (new)
- supabase/candidates/20261112000000_transactions_reservations.sql (moved, unchanged)

Pre-existing deleted task files and other untracked supplied files were preserved.
Test-created accounts/history remain local; no production or external message
was sent. Docker is left running for local development.

## Next proceed

Develop a new forward-only extension to the applied reserve/cancel foundation,
preserving request UUIDs, restrictions and immutable audit history. First resolve
pickup/confirmation/dispute restriction behavior, confirmation-window policy,
seller-finalization policy and admin dispute resolution. Three days remains a
proposal, not an approved default. Do not run the archived candidate as-is.
Chat production UI, typing indicators, payments and reviews remain out of scope.
