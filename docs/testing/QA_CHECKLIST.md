# Seller UI manual and integration QA checklist

## Auth and seller onboarding

- [ ] Buyer creates account; Profile exists, selling_enabled initially false.
- [ ] Non-authenticated visitor to `/sell` is prompted to sign in.
- [ ] Seller activation creates exactly one initial Shop/Location atomically.
- [ ] Duplicate seller activation does not create a second included Shop.
- [ ] Seller sees only Shops they own on seller home.

## Listing creation and updates

- [ ] Seller creates DRAFT; it is invisible in public browse.
- [ ] A different User cannot create a Listing in seller's Shop.
- [ ] Draft title and price edits persist after refresh.
- [ ] Direct attempt to update Listing status is denied.
- [ ] Cannot publish without category, condition, photo, location.
- [ ] Successful publication transitions DRAFT to ACTIVE once.
- [ ] Public active listing appears in browse/shop/item views.
- [ ] Removed Listing disappears from public browse and item view.
- [ ] Removing without a reason is disallowed by RPC.
- [ ] Duplicate removal attempts fail without corrupting state.
- [ ] Draft can be discarded once its images are removed.

## Images

- [ ] Only JPEG, PNG and WebP <= 10 MB accepted.
- [ ] Photo upload is stored under the correct listing UUID prefix.
- [ ] Attaching a file not actually uploaded fails.
- [ ] Non-owner cannot upload to another Listing prefix.
- [ ] Owner sees private preview; anon cannot retrieve draft image.
- [ ] Public image route works for ACTIVE/CLEAR Listing only.
- [ ] Image route returns 404 for REMOVED/draft/under-review listing.
- [ ] Image route returns 404 when Shop or account inactive.
- [ ] Last photo on ACTIVE Listing cannot be detached.
- [ ] Photo detaches before Storage deletion; cleanup failure is surfaced.
- [ ] No server-side secret is exposed client-side.

## Security and robustness

- [ ] Owner actions require logged-in User.
- [ ] Shop ownership checked on both seller dashboard and editor.
- [ ] RLS denies cross-user Listing reads of draft/removed rows.
- [ ] Public Shop/Listing endpoint never exposes raw Location coordinates/address.
- [ ] Server image route signs only a path looked up by verified IDs.
- [ ] Domain RPC errors become helpful non-technical messages.
- [ ] Double-click/parallel operation tests cannot create inconsistent records.
- [ ] Error, empty, slow-loading and mobile states are usable.

## Pre-launch blockers (not part of this slice)

- [ ] Global and jurisdiction-specific prohibited-item checks.
- [ ] Admin moderation/report flow.
- [ ] Rate limiting and abuse controls on images and account flows.
- [ ] Signed URL retention/revocation policy.
- [ ] Image moderation / security validation.
- [ ] Privacy-safe public location API and shop visibility policy.
