# Migration guides

These describe migration-specific behavior. Current product policy lives in the Domain Model and Domain Operations; later migrations can extend earlier behavior. The 001 review is historical. No guide authorizes a reset, repair, deployment or modification of applied SQL.

- [MIGRATION_001_REVIEW.md](MIGRATION_001_REVIEW.md)
- [MIGRATION_002_README.md](MIGRATION_002_README.md)
- [MIGRATION_003_README.md](MIGRATION_003_README.md)
- [MIGRATION_004_README.md](MIGRATION_004_README.md)

Current policy: [Domain Model](../DOMAIN_MODEL.md) and [Domain Operations](../DOMAIN_OPERATIONS.md).

## Verified local history (read-only inspection, 2026-11-15)

| Version | Purpose |
|---|---|
| 20261025 | Accounts, Locations, Shops |
| 20261105 | Listings and inventory |
| 20261109 | Chat eligibility compatibility |
| 20261110 | Conversations and messaging |
| 20261111210000 | Reservation/cancellation foundation |
| 20261111210100 | Audit transition correction |
| 20261114000100 | Anonymous Realtime isolation correction |

The full-lifecycle [candidate SQL](../../supabase/candidates/20261112000000_transactions_reservations.sql) is unapplied and incompatible with the applied foundation. It remains untouched; do not apply it.
