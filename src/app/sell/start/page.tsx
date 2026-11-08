import { StartSellingForm } from '@/components/seller/start-selling-form';
export default function StartSellingPage() {
  return <section className="narrow"><p className="eyebrow">Seller onboarding</p><h1>Create your shop</h1>
    <p className="muted">Your shop is your public selling identity. Your address stays private by default.</p>
    <StartSellingForm /></section>;
}
