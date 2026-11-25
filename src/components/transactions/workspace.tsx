'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { browserSupabase } from '@/lib/supabase/browser';
import { operationError } from '@/features/transactions/commands';
import type { SupabaseClient } from '@supabase/supabase-js';
export function useWorkspace<T>(load: (db: SupabaseClient, user: string) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [user, setUser] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const identity = useRef('');
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const db = browserSupabase();
      const auth = await db.auth.getUser();
      if (request !== generation.current) return;
      if (!auth.data.user) { identity.current = ''; setUser(''); setData(null); setError(''); return; }
      const id = auth.data.user.id;
      if (identity.current !== id) { setData(null); identity.current = id; }
      setUser(id);
      const next = await load(db, id);
      if (request !== generation.current) return;
      setData(next); setError(''); return next;
    } catch (e) { if (request === generation.current) setError(operationError(e)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [load]);
  useEffect(() => {
    let active = true;
    setLoading(true); setData(null); void refresh();
    const onFocus = () => { void refresh(); };
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    window.addEventListener('focus', onFocus);
    const { data: subscription } = browserSupabase().auth.onAuthStateChange(() => {
      // Do not call Auth methods from within its callback lock.
      setTimeout(() => { if (active) void refresh(); }, 0);
    });
    return () => { active = false; ++generation.current; clearInterval(timer); window.removeEventListener('focus', onFocus); subscription.subscription.unsubscribe(); };
  }, [refresh]);
  return { data, user, loading, error, refresh };
}
export function Workspace({ title, loading, user, error, refresh, children }: {
  title: string; loading: boolean; user: string; error: string; refresh: () => unknown; children: ReactNode;
}) {
  return <section><div className="page-heading"><div><p className="eyebrow">Your marketplace</p><h1>{title}</h1></div>
    <button className="button" onClick={() => refresh()} disabled={loading}>Refresh</button></div>
    <nav className="actions workspace-nav" aria-label="Your marketplace"><Link href="/purchases">My Purchases</Link><Link href="/sales">My Sales</Link><Link href="/messages">Messages</Link></nav>
    {error && <p role="alert" className="error">{error}</p>}
    {loading ? <p role="status">Loading…</p> : !user ? <div className="panel"><p>Sign in to view your private marketplace activity.</p><Link className="button primary" href="/auth">Sign in</Link></div> : children}
  </section>;
}
export function ConfirmDialog({ title, busy, onClose, onConfirm, children }: {
  title: string; busy: boolean; onClose: () => void; onConfirm: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="panel transaction-dialog" aria-labelledby="confirmation-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="confirmation-title">{title}</h2>{children}<div className="actions">
    <button autoFocus className="button" disabled={busy} onClick={onClose}>Go back</button>
    <button className="button primary" disabled={busy} onClick={onConfirm}>{busy ? 'Submitting…' : 'Confirm'}</button></div>
  </dialog>;
}
