import { publicListings } from '@/lib/public-queries';
import { PublicListingCard } from '@/components/listings/public-listing-card';

export const dynamic = 'force-dynamic';
export default async function BrowsePage() {
  const listings = await publicListings();
  return <section><div className="page-heading"><div><p className="eyebrow">Discover local finds</p>
    <h1>Explore the bazaar</h1><p className="muted">Recent listings from individual sellers.</p></div></div>
    {listings.length ? <div className="product-grid">{listings.map(l => <PublicListingCard key={l.id} listing={l} />)}</div>
      : <div className="panel empty"><h2>No listings yet</h2><p className="muted">When sellers publish items, they'll appear here.</p></div>}
  </section>;
}
