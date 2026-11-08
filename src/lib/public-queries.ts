import 'server-only';
import { publicSupabase } from '@/lib/supabase/public';

export type PublicImage = { id: string; sort_order: number };
export type PublicCard = {
  id: string; shop_id: string; title: string; asking_price: number;
  currency: string; published_at: string; listing_images: PublicImage[];
};
type PublicRpcListing = {
  id: string; title: string; description: string | null; askingPrice: number;
  currency: string; categoryKey: string; condition: string; publishedAt: string;
  shop: { id: string; displayName: string };
  images: { storagePath: string; altText: string | null }[];
};
export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function imageRoute(listingId: string, imageId: string) {
  return `/api/listings/${encodeURIComponent(listingId)}/images/${encodeURIComponent(imageId)}`;
}

// Migration 002 returns a public DTO, not publicly selectable table rows.
// Image filenames are UUIDs assigned by attach_listing_image. Do not forward
// paths or location fields to the browser; the image endpoint accepts IDs only.
function fromRpc(row: PublicRpcListing) {
  return {
    id: row.id, shop_id: row.shop.id, title: row.title,
    description: row.description, asking_price: row.askingPrice,
    currency: row.currency, category_key: row.categoryKey, condition: row.condition,
    published_at: row.publishedAt,
    listing_images: row.images.flatMap((image, index) => {
      const [folder, filename] = image.storagePath.split('/');
      const id = filename?.replace(/\.(jpg|jpeg|png|webp)$/, '');
      return folder === row.id && id && isUuid(id) ? [{ id, sort_order: index }] : [];
    }),
  };
}

export async function publicListings(shopId?: string): Promise<PublicCard[]> {
  if (shopId && !isUuid(shopId)) return [];
  const db = publicSupabase();
  const items: PublicCard[] = [];
  let cursor: { p_before_published_at: string; p_before_id: string } | undefined;
  do {
    const { data, error } = await db.rpc('browse_public_listings', { p_limit: 50, ...cursor });
    if (error) throw error;
    const page = (data ?? []) as PublicRpcListing[];
    items.push(...page.filter(row => !shopId || row.shop.id === shopId).map(fromRpc));
    if (page.length < 50 || items.length >= 40) break;
    const last = page[page.length - 1];
    cursor = { p_before_published_at: last.publishedAt, p_before_id: last.id };
  } while (shopId);
  return items.slice(0, 40);
}

export async function publicListing(listingId: string) {
  if (!isUuid(listingId)) return null;
  const { data, error } = await publicSupabase().rpc('get_public_listing', { p_listing_id: listingId });
  if (error) throw error;
  return data ? fromRpc(data as PublicRpcListing) : null;
}

export async function publicShop(shopId: string) {
  if (!isUuid(shopId)) return null;
  const { data, error } = await publicSupabase().from('shops')
    .select('id,display_name,description').eq('id', shopId).eq('status', 'active').maybeSingle();
  if (error) throw error;
  return data;
}
