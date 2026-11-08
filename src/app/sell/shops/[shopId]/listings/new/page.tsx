import { ListingEditor } from '@/components/seller/listing-editor';
export default async function NewListingPage({ params }: { params: Promise<{ shopId: string }> }) {
  const { shopId } = await params;
  return <ListingEditor shopId={shopId} />;
}
