'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { browserSupabase } from '@/lib/supabase/browser';
import { readableError } from '@/features/listings/errors';

export function StartSellingForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [country, setCountry] = useState('CA');
  const [region, setRegion] = useState('Ontario');
  const [city, setCity] = useState('');
  const [precision, setPrecision] = useState<'neighborhood'|'city'|'general_area'>('city');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    async function check() {
      const db = browserSupabase();
      const { data: { user } } = await db.auth.getUser();
      if (!user) { router.replace('/auth'); return; }
      const { data, error } = await db.from('profiles').select('selling_enabled').eq('id', user.id).single();
      if (error) throw error;
      if (data.selling_enabled) { router.replace('/sell'); return; }
      if (alive) setReady(true);
    }
    check().catch(e => { if (alive) setError(readableError(e)); });
    return () => { alive = false; };
  }, [router]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const { data, error: rpcError } = await browserSupabase().rpc('activate_selling', {
        p_shop_name: name.trim(), p_shop_description: description.trim() || null,
        p_country_code: country.toUpperCase().trim(),
        p_administrative_area: region.trim() || null,
        p_locality: city.trim() || null,
        p_postal_code: null, p_formatted_address: null,
        p_latitude: null, p_longitude: null,
        p_public_precision: precision,
      });
      if (rpcError) throw rpcError;
      router.push(`/sell/shops/${data}/listings`);
      router.refresh();
    } catch (e) { setError(readableError(e)); }
    finally { setBusy(false); }
  }
  if (!ready) return error ? <p role="alert" className="error">{error}</p> : <p>Checking your account…</p>;
  return <form className="panel form-stack" onSubmit={submit}>
    <label>Shop name<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Jamie's Finds" /></label>
    <label>Description<textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="What kind of things do you sell?" /></label>
    <div className="form-row"><label>Country (2-letter code)<input required minLength={2} maxLength={2} value={country} onChange={e => setCountry(e.target.value)} /></label><label>Province / state / region<input value={region} onChange={e => setRegion(e.target.value)} /></label></div>
    <label>City or locality<input required value={city} onChange={e => setCity(e.target.value)} placeholder="Your city" /></label>
    <label>Public location precision<select value={precision} onChange={e => setPrecision(e.target.value as typeof precision)}>
      <option value="city">City</option><option value="neighborhood">Neighbourhood (requires more detailed location setup later)</option><option value="general_area">General area</option>
    </select></label>
    <p className="help">No home address is requested here. Public location rendering will be added through a privacy-safe API.</p>
    <button className="button primary" disabled={busy}>{busy ? 'Creating…' : 'Create my shop'}</button>
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}
