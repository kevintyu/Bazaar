# Migration 002 integration report

## Outcome

Migration 001 and the corrected Migration 002 apply successfully from a clean
local Supabase reset. All 20 integration tests pass (11.744 seconds on the final
run); structural assertions are included. `public` and `private` lint cleanly.
No production or hosted database was accessed, linked, reset, or deployed.
Migration 001 was inspected and left unchanged during this task.

The repository initially contained domain documents, two proposed migrations and
structural SQL assertions. There was no package.json, Supabase config, application
auth client, environment file, generated database types, application code or
runtime test harness. There was no prior listing schema/bucket in this new local
database. Other working-tree document edits predated this task.

## Concrete differences from the supplied Migration 002

The supplied SQL was a different implementation from its README and structural
test contract. These changes align it with that contract and the domain model:

| Change | Reason |
| --- | --- |
| Removed duplicate `supabase/migrations/002_structural_checks.sql`; kept the test copy | The test would sort before Migration 001 and fail as a migration. The two copies had identical SHA-256 hashes. |
| Renamed `internal` to `private`, preserving empty search paths and invoker wrappers | Matches the task/README. Both schemas are excluded from the Data API. |
| Added Shop `(id,owner_user_id)` uniqueness and Listing composite owner FKs | The supplied ownership trigger only checked selected Listing writes and did not protect reverse owner changes. Owner ID is enforcement data, not a change to Shop-owned Listings. |
| Expanded `create_listing` to the documented structural-test signature | The supplied two-argument function could not pass the required checks. |
| Added attach, detach and draft-discard commands | Required by the task/README but absent from supplied SQL. |
| Removed direct image INSERT/UPDATE/DELETE grants and write policies | Metadata mutations must verify real uploaded objects and serialize with lifecycle operations. |
| Attach verifies Storage object existence and `owner_id = auth.uid()` | A metadata row alone is not evidence of an owned upload. Uses current Storage ownership field. |
| Locked the parent Listing for image commands and Storage upload/delete policy checks | Protects attachment order, publish/detach races, last-active-image protection, discard/upload and attach/delete races. |
| Delete policy requires an unattached object; no overwrite policy | Prevents dangling attached metadata and published-image replacement outside the commands. |
| Owner-only Storage SELECT; removed public-download policy and operation-helper dependency | The README requires private media and a future trusted signing API. |
| Bucket-relative path `<listing UUID>/<image UUID>.<extension>` | Matches the upload contract instead of the supplied extra `listings/` prefix. |
| Bucket is 10 MiB, JPEG/PNG/WebP; no AVIF; existing bucket causes a conflict | Matches README; avoids silently overwriting existing bucket configuration. |
| Added active-content completeness, finite/nonnegative-price and 500-character removal-details checks | Direct edits could otherwise null required published content; numeric NaN passes a simple nonnegative check. README specifies 500, candidate used 1000. |
| Removed candidate live-location/category locking triggers | They imposed restrictions not present in the domain: active Listing content is editable. Migration 001 already denies direct Location mutation. Future policy enforcement remains deferred explicitly. |
| Revoked table privileges from PUBLIC as well as API roles | Prevents inherited grants from bypassing the intended column-grant boundary. |

Existing sanitized public Listing reads and cursor pagination were retained and
tested. Public raw Listing rows remain inaccessible to anon; authenticated users
can select their own rows. Public RPCs hide non-public Listings and omit internal
location IDs, coordinates and moderation/removal fields. The README now describes
the already-present label/pagination behavior accurately.

## Files changed or added in this task

- `supabase/migrations/20261105_002_listings_inventory.sql` — corrected candidate.
- `supabase/migrations/002_structural_checks.sql` — removed duplicate test.
- `supabase/tests/002_structural_checks.sql` — retained supplied assertions; added
  composite-FK, invoker/search-path, schema privilege, anonymous-execution and
  discard-function checks.
- `supabase/tests/test_migration_002.py` — dependency-free local integration runner.
- `supabase/config.toml` — CLI-generated local configuration, dedicated project ID,
  no nonexistent seed file, `private` absent from exposed schemas.
- `supabase/.gitignore` — CLI-generated ignores for local runtime state.
- `docs/MIGRATION_002_README.md` — validation status, reproduction and read-API notes.
- `docs/MIGRATION_002_VALIDATION.md` — this report.

## Local environment

- Supabase CLI 3.0.0, invoked with pinned `npx --yes supabase@3.0.0`.
- PostgreSQL 17.11 / Supabase image 17.11.0.011, PostGIS 3.3.
- Auth v2.197.0, Storage v1.88.0, PostgREST v16.5.
- Project/container suffix: `bazaar-migration-test`.
- API: `http://127.0.0.1:54321`; database: `127.0.0.1:54322`.
- Actual PostgREST `PGRST_DB_SCHEMAS=public,graphql_public` verified through Docker.
- REST requests selecting `private` or `internal` return HTTP 406.

