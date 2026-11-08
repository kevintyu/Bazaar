# Seller UI integration report

## Outcome

Integrated the supplied Next.js App Router seller home/dashboard, listing editor,
image management, public browse/item/shop pages and trusted public-image endpoint
with the existing migrations. The browser Supabase session, email/password Auth
form, route paths, CSS and overall starter design were preserved. No other Auth
provider, SSR cookie refresh or pre-existing application outside the bundle was
present. No messaging, transaction feature, database migration, RPC change or
production deployment was introduced.

## Compatibility corrections

- Public queries used raw `listings`/`listing_images` reads, which Migration 002
  denies to anon. Replaced them with `browse_public_listings` and
  `get_public_listing`, adapting camel-case DTOs into page props. Image IDs derive
  from the documented UUID filenames. No raw path or location fields are passed
  to page props. Shop lookup selects only presentation columns and requires
  publicly eligible listings before rendering the shop page.
- Shop filtering walks the existing public cursor API instead of filtering only
  the newest global page and hiding older shops. Page output remains limited to
  40 cards. This avoids a schema change but is not the final scalable shop query.
- Draft titles, prices and currencies can be null in SQL. Corrected types,
  editor defaults and dashboard price/title fallbacks; tested an RPC-created
  empty draft and its direct navigation/refresh/discard.
- New editors wait for authentication and ownership checks. Failed ownership
  checks no longer render mutation controls or misleading empty dashboards.
  Onboarding checks the session and existing seller capability before activation.
- Kept all lifecycle changes in existing RPCs, and only allowed content columns
  in direct updates. Added currency/content-length validation and mapped actual
  migration errors to readable messages.
- Photo previews refresh after partial upload failures. Owner previews are
  allowed in historical states, matching the actual Storage read policy.
  Image deletion is disabled while save/publication runs. Cleanup can be retried;
  draft discard attempts removal of unreferenced objects left by prior failures.
  Unconfirmed Storage deletion reports a warning rather than claiming success.
- The server-only image route retains ID validation and checks Listing, Shop,
  seller and image membership before signing for 60 seconds. All denied
  responses are non-cacheable and server failure logs contain no raw SDK error
  object. No secret is sent to the browser.
- Added loading/error boundaries and retained desktop/mobile styling.

## Files changed from the supplied bundle

| File | Change |
| --- | --- |
| `src/lib/public-queries.ts` | Sanitized RPC adapter, ID validation and shop cursor traversal |
| `src/features/listings/types.ts` | Nullable draft fields |
| `src/features/listings/format.ts` (new) | Safe draft price display |
| `src/features/listings/listing-service.ts` | Validation and orphan-cleanup retry |
| `src/features/listings/errors.ts` | Migration error mapping |
| `src/components/seller/listing-editor.tsx` | Auth/ownership loading, nullable fields, previews and cleanup |
| `src/components/seller/listings-dashboard.tsx` | Denied-access state and empty-draft display |
| `src/components/seller/start-selling-form.tsx` | Session and existing-seller guard |
| `src/app/api/listings/[listingId]/images/[imageId]/route.ts` | Uniform no-store denial and safe failure logging |
| `src/app/error.tsx` (new) | Retryable public-page error state |
| `src/app/loading.tsx` (new) | Loading feedback |
| `package.json`, `package-lock.json` (new lock) | Reproducible dependencies, pinned Playwright and test scripts |
| `playwright.config.ts` (new) | Local-only production-build browser testing |
| `tests/seller-ui.spec.ts` (new) | Six end-to-end/security checks |
| `.gitignore` | Ignore test artifacts |
| `README.md` | Integrated setup/testing instructions |
| `docs/SELLER_UI_INTEGRATION.md` (new) | This report |

An ignored `.env.local` was created only after confirming no such file existed;
it contains the local Supabase URL, anon key and server-only service role key.
Neither actual values nor the file are committed. Existing domain files,
Migration 001 and Migration 002 were not edited in this task. Other initial
uncommitted/untracked bundle and documentation files were preserved.

## Commands and validation

```powershell
npm install
npm install --save-dev @playwright/test@1.56.1
npx playwright install chromium
npx --yes supabase@3.0.0 start --exclude studio,postgres-meta,realtime,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor
npx --yes supabase@3.0.0 db reset --local
python supabase/tests/test_migration_002.py
npm run typecheck
npm run build
npm run test:e2e
```

Local environment values were read through `supabase status -o json` without
printing credentials. Docker Desktop was started hidden when it was stopped.
Tests run against the dedicated `supabase_db_bazaar-migration-test` container,
local Auth/Storage/REST services, and a local production Next.js server.

- TypeScript: passes. The initial nullable-draft errors were fixed.
- Production build: passes on Next.js 16.4.5. All intended routes are present.
- Database reset: applied Migrations 001 and 002 successfully.
- Existing database suite: 20/20 passed, including structural checks, RLS,
  Storage ownership, atomic failures and concurrency.
- Browser suite: six tests pass. Covers UI account registration, activation,
  draft persistence on refresh, upload, publish, browse/item/shop views, removal;
  anonymous/non-owner control denial; empty draft rendering/discard; image
  authorization before publication, after removal, under moderation, with a
  suspended Shop or banned seller, and mismatched image IDs; cleanup failure and
  retry; no server credential in browser assets/source maps.
- Image response tests followed the signed redirect and verified the image was
  accessible. Private address and raw Location fields do not appear in public HTML.
- Desktop editor and 390px mobile shop screenshots were inspected. The mobile
  document has no horizontal overflow. Screenshots use a deliberately tiny test
  PNG, not production product photography.
- Latest unpinned Playwright install failed because its playwright-core@1.65.0
  dependency was unavailable from the registry; pinned 1.56.1 installed and ran.
- Initial browser failures were selector ambiguity (Next's route announcer is
  also an alert, and nested select label matching). Selectors were corrected.
  Docker also restarted during the interrupted session; tests were resumed only
  after local containers were healthy.

## Remaining limitations

- No hosted environment was tested. OAuth, password recovery, MFA, confirmation-
  email redirects and cookie-based SSR authentication remain outside this slice.
  Browser-session sign-in, registration and refresh were tested.
- Categories remain illustrative. Prohibited-item/jurisdiction enforcement and
  moderation are still launch blockers documented by the domain bundle.
- Public shop pages currently require an eligible Listing. Add a dedicated
  sanitized, owner-status-aware shop query and server-side shop filtering later.
- Location override editing is not included; existing overrides are preserved.
  No exact location is rendered by these pages.
- Signed URLs already issued can remain usable until expiry (public: 60 seconds;
  owner preview: 10 minutes). This is not instant revocation. Media rate limits,
  content scanning, long-term orphan retention and automatic preview refresh are
  still future work.
- Browser tests cover Chromium desktop and a mobile viewport, not a full
  cross-browser or accessibility audit. The original removal dialog remains
  simple; richer focus management is a follow-up.
- Migration 001's public seller-activation definer hardening remains a separate
  future migration, as documented previously.

Next suggested step: define the supported category/publication policy and add the
dedicated safe public-Shop query, before expanding to messaging or transactions.
