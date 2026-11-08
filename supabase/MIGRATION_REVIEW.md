# Accounts, locations, and shops migration review

Reviewed migration: `migrations/20261025_001_accounts_locations_shops.sql`.

## Repository and application prerequisites

The repository has no other migrations, package.json, Supabase config.toml,
application auth setup, generated database types, environment files, or tests.
No overlapping schema or migration-order conflict was found in repository files.
A remote database was not inspected or modified. Apply using the privileged
Supabase migration role, with Supabase auth.users, auth.uid(), anon and
authenticated already provisioned. This is not a standalone PostgreSQL bootstrap.

PostGIS must be available and installed in extensions. The migration creates that
schema if needed and rejects an existing PostGIS installation in another schema;
it does not relocate or drop an existing extension. The migration is intended to
run once through the migration runner, not repeatedly in the SQL editor.

## Corrections to the proposal

- Backfill profiles for existing auth users; the trigger handles future inserts.
- Trim the email fallback for profile names consistently in trigger and backfill.
- Require a Shop default location, as specified by the domain documents.
- Restrict country codes to two ASCII letters, normalized to uppercase by RPC.
- Reject explicit null location precision with a domain error.
- Pin function search_path to the empty string; application and extension objects
  are schema-qualified. SECURITY DEFINER remains necessary for profile creation
  and the atomic activation operation, which normal clients cannot perform directly.
- Revoke RPC execution from PUBLIC, anon, and authenticated before granting only
  authenticated execution, including protection against Supabase default grants.
- Revoke table privileges from PUBLIC as well as API roles before narrow grants.
- Remove direct Location writes. The documented dedicated location operation must
  validate future edits; activation is the only Location writer supplied here.

## Invariant assessment (static review; runtime tests pending)

| Invariant | Enforcement |
| --- | --- |
| One profile per auth user | Primary key, auth FK, insert trigger, existing-user backfill |
| Initially not a seller | Non-null false default; signup inserts only identity and display name |
| Acting user comes from auth | activate_selling calls auth.uid(); no owner parameter |
| Atomic activation | Location insert, Shop insert and Profile update in one function call; errors propagate |
| No second activation | Profile row lock followed by selling_enabled and existing-Shop checks |
| Same owner for Shop and Location | Non-null location ID and composite foreign key |
| Protected Profile fields | Only display_name and avatar_url have client UPDATE privileges |
| No arbitrary Shop creation | No client INSERT grant or INSERT policy |
| Exact Locations private | No anon privileges; authenticated SELECT restricted to owner |
| Active Shops readable | anon/authenticated SELECT plus active-Shop policy |
| Owner presentation edits only | Owner UPDATE policy plus four-column UPDATE grant |

Privileged database administration can bypass these client restrictions. Profile
deletion and auth-user deletion are not exposed to clients; ON DELETE RESTRICT
preserves history and means hard auth-user deletion requires a later explicit
account-retention workflow. This existing proposal behavior was retained.

Public Shop table SELECT currently includes IDs and status metadata, but no exact
location content. The application must implement the documented public DTO rather
than returning raw rows. Sanitized public location output and updateShopLocation
are not implemented by this migration.

## Validation performed

- Parsed all 42 SQL statements with pglast's PostgreSQL parser successfully.
- Attempted PL/pgSQL parsing: the standalone parser cannot resolve the extensions
  namespace. This does not validate the function bodies against a live database.
- Reviewed RLS, column privileges, trigger behavior, foreign keys and locking.
- Docker CLI is installed, but Docker's Linux engine is unavailable. Supabase CLI
  and psql are not on PATH. No local reset, migration execution, or runtime tests
  were performed. No live Supabase compatibility claim is made.

## Smallest recommended test setup

Use Supabase CLI local development and one pgTAP SQL file under
supabase/tests/database, without an application test framework. After initializing
local config and starting Docker, run:

```sh
supabase start
supabase db reset --local
supabase db lint --local --level warning
supabase test db
```

The reset command destroys only the local development database and rebuilds it.
No testing convention exists yet, so this review recommends the setup rather than
introducing one. The initial suite should use rollback-isolated fixtures and test:

1. Signup profile creation with normal, empty, missing and whitespace metadata;
   false selling default; existing-user backfill in a separate migration fixture.
2. Successful activation with and without coordinates and correct acting owner.
3. Anonymous execution denial and authenticated execution without a user claim.
4. Suspended/banned accounts, missing profile, missing name/country, invalid
   coordinates (including NaN/infinity), and null precision.
5. Repeated activation and two concurrent sessions activating the same user
   (a two-session integration check in addition to pgTAP).
6. A forced Shop-insert failure after Location creation, verifying no Location,
   Shop, or selling flag survives the failed call.
7. Cross-owner Location assignment rejected by the FK, even via a privileged
   fixture; no null default Location.
8. anon, owner and unrelated-user reads and writes, including protected columns,
   arbitrary Shop inserts, exact Location privacy and inactive-Shop visibility.
9. Owner updates to all four presentation fields succeed; other users affect no
   rows; direct Location mutation is denied.

References: https://supabase.com/docs/guides/database/functions,
https://supabase.com/docs/guides/database/extensions/postgis,
https://supabase.com/docs/guides/database/testing.
