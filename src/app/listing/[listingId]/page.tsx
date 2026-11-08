import Link from 'next/link';
import { notFound } from 'next/navigation';
import { publicListing, publicShop, imageRoute } from '@/lib/public-queries';

export const dynamic = 'force-dynamic';
export default async function ListingPage({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  const listing = await publicListing(listingId);
  if (!listing) notFound();
  const shop = await publicShop(listing.shop_id);
  if (!shop) notFound();
  const images = [...(listing.listing_images ?? [])].sort((a,b) => a.sort_order - b.sort_order);
  return <section><Link className="back-link" href="/browse">← Explore</Link>
    <div className="listing-detail-grid"><div><div className="detail-hero">{images[0] ? <img src={imageRoute(listing.id,images[0].id)} alt={listing.title} /> : 'No image'}</div>
      {images.length > 1 && <div className="photo-grid">{images.slice(1).map(image => <img className="detail-thumb" key={image.id} src={imageRoute(listing.id,image.id)} alt={listing.title} />)}</div>}</div>
      <div className="panel detail-content"><p className="eyebrow">{listing.category_key || 'Item for sale'}</p><h1>{listing.title}</h1>
        <div className="price">{Number(listing.asking_price).toLocaleString(undefined,{style:'currency',currency:listing.currency})}</div>
        <p className="muted">Condition: {(listing.condition || 'not specified').replaceAll('_',' ')}</p>
        <h2>Description</h2><p className="preserve-lines">{listing.description || 'No description provided.'}</p>
        <div className="seller-mini"><div className="shop-avatar">{shop.display_name.slice(0,1).toUpperCase()}</div><div><strong>{shop.display_name}</strong><div><Link href={`/shop/${shop.id}`}>Visit shop →</Link></div></div></div>
        <p className="help">Messaging and pickup arrangements are planned for the next vertical slice.</p>
      </div></div>
  </section>;
}
