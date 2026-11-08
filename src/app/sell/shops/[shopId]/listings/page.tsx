import { ListingsDashboard } from '@/components/seller/listings-dashboard';
export default async function SellerListingsPage({ params }: { params: Promise<{ shopId: string }> }) {
  const { shopId } = await params;
  return <ListingsDashboard shopId={shopId} />;
}
