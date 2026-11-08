'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { browserSupabase } from '@/lib/supabase/browser';
import { readableError } from '@/features/listings/errors';

interface ShopBrief { id: string; display_name: string; status: string; }
export function SellerHome() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [signedOut, setSignedOut] = useState(false);
  const [shops, setShops] = useState<ShopBrief[]>([]);
  useEffect(() => {
    let alive = true;
    async function run() {
      try {
        const db = browserSupabase();
        const { data: auth, error: authError } = await db.auth.getUser();
        if (authError || !auth.user) { if (alive) setSignedOut(true); return; }
        const { data, error: shopsError } = await db.from('shops')
          .select('id,display_name,status').eq('owner_user_id', auth.user.id);
        if (shopsError) throw shopsError;
        if (alive) setShops((data ?? []) as ShopBrief[]);
      } catch (e) { if (alive) setError(readableError(e)); }
      finally { if (alive) setLoading(false); }
    }
    void run(); return () => { alive = false; };
  }, []);
  if (loading) return <p className="muted">Loading your shop…</p>;
  if (signedOut) return <div className="panel"><h1>Manage your marketplace shop</h1><p>Sign in to get started.</p><Link className="button primary" href="/auth">Sign in</Link></div>;
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!shops.length) return <div className="hero-panel"><p className="eyebrow">Seller workspace</p><h1>Open your first shop</h1><p>Create your seller profile to start posting listings.</p><Link className="button primary" href="/sell/start">Start selling</Link></div>;
  return <section>
    <div className="page-heading"><div><p className="eyebrow">Seller workspace</p><h1>Your shops</h1><p className="muted">Manage your inventory and published listings.</p></div></div>
    <div className="card-grid">{shops.map(shop => <article key={shop.id} className="panel">
      <div className="shop-avatar">{shop.display_name.slice(0, 1).toUpperCase()}</div>
      <h2>{shop.display_name}</h2><p className="muted">{shop.status === 'active' ? 'Active shop' : `Shop ${shop.status}`}</p>
      <Link className="button primary" href={`/sell/shops/${shop.id}/listings`}>Manage listings</Link>
    </article>)}</div>
  </section>;
}
