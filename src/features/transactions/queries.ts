import type { SupabaseClient } from '@supabase/supabase-js';
import type { Transaction, TransactionView, ListingSummary, Conversation, Message } from './types';
const fields = 'id,listing_id,shop_id,conversation_id,buyer_user_id,seller_user_id,status,reserved_at,pickup_claimed_at,seller_confirmed_at,completed_at,cancelled_at,cancellation_reason,administrator_resolution_id';
export const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
// Every read uses the signed-in client. Never elevate historical listing access.
export async function listingSummary(db: SupabaseClient, id: string, owner: boolean): Promise<ListingSummary> {
  if (owner) {
    const { data, error } = await db.from('listings').select('title,asking_price,currency,status').eq('id', id).maybeSingle();
    if (error) throw error;
    if (data) {
      const images = await db.from('listing_images').select('storage_path').eq('listing_id', id).order('sort_order').limit(1);
      if (images.error) throw images.error;
      let image: string | null = null;
      if (images.data?.[0]) {
        const signed = await db.storage.from('listing-images').createSignedUrl(images.data[0].storage_path, 600);
        if (!signed.error) image = signed.data.signedUrl;
      }
      return { title: data.title || 'Untitled listing', price: data.asking_price, currency: data.currency, status: data.status, image };
    }
  }
  const { data, error } = await db.rpc('get_public_listing', { p_listing_id: id });
  if (error) throw error;
  if (!data) return { title: 'Listing details unavailable', price: null, currency: null, image: null };
  const imageId = data.images?.[0]?.storagePath?.split('/')[1]?.replace(/\.(jpg|jpeg|png|webp)$/, '');
  return { title: data.title, price: data.askingPrice, currency: data.currency, shop: data.shop.displayName,
    image: imageId && validId(imageId) ? `/api/listings/${id}/images/${imageId}` : null };
}
async function decorate(db: SupabaseClient, rows: Transaction[], userId: string): Promise<TransactionView[]> {
  return Promise.all(rows.map(async t => {
    const [listing, shop] = await Promise.all([
      listingSummary(db, t.listing_id, t.seller_user_id === userId),
      db.from('shops').select('display_name').eq('id', t.shop_id).maybeSingle(),
    ]);
    if (shop.error) throw shop.error;
    return { ...t, listing, shopName: shop.data?.display_name || 'Shop details unavailable' };
  }));
}
export async function transactions(db: SupabaseClient, user: string, role: 'buyer' | 'seller', offset: number) {
  const { data, error } = await db.from('transactions').select(fields).eq(`${role}_user_id`, user)
    .order('reserved_at', { ascending: false }).order('id').range(offset, offset + 19);
  if (error) throw error;
  return decorate(db, (data || []) as Transaction[], user);
}
export async function transaction(db: SupabaseClient, id: string, user: string) {
  if (!validId(id)) return null;
  const { data, error } = await db.from('transactions').select(fields).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? (await decorate(db, [data as Transaction], user))[0] : null;
}
export async function conversations(db: SupabaseClient, offset: number, includeHidden: boolean) {
  let query = db.from('conversations').select('id,listing_id,buyer_user_id,seller_user_id,status,created_at,conversation_user_states!inner(hidden_at,archived_at)');
  if (!includeHidden) query = query.is('conversation_user_states.hidden_at', null).is('conversation_user_states.archived_at', null);
  const { data, error } = await query.order('created_at', { ascending: false }).order('id').range(offset, offset + 19);
  if (error) throw error;
  return (data || []) as Conversation[];
}
export async function conversation(db: SupabaseClient, id: string) {
  if (!validId(id)) return null;
  const { data, error } = await db.from('conversations').select('id,listing_id,buyer_user_id,seller_user_id,status,created_at').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as Conversation | null;
}
export async function messages(db: SupabaseClient, id: string, limit: number) {
  const { data, error } = await db.from('messages').select('id,sender_user_id,body,created_at').eq('conversation_id', id)
    .order('created_at', { ascending: false }).order('id').limit(limit);
  if (error) throw error;
  return (data || []).reverse() as Message[];
}
