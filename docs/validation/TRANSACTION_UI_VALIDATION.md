# Buyer and seller transaction UI — validation completed 2026-11-25

## Outcome and architecture

Added participant transaction and minimal chat pages to the existing Next.js App
Router application. Existing browser Supabase initialization, email/password Auth,
seller routes, shared styles and database policies remain in use. No schema or
migration change was needed. The preceding Migration 005 implementation and its
documentation were already uncommitted at the start of this task and were preserved.

Queries and commands live in `src/features/transactions`. Shared client components
render lists/details and authenticated loading/error/empty states. All database reads
use the signed-in client and RLS; there is no service-role transaction API. The
private evidence, notification and administrator tables are never queried.

The legacy `awaiting_buyer_confirmation` value renders as **Awaiting seller
confirmation**. Only a buyer sees pickup claim controls, and only the seller sees
confirmation after a claim. Cancellation is offered only while RESERVED. The database
independently checks roles, restrictions and transitions. Administrator resolutions
and DISPUTED status are represented without administrator controls or evidence.

## Routes and behavior

- `/purchases`: paginated buyer transactions, including completed/cancelled history.
- `/sales`: paginated seller transactions; pending confirmations are called out.
- `/transactions/[transactionId]`: status progression, dates, cancellation reason,
  authorized listing information, conversation link and confirmation dialogs.
- `/messages`: participant inbox; hidden/archived history is an explicit opt-in.
- `/messages/[conversationId]`: retained messages, text sending, transaction links
  and seller-only reservation of the selected conversation's buyer.
- Public listing pages now have a Message seller action. Existing conversations are
  reopened by ID without invoking start_conversation on RESERVED listings.

Native dialogs support keyboard focus containment, Escape and focus restoration.
Buttons disable while submitting, with synchronous guards against rapid clicks.
Reservation request UUIDs are persisted before sending and reused after uncertain
transport failures, including reloads. Successful receipts clear the key. A retained
key that returns an old receipt after cancellation displays that original result;
it never silently reserves again. A subsequent new intent uses a fresh UUID.

Reads refresh after successful and rejected operations, on navigation/reload, window
focus, and every 15 seconds while visible. Responses replace state rather than append
cards; superseded requests cannot overwrite newer results. No transaction Realtime
infrastructure is introduced. Successful RPC receipt messages describe the refreshed
status, including a later concurrent resolution; a failed refresh is not reported as
successful state verification. Messages remain readable after SOLD and the composer
is removed when the conversation concludes.

## Existing RPC contracts used

All return UUID and derive the acting identity from `auth.uid()`:

| RPC | Parameters |
|---|---|
| `reserve_listing` | `p_conversation_id uuid, p_request_id uuid` |
| `cancel_transaction` | `p_transaction_id uuid, p_reason text default null` |
| `claim_pickup` | `p_transaction_id uuid` |
| `confirm_pickup_claim` | `p_transaction_id uuid` |
| `start_conversation` | `p_listing_id uuid` |
| `send_message` | `p_conversation_id uuid, p_body text, p_client_message_id uuid` |

Read-only `get_public_listing(p_listing_id uuid)` supplies its existing sanitized
JSON DTO when public visibility allows it. Seller-only listing and image reads use
existing owner permissions and signed Storage URLs. Amounts use stored currency and
are labelled current asking prices, not negotiated transaction receipts.

## Exact files created

- `src/app/purchases/page.tsx`
- `src/app/sales/page.tsx`
- `src/app/transactions/[transactionId]/page.tsx`
- `src/app/messages/page.tsx`
- `src/app/messages/[conversationId]/page.tsx`
- `src/components/transactions/workspace.tsx`
- `src/components/transactions/transaction-pages.tsx`
- `src/components/transactions/conversation-pages.tsx`
- `src/features/transactions/types.ts`
- `src/features/transactions/queries.ts`
- `src/features/transactions/commands.ts`
- `tests/transactions-ui.spec.ts`
- `docs/validation/TRANSACTION_UI_VALIDATION.md`

## Exact existing files modified in this task

- `src/app/layout.tsx`: navigation links.
- `src/app/globals.css`: responsive cards, dialogs, messages and status styling.
- `src/app/listing/[listingId]/page.tsx`: contact-seller entry point.
- `README.md`: routes and prerequisites.
- `docs/ROADMAP.md`: participant UI status and remaining read-model limitation.
- `docs/validation/README.md`: this report's navigation link.

## Validation

Local Supabase target: `127.0.0.1:54321`, database `127.0.0.1:54322`.
Real, separate authenticated buyer/seller/stranger fixtures were used. Privileged
SQL only sets controlled fixture restrictions or asserts database results.

| Command | Result |
|---|---|
| `npx.cmd --yes supabase@3.0.0 migration list --local` | Eight matching applied versions, including 005 |
| `npm.cmd run typecheck` | Passed |
| `npm.cmd run build` | Passed production build and route generation |
| `npx.cmd playwright install chromium` | Installed missing local browser dependency |
| `npm.cmd run test:e2e` | Final run: all 10 passed (six existing seller tests and four new transaction tests) |
| `python supabase/tests/test_migration_005.py` | All 27 passed, including 14 inherited reserve/cancel regressions |
| `python supabase/tests/test_migration_002.py` | All 20 passed |
| `node scripts/validate_messaging_003.mjs` | All seven groups passed, including RESERVED chat behavior, concurrency and Realtime isolation |
| SHA-256 comparison against start-of-task snapshot | All eight applied SQL files and the archived candidate are byte-for-byte unchanged |
| `git diff --check` and updated Markdown link validation | Passed |

Initial browser runs failed because Chromium was missing, then because new test
selectors matched duplicate labels/Next's accessibility announcer and one assertion
ran before route navigation completed. Browser installation and test synchronization/
scoping corrected these failures; the final suite passed without skipping tests.

Browser coverage includes the full reserve/claim/confirm flow, exact buyer binding,
no premature SOLD, single RPC for rapid double-click, retained history, stranger
isolation, restricted cancellation, a stale claim dialog after concurrent cancellation,
response loss with durable reservation UUID, sign-in/empty views, hidden history,
read-only completed chat and mobile overflow. Desktop and 390px mobile screenshots
were inspected in `test-results/transactions-desktop.png` and
`test-results/transactions-mobile.png`. These generated files are ignored artifacts.

## Remaining limitations and safeguards

- Existing RLS allows buyers to read transaction rows, but does not grant them
  reserved/sold listing titles, thumbnails or amounts. Those fields display an
  explicit unavailable placeholder; seller owner access remains intact. Shops are
  shown only when existing policies permit reading them.
- Counterparty profiles are private. Seller views use the already-authorized buyer
  UUID reference rather than retrieving a name through elevated access. Improving
  these summaries needs an approved participant-safe read contract; no broadening
  of RLS or new database projection was silently introduced.
- Minimal chat refreshes periodically rather than delivering live subscriptions.
  A transport-failed message retry within the mounted page reuses its message UUID;
  drafts are not persisted across page reloads. Full messaging product work remains
  separate from this minimal transaction entry point.
- No administrator dashboard, payment/review workflow, automatic completion or
  notification delivery was added. Outbox intents are not treated as delivered.
- Applied migrations, archived candidate and migration history are preserved;
  no reset, history repair, migration application or production operation ran.