## Commands run

Repository inspection used `Get-Content`, `rg --files --hidden -g '!.git' -g
'!node_modules'`, `git status --short`, `Get-Command`, and `Get-FileHash` on both
structural SQL copies. Original candidate SQL was copied into the system temporary
directory for comparison. PostgreSQL parsing via the previously installed temporary
pglast package succeeded for both migration files before runtime validation.

Runtime commands (all executed from the repository root unless noted):

```powershell
docker info --format '{{.ServerVersion}}'
Start-Process -FilePath 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -WindowStyle Hidden
npx --yes supabase --version
npx --yes supabase@3.0.0 init
npx --yes supabase@3.0.0 start --help
docker ps --format '{{.Names}}'
npx --yes supabase@3.0.0 start --exclude studio,postgres-meta,realtime,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor
docker ps --format '{{.Names}} {{.Status}}'
python supabase/tests/test_migration_002.py
npx --yes supabase@3.0.0 db lint --local --level warning
npx --yes supabase@3.0.0 db lint --local --schema public,private --level warning
npx --yes supabase@3.0.0 db reset --local
python supabase/tests/test_migration_002.py
npx --yes supabase@3.0.0 db lint --local --schema public,private --level warning
npx --yes supabase@3.0.0 migration list --local
docker exec supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -Atc "select version(); select extensions.postgis_version();"
docker inspect supabase_rest_bazaar-migration-test --format '{{range .Config.Env}}{{println .}}{{end}}' | Select-String '^PGRST_DB_SCHEMAS='
```

The runner internally executes `npx.cmd --yes supabase@3.0.0 status -o json`
without printing credentials, and pipes fixture/assertion SQL (including the
entire structural-check file) to:

```powershell
docker exec -i supabase_db_bazaar-migration-test psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1
```

## Results and failures

- Docker initially was stopped. Starting it succeeded; concurrent image downloads
  encountered transient EOF/daemon/API errors. CLI retries recovered; services
  became healthy and migrations applied.
- First suite: 14/14 passed. Expanded final suite after clean reset: 20/20 passed,
  no skips. An HTTP error-response resource warning in the first harness was fixed
  by explicitly closing responses; it did not recur.
- Clean reset applied only versions 20261025 and 20261105, in order. Migration
  history matches repository files.
- Structural SQL passed, including original required signatures/grants.
- Owner/non-owner/anonymous tests use real local Auth tokens and REST requests.
  Verified protected-column denial, composite FK denial, incomplete/no-image
  publication failure, unchanged draft state after failure, successful publication,
  repeat rejection, soft removal, owner history access and public filtering.
- Real Storage API tests verify private uploads, cross-owner upload/read/signing
  denial, overwrite denial, owned-object attachment, missing/wrong-uploader errors,
  attached-object deletion prevention, detach/delete/discard cleanup, and the
  last-active-image rule.
- Concurrent attach gives distinct positions; concurrent publish succeeds once;
  concurrent detaches preserve one active image; attach versus Storage deletion
  leaves no dangling attached metadata. These are bounded integration checks,
  not an exhaustive stress test of all transaction interleavings.
- Missing effective location cannot be constructed with this schema: Shop default
  location is NOT NULL with an owner FK; that structural invariant is tested rather
  than disabling constraints to force an unreachable normal-client state.
- Full-schema lint reports warnings/errors inside bundled PostGIS routines,
  including dynamic-record analysis, optional raster functions and long-transaction
  helper tables. They are not application-function findings. Explicit
  `--schema public,private` lint reports no issues. No extension code was modified.

## Remaining work and limitations

1. **Public-image signing API does not exist.** No claim is made that its access
   checks have been tested. Implement a trusted endpoint accepting a Listing/image
   identifier, checking active/clear Listing plus active Shop/seller, resolving its
   attached object server-side, and only then signing with a server-only credential.
   Test draft/removed/moderated/suspended cases at that endpoint. Existing signed
   URLs remain valid until expiry; choose a short lifetime.
2. **Migration 001 follow-up hardening:** move the `public.activate_selling`
   definer implementation into `private` behind an invoker wrapper using a new
   migration. Keep its existing auth checks and behavior. This task did not rewrite
   Migration 001.
3. Publication policy enforcement remains deferred per the supplied documents.
   No jurisdiction engine, media moderation or content-scanning feature was added.
4. Public Shop DTOs, richer location precision rendering and orphan/removed-media
   retention remain application work. Neighborhood currently falls back to city.
5. No hosted configuration was inspected; the verified schema-exposure setting is
   local only. Any future environment needs its own exposure/policy review.

Recommended next step: implement and test the trusted public-media endpoint and
connect the seller draft/upload/attach/publish flow to the application. Keep chat,
transactions and payment outside this slice.
