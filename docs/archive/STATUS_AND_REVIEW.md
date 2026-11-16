> Historical record, organized 2026-11-15. See the [folder index](README.md). Original proposals, commands, results,
> and paths below describe their original context, not current instructions.
> For current policy see [Domain Model](../DOMAIN_MODEL.md) and [Domain Operations](../DOMAIN_OPERATIONS.md).
> Seller-initiated pickup and timeout-completion proposals are superseded.

# Implementation status — 11 November 2026

## Source files available during preparation

- Uploaded repository-derived `20261105_002_listings_inventory.sql`.
- Uploaded compatibility migration `20261109_002_chat_eligibility_compat.sql`.
- Prior conversation records and domain decisions.

Not available during this step: the **actual Git repository**, applied `003` file, PostgreSQL process, running Supabase API, user JWTs, or a browser session connected to the app. The prior Work message reported local application of 001→002→compatibility→003, 20 passing DB regression tests, and no production changes; these were *reported* earlier and have not been independently re-executed in this step.

## Prepared here

- Approved conversation rule amendment to Domain Model.
- Domain Operations v0.1 amendment for Transactions.
- Migration 003 Realtime and concurrency validation plan.
- A runnable local-only Realtime test script (not executed).
- Candidate Migration 004 with tables, FK constraints, partial unique index, RLS, explicit role-checked RPCs, and event history.
- Structural check for candidate Migration 004.
- Local-only authenticated Transaction integration script (not executed).
- Codex task file to reconcile these with the actual repository.

## Remaining before production

- Reconcile real repository migration signatures/ordering, including any existing transaction tables.
- Run actual 003 multi-user Realtime tests, deterministic duplicate-send and send/remove races, and reconnect recovery tests.
- Run 004 migrations on a fresh disposable local instance; run structural + multi-user transaction tests and concurrency tests.
- Confirm the three-day default or set a different operator-level confirmation window.
- Design admin dispute-resolution state machine before exposing disputes in the UI to real users.
- Confirm account-suspension behavior during active Transactions.
- Integrate UI: enable seller's chat button, and add buyer's My Purchases and seller sales screens.

No production or Git repository files were changed here. A local artifact bundle was generated for Codex integration.
