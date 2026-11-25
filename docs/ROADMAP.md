# Marketplace roadmap

Status: 2026-11-25. Local development evidence only; no production readiness claim.
Product authority: [Domain Model](DOMAIN_MODEL.md) and [Domain Operations](DOMAIN_OPERATIONS.md).

## Implemented locally

- Accounts/profiles, selling activation, private Locations and Shops.
- Listing drafts, images, publication/removal and sanitized public reads.
- Seller dashboard/editor and public browse/Shop/Listing UI.
- Messaging backend, participant isolation, retained history, inbox state and Realtime.
- Reservation/cancellation foundation with request UUID retries and immutable audit history.
- Anonymous Realtime isolation correction.
- My Purchases, My Sales and participant transaction details; minimal chat and seller reservation UI.

See [migration guides](migrations/README.md) and [validation evidence](validation/README.md).
The participant UI is documented in [transaction UI validation](validation/TRANSACTION_UI_VALIDATION.md).
Administrator resolution remains backend-only.

## Lifecycle backend implemented by Migration 005

- Buyer initiates a pickup claim; a claim alone does not complete a sale.
- Seller confirms the buyer claim; completion and Listing SOLD must be atomic.
- No automatic completion timeout or completion authorized solely by elapsed time.
- Restricted administrator resolution requires authorization, reviewed evidence,
  justification and immutable audit records; no arbitrary status override.
- Participant pickup/confirmation UI is implemented; administrator UI is deferred.

## Remaining integration and policy decisions

- Participant-safe historical listing summaries and counterparty display names. Existing
  policies do not provide buyer access to reserved/sold listing details or seller
  access to buyer profiles; the UI uses explicit fallbacks without widening access.

- Any future claim-withdrawal or public dispute-entry operation.
- Evidence sufficiency, evidence access/retention, review tooling, and whether
  second review is required; the current backend enforces an operator allowlist.
- Additional blocking policy; current lifecycle actions already enforce the
  owner-approved account/Shop/moderation restrictions.
- Reminder/escalation cadence and external delivery adapter. Timing defaults
  to disabled; durable intents and a trusted explicit enqueue function exist.
- Negotiated-price/receipt snapshots and cancellation-reason taxonomy.

See [Migration 005](migrations/MIGRATION_005_README.md) for implemented contracts
and limits. Do not reuse the superseded full Migration 004 candidate.

## Deferred features and launch work

Reviews/reputation, payments, shipping, auctions, subscriptions and promoted
listings remain outside current scope. Moderation/prohibited-item policy, abuse
controls, privacy-safe Shop/location presentation and retention need dedicated
work before public launch; see the [QA checklist](testing/QA_CHECKLIST.md).

No dates or implementation commitments are implied by this roadmap.
