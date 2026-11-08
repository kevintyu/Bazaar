import { notFound } from 'next/navigation';
import Link from 'next/link';
import { publicShop, publicListings } from '@/lib/public-queries';
import { PublicListingCard } from '@/components/listings/public-listing-card';

export const dynamic = 'force-dynamic';
export default async function ShopPage({ params }: { params: Promise<{ shopId: string }> }) {
  const { shopId } = await params;
  const [shop, listings] = await Promise.all([publicShop(shopId), publicListings(shopId)]);
  // Migration 001 does not yet restrict public shops based on owner account status.
  // Require at least one publicly eligible listing until a safe public-shop API exists.
  if (!shop || listings.length === 0) notFound();
  return <section><Link className="back-link" href="/browse">← Explore</Link>
    <div className="hero-panel shop-hero"><div className="shop-avatar big">{shop.display_name.slice(0,1).toUpperCase()}</div>
      <div><p className="eyebrow">Independent seller</p><h1>{shop.display_name}</h1><p>{shop.description || 'Welcome to this seller’s shop.'}</p></div></div>
    <div className="page-heading"><div><h2>Items for sale</h2><p className="muted">{listings.length} active listing{listings.length===1?'':'s'}</p></div></div>
    <div className="product-grid">{listings.map(l => <PublicListingCard key={l.id} listing={l} />)}</div>
  </section>;
}
