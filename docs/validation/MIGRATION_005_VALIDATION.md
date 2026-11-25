# Migration 005 local validation — 2026-11-24

## Scope and findings

Initial Git status was clean. Local history contained the seven versions listed in
the [migration index](../migrations/README.md). Existing reserve/cancel functions,
single-active index, identity constraints, append-only audit and messaging lifecycle
provided the foundation. The old state constraint and guard allowed only reservation
and cancellation, so this extension replaces those definitions through a new migration.
No notification delivery or administrator authorization infrastructure existed.

Owner decisions: block new claim/confirmation/admin resolution actions while either
participant, Shop/seller eligibility or Listing moderation is restricted; require
buyer claim for administrator completion; use operator-managed membership, reject
participant administrators and require private evidence references/findings/reason.

## Files changed

Added:
- `supabase/migrations/20261124000100_005_pickup_claims_resolution.sql`
- `supabase/tests/test_migration_005.py`
- `docs/migrations/MIGRATION_005_README.md`
- `docs/validation/MIGRATION_005_VALIDATION.md`

Updated authoritative contracts and implementation/navigation status:
- `AGENTS.md`, `README.md`
- `docs/DOMAIN_MODEL.md`, `docs/DOMAIN_OPERATIONS.md`
- `docs/DATABASE_SCHEMA.md`, `docs/ER_MODEL.md`
- `docs/README.md`, `docs/ROADMAP.md`
- `docs/migrations/README.md`, `docs/migrations/MIGRATION_004_README.md`
- `docs/validation/README.md`

No frontend, existing tests or previously applied SQL files changed. See the
[005 guide](../migrations/MIGRATION_005_README.md) for objects and compatibility mapping.

## Commands and results

Commands ran against the local Docker/Supabase stack only. Docker Desktop was started
to restore the existing local environment. No database reset or history repair ran.

| Command/check | Result |
|---|---|
| `git status --short` and local history inspection | Clean initial repository; seven applied versions |
| Proposed SQL piped to local `psql -v ON_ERROR_STOP=1` inside BEGIN/ROLLBACK | Initial PL/pgSQL CASE parenthesis error corrected before application; second dry-run passed and rolled back |
| `npx.cmd --yes supabase@3.0.0 migration up --local` | Applied only version 20261124000100 |
| `python supabase/tests/test_migration_005.py` | 24 tests passed, including all 14 inherited reservation/cancellation regressions |
| `python supabase/tests/test_migration_005.py LifecycleTests.test_30_administrator_key_reuse_across_transactions LifecycleTests.test_31_deterministic_lifecycle_lock_order LifecycleTests.test_32_function_grants_and_new_column_protection` | Three subsequently added tests passed; 27 unique lifecycle/foundation tests total |
| `python supabase/tests/test_migration_002.py` | 20 passed |
| `python supabase/tests/test_chat_eligibility_compat.py` | One passed |
| `node scripts/validate_messaging_003.mjs` | Seven groups passed, including RESERVED behavior, send/remove races and Realtime isolation |
| `node scripts/test_messaging_003_browser.mjs` | Passed separate browser identities, bidirectional Realtime, anonymous/stranger isolation, inbox state and reload recovery |
| `Get-Content -Raw supabase/tests/003_structural_checks.sql \| docker exec -i supabase_db_bazaar-migration-test psql -U postgres -d postgres -v ON_ERROR_STOP=1` | Messaging structural checks passed |
| `npx.cmd --yes supabase@3.0.0 migration list --local` | Eight matching versions; explicit target 127.0.0.1:54322 |
| SHA-256 comparison with pre-change snapshot | All seven original migrations and archived candidate byte-for-byte unchanged |
| `git diff --check` and local Markdown target validation | Passed |

Tests use real user JWTs for participant/admin operations. Privileged SQL is limited
to fixture setup, assertions, operator settings and rollback-only fault injection.
Coverage includes ownership/auth failures, private evidence, forged metadata,
restrictions, duplicate/concurrent calls, cross-transaction UUID reuse, deterministic
lock waits, audit immutability, no deadline, reminder deduplication, and atomic
rollback on event/Listing failures. DISPUTED resolution uses a trusted rollback-only
fixture; it does not imply a public dispute-entry operation exists.

## Remaining boundaries

Notification intents are queued, not delivered. Cadence and escalation timing are
disabled until configured. Evidence sufficiency and operational review controls
remain policy work; recorded findings are not automated evidence verification.
No frontend, payment or review implementation was added. Production was untouched.
