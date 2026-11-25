# Marketplace documentation

## Authority and status

1. [Domain Model](DOMAIN_MODEL.md) defines product rules.
2. [Domain Operations](DOMAIN_OPERATIONS.md) defines action and authorization contracts.
3. [Database schema](DATABASE_SCHEMA.md) and [ER model](ER_MODEL.md) distinguish
   applied implementation from conceptual future design.
4. [Roadmap](ROADMAP.md) separates implemented work, future work and open decisions.

Buyer pickup claims, seller confirmation and restricted administrator resolution
are implemented locally by [Migration 005](migrations/MIGRATION_005_README.md).
Notification intents are queued; external delivery and public dispute entry are not implemented. There is no automatic completion
timeout. RESERVED Listings block new Conversations but allow existing ones.

## Guides and evidence

- [Migration guides](migrations/README.md): technical descriptions, not permission to apply SQL.
- [Validation records](validation/README.md): dated commands/results; old next steps are historical.
- [Testing guides](testing/README.md): rerun procedures and manual checks, not execution claims.
- [Archived proposals and decisions](archive/README.md): superseded sources, never current instructions.
- [Archived tasks](../tasks/archive/README.md): completed or superseded task descriptions.

Applied SQL remains in `supabase/migrations` and is immutable history. The
unapplied full-lifecycle candidate remains in `supabase/candidates`; do not apply it.
Documentation cleanup does not change schema, RPCs, migration history or production.
