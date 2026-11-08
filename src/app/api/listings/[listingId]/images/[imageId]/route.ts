import { adminSupabase } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Route receives ONLY ids, never an arbitrary bucket path.
// It confirms the listing, shop, seller and image are public before signing.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ listingId: string; imageId: string }> },
) {
  const { listingId, imageId } = await params;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(listingId) || !uuid.test(imageId)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  try {
    const admin = adminSupabase();
    const { data: listing, error: listingError } = await admin.from('listings')
      .select('id,shop_id,status,moderation_status').eq('id',listingId).maybeSingle();
    if (listingError || !listing || listing.status !== 'active' || listing.moderation_status !== 'clear')
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

    const { data: shop, error: shopError } = await admin.from('shops')
      .select('owner_user_id,status').eq('id',listing.shop_id).maybeSingle();
    if (shopError || !shop || shop.status !== 'active') return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

    const { data: seller, error: sellerError } = await admin.from('profiles')
      .select('status,selling_enabled').eq('id',shop.owner_user_id).maybeSingle();
    if (sellerError || !seller || seller.status !== 'active' || seller.selling_enabled !== true)
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

    const { data: image, error: imageError } = await admin.from('listing_images')
      .select('storage_path').eq('listing_id',listingId).eq('id',imageId).maybeSingle();
    if (imageError || !image) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

    const { data, error } = await admin.storage.from('listing-images')
      .createSignedUrl(image.storage_path, 60);
    if (error || !data?.signedUrl) throw error ?? new Error('Unable to sign image');

    return new Response(null, {
      status: 302,
      headers: { Location: data.signedUrl, 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch {
    console.error('Public image signing unavailable');
    return new Response('Image unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
