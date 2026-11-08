const messages: Record<string, string> = {
  SHOP_NOT_OWNED: 'This shop does not belong to your account.',
  SELLING_NOT_ALLOWED: 'Your account or shop cannot sell right now.',
  SELLING_ALREADY_ENABLED: 'Your shop already exists. Open My shop to manage it.',
  ACCOUNT_NOT_ACTIVE: 'Your account cannot sell right now.',
  SHOP_NAME_REQUIRED: 'Enter a shop name.',
  INVALID_COUNTRY_CODE: 'Enter a two-letter country code.',
  CONTENT_TOO_LONG: 'Keep the title under 121 characters and description under 5,001.',
  IMAGE_MISSING_OR_NOT_OWNED: 'The uploaded photo could not be verified. Try uploading it again.',
  IMAGE_MISSING_STORAGE_OBJECT: 'A photo is missing. Remove it and upload it again.',
  LAST_ACTIVE_IMAGE_REQUIRED: 'A published listing needs at least one photo. Add another before removing this one.',
  LISTING_IMAGES_REQUIRE_CLEANUP: 'Clean up unused photos before discarding this draft.',
  PHOTO_CLEANUP_FAILED: 'Photo cleanup could not finish. Use Retry unused photo cleanup and try again.',
  LISTING_NOT_FOUND: 'This listing is unavailable.',
  IMAGE_NOT_FOUND: 'This photo is no longer attached. Reload the editor.',
  REMOVAL_REASON_REQUIRED: 'Choose a reason for removing the listing.',
  REMOVAL_DETAILS_TOO_LONG: 'Keep removal details to 500 characters.',
  UNAUTHENTICATED: 'Sign in to continue.',
  SHOP_NOT_OWNED_OR_ACTIVE: 'You cannot create listings in this shop.',
  LISTING_NOT_OWNED: 'You do not have permission to edit this listing.',
  SHOP_NOT_ACTIVE: 'This shop cannot publish listings right now.',
  TITLE_REQUIRED: 'Enter a listing title.',
  INVALID_PRICE: 'Enter a valid non-negative price.',
  INVALID_CURRENCY: 'Enter a three-letter currency code.',
  INVALID_LISTING_STATE: 'This action is not available in the current listing state.',
  LISTING_INCOMPLETE: 'Add a category, condition, title, price, and currency before publishing.',
  IMAGE_REQUIRED: 'Upload at least one photo before publishing.',
  LOCATION_REQUIRED: 'Your shop needs a default location before publishing.',
  IMAGE_NOT_UPLOADED: 'Image upload was not found. Try uploading the file again.',
  REMOVE_IMAGES_FIRST: 'Remove your uploaded images before discarding the draft.',
};

export function readableError(error: unknown): string {
  if (error instanceof Error) return messages[error.message] ?? error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    if ('code' in error) {
      if (error.code === '42501') return 'You do not have permission to perform this action.';
      if (error.code === '22P02') return 'One of the values is invalid. Check the form and try again.';
      if (error.code === '23505') return 'This item was already saved. Reload to see the latest changes.';
      if (error.code === '23503') return 'Choose a location or shop that belongs to your account.';
      if (error.code === '23514') return 'Check your listing details. Published listings need a title, price, currency, category and condition.';
    }
    const message = String(error.message);
    return messages[message] ?? message;
  }
  return 'Something went wrong. Please try again.';
}
