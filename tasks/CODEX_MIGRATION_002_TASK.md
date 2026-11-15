# Codex task — review and integrate Migration 002

Read `AGENTS.md` and all `docs/` domain specifications before making changes.

We are implementing the Listings/Inventory vertical slice. The candidate migration is:

`supabase/migrations/20261105_002_listings_inventory.sql`

**Inspect first; don't blindly apply it.** Compare against existing migrations, Supabase configuration, buckets, existing Auth/Supabase client conventions, and any current SQL tests. Do not silently change the agreed domain model.

## Required work

1. Validate PostgreSQL syntax and Supabase compatibility, paying particular attention to `private` security-definer functions, public invoker wrappers, RLS, role/table grants, Storage bucket policies, and the composite owner FKs.
2. Resolve only **concrete** conflicts with the existing repo, documenting every alteration.
3. Apply in a local/disposable test Supabase database; do not deploy to production without explicit approval.
4. Run `supabase/tests/002_structural_checks.sql` and any existing migration tests.
5. Add integration tests for owner/non-owner/anonymous users, draft→active publication, active→removed removal, invalid location override, missing image, direct-status-update rejection, Storage upload/attach/detach, and concurrency.
6. Verify Storage uploads are private and that media cannot be signed for a non-public Listing via the intended server API. If that API does not yet exist, identify it as the next required implementation—not as an already-completed capability.
7. Confirm that the project does not expose the `private` schema through Supabase Data API.
8. Flag the Migration 001 public `SECURITY DEFINER activate_selling()` for follow-up hardening, but keep the task focused on Migration 002.
9. Do not implement chat, transactions, offers, reviews, shipping, payment, or subscription features.

## When finished, report

- files added/changed;
- exact commands run;
- test results (including failures and untested items);
- any differences from the supplied migration, with rationale;
- remaining security/launch blockers;
- recommended next vertical implementation step.
