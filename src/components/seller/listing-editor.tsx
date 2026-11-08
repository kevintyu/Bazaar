'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { browserSupabase } from '@/lib/supabase/browser';
import { readableError } from '@/features/listings/errors';
import {
  createDraft, updateListing, getSellerListing, getImages, uploadListingImage,
  signedOwnerImageUrl, deleteListingImage, publishListing, validPrice, cleanupUnattachedImages,
  type EditableValues,
} from '@/features/listings/listing-service';
import { CATEGORIES, CONDITIONS, type ListingImage, type ListingStatus } from '@/features/listings/types';

type Preview = ListingImage & { url: string };
const initial: EditableValues = { title:'', description:'', askingPrice:'', currency:'CAD', categoryKey:'', condition:'' };

export function ListingEditor({ shopId, listingId }: { shopId: string; listingId?: string }) {
  const router = useRouter();
  const [values, setValues] = useState<EditableValues>(initial);
  const [images, setImages] = useState<Preview[]>([]);
  const [status, setStatus] = useState<ListingStatus>('draft');
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const canEdit = status === 'draft' || status === 'active';
  async function refreshImages(id: string) {
    const db = browserSupabase();
    const data = await getImages(db, id);
    const decorated = await Promise.all(data.map(async image => ({
      ...image, url: await signedOwnerImageUrl(db, image),
    })));
    setImages(decorated);
  }
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const db = browserSupabase();
        const { data: auth, error: authError } = await db.auth.getUser();
        if (authError || !auth.user) { router.replace('/auth'); return; }
        const { data: shop, error: shopError } = await db.from('shops')
          .select('id,owner_user_id').eq('id', shopId).maybeSingle();
        if (shopError) throw shopError;
        if (!shop || shop.owner_user_id !== auth.user.id) throw new Error('This shop does not belong to you.');
        if (listingId) {
          const listing = await getSellerListing(db, listingId);
          if (listing.shop_id !== shopId || listing.owner_user_id !== auth.user.id) throw new Error('Listing does not belong to this shop.');
          if (!alive) return;
          setValues({ title:listing.title ?? '', description:listing.description || '',
            askingPrice:listing.asking_price === null ? '' : String(listing.asking_price), currency:listing.currency ?? 'CAD',
            categoryKey:listing.category_key || '', condition:listing.condition || '' });
          setStatus(listing.status);
          // Owners retain private read access to historical listings.
          {
            const data = await getImages(db, listingId);
            const previews = await Promise.all(data.map(async image => ({ ...image, url: await signedOwnerImageUrl(db, image) })));
            if (alive) setImages(previews);
          }
        }
        if (alive) setAuthorized(true);
      } catch (e) { if (alive) setError(readableError(e)); }
      finally { if (alive) setLoading(false); }
    }
    void load(); return () => { alive = false; };
  }, [shopId, listingId, router]);
  function field<K extends keyof EditableValues>(key: K, next: EditableValues[K]) {
    setValues(prev => ({ ...prev, [key]: next }));
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      if (!values.title.trim()) throw new Error('TITLE_REQUIRED');
      if (!validPrice(values.askingPrice)) throw new Error('INVALID_PRICE');
      const db = browserSupabase();
      if (listingId) {
        await updateListing(db, listingId, values);
        setMessage('Changes saved.');
      } else {
        const id = await createDraft(db, shopId, values);
        router.replace(`/sell/shops/${shopId}/listings/${id}`);
        router.refresh();
      }
    } catch (e) { setError(readableError(e)); }
    finally { setBusy(false); }
  }
  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    if (!listingId || !event.target.files?.length) return;
    setUploading(true); setError(''); setMessage('');
    try {
      const files = Array.from(event.target.files);
      for (const file of files) await uploadListingImage(browserSupabase(), listingId, file);
      await refreshImages(listingId);
      setMessage(files.length === 1 ? 'Photo added.' : `${files.length} photos added.`);
    } catch (e) { setError(readableError(e)); }
    finally {
      await refreshImages(listingId).catch(e => setError(readableError(e)));
      setUploading(false); event.target.value = '';
    }
  }
  async function removeImage(id: string) {
    if (!listingId) return;
    setUploading(true); setError(''); setMessage('');
    try {
      const warning = await deleteListingImage(browserSupabase(), id);
      await refreshImages(listingId);
      if (warning) setError(warning); else setMessage('Photo removed.');
    } catch (e) { setError(readableError(e)); }
    finally { setUploading(false); }
  }
  async function publish() {
    if (!listingId) return;
    setBusy(true); setError(''); setMessage('');
    try {
      // Save all editable content before the atomic publication RPC.
      await updateListing(browserSupabase(), listingId, values);
      await publishListing(browserSupabase(), listingId);
      router.push(`/sell/shops/${shopId}/listings`);
      router.refresh();
    } catch (e) { setError(readableError(e)); }
    finally { setBusy(false); }
  }
  if (loading) return <p className="muted">Loading listing editor…</p>;
  if (!authorized) return <p role="alert" className="error">{error || 'Sign in to edit this listing.'}</p>;
  return <section className="narrow-wide">
    <div className="page-heading"><div><Link className="back-link" href={`/sell/shops/${shopId}/listings`}>← Back to listings</Link>
      <p className="eyebrow">{listingId ? 'Edit listing' : 'New listing'}</p><h1>{listingId ? values.title || 'Your listing' : 'Create a listing'}</h1>
      <p className="muted">{listingId ? `Status: ${status}` : 'Start with basic information, then add photos.'}</p></div></div>
    {error && <p role="alert" className="error">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    <div className="editor-layout"><form className="panel form-stack" onSubmit={save}>
      <h2>Item details</h2>
      <label>Title<input required maxLength={120} disabled={!canEdit} value={values.title} onChange={e => field('title',e.target.value)} placeholder="e.g. Solid oak coffee table" /></label>
      <label>Description<textarea maxLength={5000} rows={5} disabled={!canEdit} value={values.description} onChange={e => field('description',e.target.value)} placeholder="Condition, dimensions, details…" /></label>
      <div className="form-row"><label>Asking price<input required type="text" inputMode="decimal" disabled={!canEdit} value={values.askingPrice} onChange={e => field('askingPrice',e.target.value)} placeholder="85.00" /></label>
        <label>Currency<select disabled={!canEdit} value={values.currency} onChange={e => field('currency',e.target.value)}><option>CAD</option><option>USD</option><option>EUR</option><option>GBP</option></select></label></div>
      <div className="form-row"><label>Category<select disabled={!canEdit} value={values.categoryKey} onChange={e => field('categoryKey',e.target.value)}><option value="">Choose category</option>{CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
        <label>Condition<select disabled={!canEdit} value={values.condition} onChange={e => field('condition', e.target.value as EditableValues['condition'])}><option value="">Choose condition</option>{CONDITIONS.map(v => <option key={v} value={v}>{v.replaceAll('_',' ')}</option>)}</select></label></div>
      <p className="help">Uses the location already set for this listing, or your shop's default location.</p>
      {canEdit && <button className="button primary" type="submit" disabled={busy || uploading}>{busy ? 'Saving…' : listingId ? 'Save changes' : 'Save draft'}</button>}
    </form>
    <div className="panel form-stack"><h2>Photos</h2><p className="muted">At least one photo is required to publish. JPEG, PNG or WebP; up to 10 MB each.</p>
      {!listingId ? <p className="notice">Save this draft first to enable uploads.</p> : <>
        <div className="photo-grid">{images.map(img => <div key={img.id} className="photo-box"><img src={img.url} alt={img.alt_text || 'Listing item'} />
          {canEdit && <button className="photo-delete" type="button" disabled={uploading || busy} onClick={() => void removeImage(img.id)} aria-label="Remove photo">×</button>}</div>)}</div>
        {canEdit && <label className="upload-label">{uploading ? 'Uploading…' : '+ Add photos'}<input aria-label="Upload listing photos" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={uploading || busy} onChange={e => void handleUpload(e)} /></label>}
      </>}
      {listingId && canEdit && <button className="text-button" type="button" disabled={busy || uploading} onClick={async () => {
        setUploading(true); setError(''); setMessage('');
        try { await cleanupUnattachedImages(browserSupabase(), listingId); setMessage('Unused uploads cleaned up.'); }
        catch (e) { setError(readableError(e)); }
        finally { setUploading(false); }
      }}>Retry unused photo cleanup</button>}
      {listingId && status === 'draft' && <div className="publish-panel"><h3>Ready to publish?</h3><p className="muted">You need a title, price, category, condition, photo and shop location.</p>
        <button className="button primary" type="button" disabled={busy || uploading || !values.title.trim() || !validPrice(values.askingPrice) || !values.categoryKey || !values.condition || images.length === 0} onClick={() => void publish()}>{busy ? 'Publishing…' : 'Publish listing'}</button>
        <p className="help">Publishing makes this item visible to everyone browsing the marketplace.</p></div>}
    </div></div>
  </section>;
}
