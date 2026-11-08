import Link from 'next/link';
import type { PublicCard } from '@/lib/public-queries';
import { imageRoute } from '@/lib/public-queries';

export function PublicListingCard({ listing }: { listing: PublicCard }) {
  const image = [...listing.listing_images].sort((a,b) => a.sort_order-b.sort_order)[0];
  return <Link className="listing-card" href={`/listing/${listing.id}`}>
    <div className="listing-cover">{image ? <img loading="lazy" src={imageRoute(listing.id,image.id)} alt={listing.title} /> : <span>No image</span>}</div>
    <div className="listing-card-details"><strong>{listing.title}</strong>
      <span>{Number(listing.asking_price).toLocaleString(undefined,{style:'currency',currency:listing.currency})}</span>
      <small>Listed {new Date(listing.published_at).toLocaleDateString()}</small></div>
  </Link>;
}
