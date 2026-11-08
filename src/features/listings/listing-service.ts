import type { SupabaseClient } from '@supabase/supabase-js';
import type { Listing, ListingCondition, ListingImage, RemovalReason } from './types';

export async function getSellerListings(db: SupabaseClient, shopId: string): Promise<Listing[]> {
  const { data, error } = await db.from('listings')
    .select('id,shop_id,owner_user_id,title,description,asking_price,currency,category_key,condition,status,moderation_status,created_at,published_at')
    .eq('shop_id', shopId).order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Listing[];
}

export async function getSellerListing(db: SupabaseClient, listingId: string): Promise<Listing> {
  const { data, error } = await db.from('listings')
    .select('id,shop_id,owner_user_id,title,description,asking_price,currency,category_key,condition,status,moderation_status,created_at,published_at')
    .eq('id', listingId).single();
  if (error) throw error;
  return data as Listing;
}

export type EditableValues = {
  title: string;
  description: string;
  askingPrice: string;
  currency: string;
  categoryKey: string;
  condition: ListingCondition | '';
};

export function validPrice(price: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(price.trim()) &&
    Number.isFinite(Number(price)) && Number(price) <= 9999999999.99;
}

export async function createDraft(db: SupabaseClient, shopId: string, values: EditableValues) {
  validateContent(values);
  const { data, error } = await db.rpc('create_listing', {
    p_shop_id: shopId,
    p_title: values.title.trim(),
    p_asking_price: Number(values.askingPrice),
    p_currency: values.currency.toUpperCase().trim(),
    p_description: values.description.trim() || null,
    p_category_key: values.categoryKey || null,
    p_condition: values.condition || null,
    p_location_override_id: null,
  });
  if (error) throw error;
  return data as string;
}

export async function updateListing(db: SupabaseClient, listingId: string, values: EditableValues) {
  validateContent(values);
  const { data, error } = await db.from('listings').update({
    title: values.title.trim(),
    description: values.description.trim() || null,
    asking_price: Number(values.askingPrice),
    currency: values.currency.toUpperCase().trim(),
    category_key: values.categoryKey || null,
    condition: values.condition || null,
  }).eq('id', listingId).select('id').single();
  if (error) throw error;
  if (!data) throw new Error('LISTING_NOT_OWNED');
}

export async function getImages(db: SupabaseClient, listingId: string): Promise<ListingImage[]> {
  const { data, error } = await db.from('listing_images')
    .select('id,listing_id,storage_path,alt_text,sort_order')
    .eq('listing_id', listingId).order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ListingImage[];
}

const extensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};

export async function uploadListingImage(db: SupabaseClient, listingId: string, file: File) {
  if (!extensions[file.type]) throw new Error('Only JPEG, PNG or WebP images are supported.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Each image must be 10 MB or less.');
  const imageId = crypto.randomUUID();
  const extension = extensions[file.type];
  const path = `${listingId}/${imageId}.${extension}`;
  const { error: uploadError } = await db.storage.from('listing-images')
    .upload(path, file, { contentType: file.type, cacheControl: '60', upsert: false });
  if (uploadError) throw uploadError;
  const { error: attachError } = await db.rpc('attach_listing_image', {
    p_listing_id: listingId, p_image_id: imageId,
    p_extension: extension, p_alt_text: null,
  });
  if (attachError) {
    // Before metadata attaches, Storage's owner-delete policy permits cleanup.
    const { error: cleanupError } = await db.storage.from('listing-images').remove([path]);
    if (cleanupError) throw new Error(`${attachError.message}; orphan upload cleanup also failed: ${cleanupError.message}`);
    throw attachError;
  }
}

export async function signedOwnerImageUrl(db: SupabaseClient, image: ListingImage) {
  const { data, error } = await db.storage.from('listing-images')
    .createSignedUrl(image.storage_path, 600);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteListingImage(db: SupabaseClient, imageId: string): Promise<string | null> {
  const { data: path, error } = await db.rpc('detach_listing_image', { p_image_id: imageId });
  if (error) throw error;
  const { data: deleted, error: deleteError } = await db.storage.from('listing-images').remove([path]);
  if (deleteError) return `The photo was detached but Storage cleanup failed: ${deleteError.message}`;
  if (!deleted?.length) return 'The photo was detached, but cleanup could not be confirmed. Use Retry unused photo cleanup.';
  return null;
}

export async function publishListing(db: SupabaseClient, listingId: string) {
  const { error } = await db.rpc('publish_listing', { p_listing_id: listingId });
  if (error) throw error;
}

export async function removeListing(
  db: SupabaseClient, listingId: string, reason: RemovalReason, details: string,
) {
  const { error } = await db.rpc('remove_listing', {
    p_listing_id: listingId, p_reason: reason, p_details: details || null,
  });
  if (error) throw error;
}

export async function discardDraft(db: SupabaseClient, listingId: string) {
  await cleanupUnattachedImages(db, listingId);
  const { error } = await db.rpc('discard_draft_listing', { p_listing_id: listingId });
  if (error) throw error;
}

function validateContent(values: EditableValues) {
  if (!values.title.trim()) throw new Error('TITLE_REQUIRED');
  if (values.title.trim().length > 120 || values.description.length > 5000) throw new Error('CONTENT_TOO_LONG');
  if (!validPrice(values.askingPrice)) throw new Error('INVALID_PRICE');
  if (!/^[A-Z]{3}$/.test(values.currency.toUpperCase().trim())) throw new Error('INVALID_CURRENCY');
}

export async function cleanupUnattachedImages(db: SupabaseClient, listingId: string) {
  // Retry orphan cleanup without removing any attached objects.
  const attached = new Set((await getImages(db, listingId)).map(image => image.storage_path));
  const paths: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await db.storage.from('listing-images').list(listingId, { limit: 100, offset });
    if (error) throw error;
    paths.push(...(data ?? []).filter(object => object.id).map(object => `${listingId}/${object.name}`)
      .filter(path => !attached.has(path)));
    if (!data || data.length < 100) break;
  }
  if (!paths.length) return;
  const { data, error } = await db.storage.from('listing-images').remove(paths);
  if (error || data?.length !== paths.length) throw new Error('PHOTO_CLEANUP_FAILED');
}
