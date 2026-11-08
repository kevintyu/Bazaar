import { ListingEditor } from '@/components/seller/listing-editor';
export default async function EditListingPage({ params }: { params: Promise<{ shopId: string; listingId: string }> }) {
  const { shopId, listingId } = await params;
  return <ListingEditor shopId={shopId} listingId={listingId} />;
}
