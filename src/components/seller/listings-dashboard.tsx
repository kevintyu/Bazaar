'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { browserSupabase } from '@/lib/supabase/browser';
import { formatPrice } from '@/features/listings/format';
import { readableError } from '@/features/listings/errors';
import { getSellerListings, removeListing, discardDraft, getImages, deleteListingImage } from '@/features/listings/listing-service';
import { REMOVAL_REASONS, type Listing, type RemovalReason } from '@/features/listings/types';

export function ListingsDashboard({ shopId }: { shopId: string }) {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);
  const [shopName, setShopName] = useState('');
  const [items, setItems] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [reason, setReason] = useState<RemovalReason>('no_longer_selling');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    const db = browserSupabase();
    const { data: auth, error: authErr } = await db.auth.getUser();
    if (authErr || !auth.user) { router.push('/auth'); return; }
    const { data: shop, error: shopErr } = await db.from('shops')
      .select('id,display_name,owner_user_id').eq('id', shopId).maybeSingle();
    if (shopErr) throw shopErr;
    if (!shop || shop.owner_user_id !== auth.user.id) throw new Error('This shop does not belong to your account.');
    setShopName(shop.display_name);
    setItems(await getSellerListings(db, shopId));
    setAuthorized(true);
  }, [shopId, router]);
  useEffect(() => {
    let alive = true;
    load().catch(e => { if (alive) setError(readableError(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [load]);
  async function confirmRemove() {
    if (!pendingId) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await removeListing(browserSupabase(), pendingId, reason, details);
      setPendingId(null); setDetails(''); await load();
      setMessage('Listing removed from the public marketplace.');
    } catch (e) { setError(readableError(e)); }
    finally { setBusy(false); }
  }
  async function confirmDiscard(id: string) {
    if (!window.confirm('Permanently discard this draft? This cannot be undone.')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const db = browserSupabase();
      const images = await getImages(db, id);
      for (const image of images) {
        const warning = await deleteListingImage(db, image.id);
        if (warning) throw new Error(warning);
      }
      await discardDraft(db, id);
      await load(); setMessage('Draft discarded.');
    } catch (e) { setError(readableError(e)); }
    finally { setBusy(false); }
  }
  if (loading) return <p className="muted">Loading listings…</p>;
  if (!authorized) return <p role="alert" className="error">{error || 'Sign in to view this shop.'}</p>;
  return <section>
    <div className="page-heading"><div><Link href="/sell" className="back-link">← Your shops</Link><p className="eyebrow">Seller dashboard</p><h1>{shopName || 'Your listings'}</h1><p className="muted">Draft, publish, and manage items in your shop.</p></div>
      <Link className="button primary" href={`/sell/shops/${shopId}/listings/new`}>+ New listing</Link></div>
    {message && <p className="notice" role="status">{message}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {items.length === 0 ? <div className="panel empty"><h2>No listings yet</h2><p className="muted">Start with an item you no longer need.</p><Link className="button primary" href={`/sell/shops/${shopId}/listings/new`}>Create your first listing</Link></div>
      : <div className="table-wrap"><table className="listing-table"><thead><tr><th>Listing</th><th>Price</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {items.map(item => <tr key={item.id}>
          <td><strong>{item.title || 'Untitled draft'}</strong><div className="small muted">{new Date(item.created_at).toLocaleDateString()}</div></td>
          <td>{formatPrice(item.asking_price,item.currency)}</td>
          <td><span className={`status ${item.status}`}>{item.status}</span></td>
          <td className="actions"><Link className="text-link" href={`/sell/shops/${shopId}/listings/${item.id}`}>{['draft','active'].includes(item.status) ? 'Edit' : 'View'}</Link>
            {item.status === 'active' && <button className="text-button danger-text" disabled={busy} onClick={() => { setPendingId(item.id); setReason('no_longer_selling'); setDetails(''); }}>Remove</button>}
            {item.status === 'draft' && <button className="text-button danger-text" disabled={busy} onClick={() => void confirmDiscard(item.id)}>Discard</button>}
            {item.status === 'active' && <Link className="text-link" href={`/listing/${item.id}`}>Public page</Link>}
          </td>
        </tr>)}
      </tbody></table></div>}
    {pendingId && <div className="modal-backdrop" role="presentation"><div role="dialog" aria-modal="true" aria-labelledby="remove-title" className="panel dialog">
      <h2 id="remove-title">Remove this listing?</h2><p className="muted">It will no longer appear in browsing or search.</p>
      <label>Why are you removing it?<select value={reason} onChange={e => setReason(e.target.value as RemovalReason)}>{REMOVAL_REASONS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}</select></label>
      {reason === 'wants_to_change_listing' && <p className="notice">You can edit the listing instead if you only need to change its details.</p>}
      <label>Details (optional)<textarea maxLength={500} rows={3} value={details} onChange={e => setDetails(e.target.value)} /></label>
      <div className="actions"><button className="button" onClick={() => setPendingId(null)} disabled={busy}>Keep listing</button><button className="button danger" disabled={busy} onClick={() => void confirmRemove()}>{busy ? 'Removing…' : 'Remove listing'}</button></div>
    </div></div>}
  </section>;
}
