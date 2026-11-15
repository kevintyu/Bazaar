# Codex task — Officialize chat policy, validate 003, then review 004 candidate

Read repository `AGENTS.md`, `docs/DOMAIN_MODEL.md`, `docs/DOMAIN_OPERATIONS.md`, all migration files, and `supabase_migrations.schema_migrations` history **before changes**.

## 1. Officialize the approved product rule

Merge `docs/DOMAIN_MODEL_AMENDMENT.md` and `docs/DOMAIN_OPERATIONS_AMENDMENT.md` into the existing domain docs. Keep the original documentation's structure. Also update the old Migration 003 README/task/test matrices to agree with:

- ACTIVE: new and existing conversations allowed.
- RESERVED: new conversations BLOCKED, existing conversations continue.
- SOLD and REMOVED: read-only historical conversations.

Do not rewrite any already-applied migration history.

## 2. Complete Migration 003 validation

Follow `docs/MIGRATION_003_VALIDATION_PLAN.md`, including tests with separate actual authenticated accounts and real Supabase Realtime subscriptions. Verify participant/nonparticipant isolation, reconnect/catch-up, simultaneous duplicate sends, and send/remove concurrency. Document exact commands and outcomes. Fix failures with new forward-only migrations where needed.

## 3. ONLY if foundational tests pass: review Migration 004 candidate

The draft `supabase/migrations/20261112000000_transactions_reservations.sql` assumes Migrations 001–003 and the database names in the supplied docs. Reconcile with **the real repository schema**, migration timestamps, any existing Transaction objects, and current local database. This is a **candidate** not an instruction to deploy.

Verify:

- Seller initiates reserve for buyer from an existing Conversation, with no arbitrary buyer ID parameter.
- Exactly one active Transaction per Listing; cancelled Transaction history retained.
- Listing → RESERVED / ACTIVE / SOLD transitions and Transaction status changes are atomic.
- Seller/buyer role authorization on each RPC.
- Buyer pickup confirmation, seller timeout finalization, cancellation and dispute rules.
- Seller-finalization cannot override a dispute or premature deadline.
- When Listing becomes SOLD, Migration 003 automatically concludes Conversations.
- Missing account/suspended shop decisions and admin dispute handling remain explicit TODOs.
- Operator-configurable pickup confirmation deadline; default three days still provisional.
- RLS on Transaction and event records, no direct table mutations by clients.
- Performance/indexes and concurrency lock ordering.

Run local migrations, structural checks, and multi-user transaction integration tests. Do not touch production. If any foundational tests remain failing, leave Migration 004 **unapplied** and report blockers.

## Report

- Repository files actually changed and whether migration history was preserved.
- Local commands executed and pass/fail outcomes.
- Authenticated RLS and Realtime results.
- Transaction tests and any schema corrections.
- Outstanding product decisions and security risks.
- What should happen next on 'proceed'.
