# Marketplace roadmap

Status: 2026-11-15. Local development evidence only; no production readiness claim.
Product authority: [Domain Model](DOMAIN_MODEL.md) and [Domain Operations](DOMAIN_OPERATIONS.md).

## Implemented locally

- Accounts/profiles, selling activation, private Locations and Shops.
- Listing drafts, images, publication/removal and sanitized public reads.
- Seller dashboard/editor and public browse/Shop/Listing UI.
- Messaging backend, participant isolation, retained history, inbox state and Realtime.
- Reservation/cancellation foundation with request UUID retries and immutable audit history.
- Anonymous Realtime isolation correction.

See [migration guides](migrations/README.md) and [validation evidence](validation/README.md).
Backend support does not imply a product messaging or transaction UI exists.

## Approved direction, not implemented

- Buyer initiates a pickup claim; a claim alone does not complete a sale.
- Seller confirms the buyer claim; completion and Listing SOLD must be atomic.
- No automatic completion timeout or completion authorized solely by elapsed time.
- Restricted administrator resolution requires authorization, reviewed evidence,
  justification and immutable audit records; no arbitrary status override.
- Product messaging/transaction UI remains separate implementation work.

## Decisions required before lifecycle implementation

- Exact claim/pending-state/RPC names and withdrawal/cancellation boundaries.
- Administrator roles, allowed outcomes and transitions, evidence sufficiency,
  evidence access/retention, and whether second review is required.
- Account, Shop, moderation and blocking restrictions during claim/confirmation/resolution.
- Optional reminders/escalation without time-based completion.
- Negotiated-price/receipt snapshots and cancellation-reason taxonomy.

Only after those contracts are settled should a separately authorized forward-only
extension be designed and tested. Do not reuse the superseded full Migration 004 candidate.

## Deferred features and launch work

Reviews/reputation, payments, shipping, auctions, subscriptions and promoted
listings remain outside current scope. Moderation/prohibited-item policy, abuse
controls, privacy-safe Shop/location presentation and retention need dedicated
work before public launch; see the [QA checklist](testing/QA_CHECKLIST.md).

No dates or implementation commitments are implied by this roadmap.
