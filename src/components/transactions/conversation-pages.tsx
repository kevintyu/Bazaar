'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { browserSupabase } from '@/lib/supabase/browser';
import { conversation, conversations, listingSummary, messages } from '@/features/transactions/queries';
import { command, operationError, reservationKey, clearReservationKey } from '@/features/transactions/commands';
import { dateLabel, statusLabel, type TransactionStatus } from '@/features/transactions/types';
import { Workspace, useWorkspace, ConfirmDialog } from './workspace';
export function ConversationList() {
  const [offset, setOffset] = useState(0);
  const [includeHidden, setIncludeHidden] = useState(false);
  const load = useCallback(async (db: SupabaseClient, user: string) => {
    const rows = await conversations(db, offset, includeHidden);
    return Promise.all(rows.map(async row => ({ ...row, listing: await listingSummary(db,row.listing_id,row.seller_user_id===user) })));
  }, [offset, includeHidden]);
  const state = useWorkspace(load);
  return <Workspace title="Messages" {...state}>
    <p className="muted">Listing conversations and retained history. Refresh for new messages.</p>
    <label className="inbox-toggle"><input type="checkbox" checked={includeHidden} onChange={e => { setIncludeHidden(e.target.checked); setOffset(0); }} />Include hidden and archived history</label>
    {state.data?.length === 0 && <div className="panel empty"><h2>No conversations yet</h2><p>Open an available listing to message its seller.</p><Link href="/browse">Explore listings</Link></div>}
    <div className="transaction-list">{state.data?.map(c => <article key={c.id} className="panel"><h2>{c.listing.title}</h2><p>{c.seller_user_id===state.user ? 'Buyer' : 'Seller'} reference: {c.seller_user_id===state.user ? c.buyer_user_id : c.seller_user_id}</p><p className="muted">{c.status==='concluded' ? 'Read-only history' : 'Conversation open'} · {dateLabel(c.created_at)}</p><Link className="button" href={`/messages/${c.id}`}>Open conversation</Link></article>)}</div>
    <div className="actions pagination"><button className="button" disabled={!offset || state.loading} onClick={() => setOffset(n => Math.max(0,n-20))}>Previous</button><span>Page {offset/20+1}</span><button className="button" disabled={state.data?.length!==20 || state.loading} onClick={() => setOffset(n=>n+20)}>Next</button></div>
  </Workspace>;
}
export function ConversationDetail({ id }: { id: string }) {
  const [limit, setLimit] = useState(100);
  const load = useCallback(async (db: SupabaseClient, user: string) => {
    const c = await conversation(db,id);
    if (!c) return null;
    const [listing, history, tx] = await Promise.all([
      listingSummary(db,c.listing_id,c.seller_user_id===user), messages(db,id,limit),
      db.from('transactions').select('id,status,reserved_at').eq('conversation_id',id).order('reserved_at',{ascending:false}),
    ]);
    if (tx.error) throw tx.error;
    return { c, listing, history, transactions: (tx.data || []) as {id:string;status:TransactionStatus}[] };
  }, [id,limit]);
  const state = useWorkspace(load);
  const view = state.data;
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const messageKey = useRef<{body:string;id:string} | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [receipt, setReceipt] = useState('');
  async function reserve() {
    if (lock.current || !view) return;
    lock.current=true; setBusy(true); setError(''); setNotice('');
    try {
      const request = reservationKey(state.user,id);
      const result = await command(browserSupabase(),'reserve_listing',{p_conversation_id:id,p_request_id:request});
      setReceipt(result);
      clearReservationKey(state.user,id);
      await state.refresh();
      setNotice('Reservation request processed. Open the transaction to review its current status.');
    } catch(e) { setError(operationError(e)); await state.refresh(); }
    finally { lock.current=false; setBusy(false); setConfirm(false); }
  }
  async function send() {
    if (lock.current || !body.trim()) return;
    lock.current=true; setBusy(true); setError(''); setNotice('');
    if (messageKey.current?.body!==body) messageKey.current={body,id:crypto.randomUUID()};
    try {
      await command(browserSupabase(),'send_message',{p_conversation_id:id,p_body:body,p_client_message_id:messageKey.current.id});
      setBody(''); messageKey.current=null; await state.refresh();
      setNotice('Message sent.');
    } catch(e) { setError(operationError(e)); await state.refresh(); }
    finally { lock.current=false; setBusy(false); }
  }
  return <Workspace title="Conversation" {...state}>
    {!view ? !state.error && <p className="panel">Conversation unavailable. It may not belong to this account.</p> : <div className="panel">
      <h2>{view.listing.title}</h2><p className="muted">Listing reference: {view.c.listing_id}</p>
      <p>{view.c.seller_user_id===state.user ? 'Buyer' : 'Seller'} reference: {view.c.seller_user_id===state.user ? view.c.buyer_user_id : view.c.seller_user_id}</p>
      <div className="actions">{view.transactions.map(t => <Link className="button" href={`/transactions/${t.id}`} key={t.id}>{statusLabel[t.status]} transaction</Link>)}</div>
      {view.c.seller_user_id===state.user && view.c.status==='active' && view.listing.status==='active' && <button className="button primary" disabled={busy || !!state.error} onClick={() => setConfirm(true)}>Reserve for this buyer</button>}
      {receipt && <p><Link href={`/transactions/${receipt}`}>View reservation result</Link></p>}
      {notice && <p className="notice" role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}
      <ol className="message-history" aria-label="Conversation messages">{view.history.map(m => <li key={m.id} className={m.sender_user_id===state.user ? 'mine' : ''}><strong>{m.sender_user_id===state.user ? 'You' : 'Other participant'}</strong><p className="preserve-lines">{m.body}</p><time dateTime={m.created_at}>{dateLabel(m.created_at)}</time></li>)}</ol>
      {!view.history.length && <p className="muted">No messages yet. Arrange pickup here.</p>}
      {view.history.length===limit && <button className="button" onClick={() => setLimit(n=>n+100)}>Load earlier messages</button>}
      {view.c.status==='concluded' ? <p className="notice">This conversation is read-only. Its history is preserved.</p> : <form className="form-stack" onSubmit={e=>{e.preventDefault();void send();}}><label>Message<textarea required maxLength={4000} value={body} disabled={busy} onChange={e=>setBody(e.target.value)} /></label><button className="button primary" disabled={busy || !body.trim() || !!state.error}>{busy ? 'Submitting…' : 'Send message'}</button><p className="help">Existing conversations remain open while a listing is reserved. Account and listing restrictions still apply.</p></form>}
      {confirm && <ConfirmDialog title="Reserve for this buyer" busy={busy} onClose={()=>setConfirm(false)} onConfirm={()=>void reserve()}><p>Reserve this listing for the buyer in this conversation. Only one active reservation is allowed. This starts a transaction; it does not complete the sale.</p></ConfirmDialog>}
    </div>}
  </Workspace>;
}
export function ContactSeller({ listingId }: { listingId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  async function start() {
    if(lock.current) return;
    lock.current=true; setBusy(true); setError('');
    try {
      const db=browserSupabase(); const {data}=await db.auth.getUser();
      if(!data.user) { router.push('/auth'); return; }
      // Read existing membership first: RESERVED must not call start_conversation.
      const existing=await db.from('conversations').select('id').eq('listing_id',listingId).eq('buyer_user_id',data.user.id).maybeSingle();
      if(existing.error) throw existing.error;
      const id=existing.data?.id || await command(db,'start_conversation',{p_listing_id:listingId});
      router.push(`/messages/${id}`);
    } catch(e) {setError(operationError(e));}
    finally {lock.current=false;setBusy(false);}
  }
  return <div><button className="button primary" disabled={busy} onClick={()=>void start()}>{busy?'Opening…':'Message seller'}</button>{error && <p className="error" role="alert">{error}</p>}</div>;
}
