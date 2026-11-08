'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { browserSupabase } from '@/lib/supabase/browser';
import { readableError } from '@/features/listings/errors';

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'signin'|'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMessage('');
    try {
      const db = browserSupabase();
      if (mode === 'signup') {
        const { data, error } = await db.auth.signUp({ email, password,
          options: { data: { display_name: displayName.trim() || email.split('@')[0] } },
        });
        if (error) throw error;
        if (data.session) { router.push('/sell'); router.refresh(); }
        else setMessage('Account created. Check your email for a confirmation link if required.');
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push('/sell'); router.refresh();
      }
    } catch (err) { setMessage(readableError(err)); }
    finally { setBusy(false); }
  }
  return <div className="panel">
    <div className="segmented">
      <button type="button" className={mode === 'signin' ? 'selected' : ''} onClick={() => setMode('signin')}>Sign in</button>
      <button type="button" className={mode === 'signup' ? 'selected' : ''} onClick={() => setMode('signup')}>Create account</button>
    </div>
    <form onSubmit={submit} className="form-stack">
      {mode === 'signup' && <label>Display name<input required maxLength={80} value={displayName} onChange={e => setDisplayName(e.target.value)} /></label>}
      <label>Email<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" minLength={6} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="button primary" disabled={busy}>{busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
      {message && <p role="status" className="notice">{message}</p>}
    </form>
  </div>;
}
