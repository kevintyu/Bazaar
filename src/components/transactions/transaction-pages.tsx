'use client';
import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { browserSupabase } from '@/lib/supabase/browser';
import { transaction, transactions } from '@/features/transactions/queries';
import { command, operationError } from '@/features/transactions/commands';
import { dateLabel, statusLabel, type TransactionView } from '@/features/transactions/types';
import { formatPrice } from '@/features/listings/format';
import { Workspace, useWorkspace, ConfirmDialog } from './workspace';
import type { SupabaseClient } from '@supabase/supabase-js';
function Item({ t }: { t: TransactionView }) {
  return <div className="transaction-item">{t.listing.image ? <img src={t.listing.image} alt="" onError={e => { e.currentTarget.hidden = true; }} /> : <div className="transaction-placeholder" aria-hidden="true">Item</div>}
    <div><h2>{t.listing.title}</h2><p>{t.shopName}</p>{t.listing.price !== null && <p>{formatPrice(Number(t.listing.price), t.listing.currency)} <span className="muted small">Current asking price, not an agreed-price receipt</span></p>}
    <p className="small muted">Listing reference: {t.listing_id}</p></div></div>;
}
function Dates({ t }: { t: TransactionView }) {
  return <dl className="transaction-dates"><div><dt>Reserved</dt><dd>{dateLabel(t.reserved_at)}</dd></div>
    {t.pickup_claimed_at && <div><dt>Pickup claimed</dt><dd>{dateLabel(t.pickup_claimed_at)}</dd></div>}
    {t.completed_at && <div><dt>Completed</dt><dd>{dateLabel(t.completed_at)}</dd></div>}
    {t.cancelled_at && <div><dt>Cancelled</dt><dd>{dateLabel(t.cancelled_at)}</dd></div>}</dl>;
}
export function TransactionList({ role }: { role: 'buyer' | 'seller' }) {
  const [offset, setOffset] = useState(0);
  const load = useCallback((db: SupabaseClient, user: string) => transactions(db, user, role, offset), [role, offset]);
  const state = useWorkspace(load);
  return <Workspace title={role === 'buyer' ? 'My Purchases' : 'My Sales'} {...state}>
    <p className="muted">Reservations and retained history. Updates refresh every 15 seconds and when you return to this window.</p>
    {state.data?.length === 0 && <div className="panel empty"><h2>No transactions on this page</h2><p>{role === 'buyer' ? 'Your purchases appear when a seller reserves an item for you.' : 'Reserve an item for a buyer from their conversation to start a sale.'}</p><Link href="/messages">Open messages</Link></div>}
    <div className="transaction-list">{state.data?.map(t => <article className="panel" key={t.id}>
      <span className={`status ${t.status}`}>{statusLabel[t.status]}</span><Item t={t} /><Dates t={t} />
      {role === 'seller' && <p className="muted">Buyer reference: {t.buyer_user_id}</p>}
      {role === 'seller' && t.status === 'awaiting_buyer_confirmation' && <p className="notice">Action needed: the buyer has claimed pickup. Please review and confirm the handover.</p>}
      <div className="actions"><Link className="button primary" href={`/transactions/${t.id}`}>View transaction</Link><Link href={`/messages/${t.conversation_id}`}>Open conversation</Link></div>
    </article>)}</div>
    <div className="actions pagination"><button className="button" disabled={!offset || state.loading} onClick={() => setOffset(n => Math.max(0,n-20))}>Previous</button><span>Page {offset/20+1}</span><button className="button" disabled={state.data?.length !== 20 || state.loading} onClick={() => setOffset(n => n+20)}>Next</button></div>
  </Workspace>;
}
export function TransactionDetail({ id }: { id: string }) {
  const load = useCallback((db: SupabaseClient, user: string) => transaction(db, id, user), [id]);
  const state = useWorkspace(load);
  const t = state.data;
  const router = useRouter();
  const [action, setAction] = useState<'claim_pickup' | 'confirm_pickup_claim' | 'cancel_transaction' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function submit() {
    if (!action || !t || lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await command(browserSupabase(), action, { p_transaction_id: id, ...(action === 'cancel_transaction' ? { p_reason: reason || null } : {}) });
      const latest = await state.refresh();
      router.refresh();
      setMessage(latest ? `Request processed. Current status: ${statusLabel[latest.status]}.` : 'Request processed, but the latest status could not be loaded. Refresh before taking another action.');
    } catch (e) { setError(operationError(e)); await state.refresh(); }
    finally { lock.current = false; setBusy(false); setAction(null); }
  }
  const title = action === 'claim_pickup' ? "I've picked up this item" : action === 'confirm_pickup_claim' ? 'Confirm item handover' : 'Cancel reservation';
  return <Workspace title="Transaction details" {...state}>
    {!t ? !state.error && <p className="panel">Transaction unavailable. It may not belong to this account.</p> : <article className="panel">
      <span className={`status ${t.status}`} data-testid="transaction-status">{statusLabel[t.status]}</span><Item t={t} />
      <ol className="transaction-progress" aria-label="Transaction progression"><li>Reserved</li><li>Awaiting seller confirmation</li><li>Completed</li></ol>
      {t.status === 'cancelled' && <p>This reservation was cancelled. Its history is retained.</p>}
      {t.status === 'disputed' && <p>This transaction is disputed. Participant completion and cancellation are unavailable pending authorized resolution.</p>}
      {t.administrator_resolution_id && <p>Resolved by an authorized administrator. Confidential review information is not displayed.</p>}
      <Dates t={t} />{t.cancellation_reason && <p className="preserve-lines">Cancellation reason: {t.cancellation_reason}</p>}
      <p className="muted">{t.seller_user_id === state.user ? `Buyer reference: ${t.buyer_user_id}` : `Seller: ${t.shopName}`}</p>
      {t.status === 'awaiting_buyer_confirmation' && <p className="notice">The buyer has claimed pickup. The seller must confirm before the sale completes. There is no automatic expiration or completion.</p>}
      {message && <p role="status" className="notice">{message}</p>}{error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        {t.status === 'reserved' && t.buyer_user_id === state.user && <button className="button primary" disabled={busy || !!state.error} onClick={() => setAction('claim_pickup')}>I've picked up this item</button>}
        {t.status === 'awaiting_buyer_confirmation' && t.seller_user_id === state.user && <button className="button primary" disabled={busy || !!state.error} onClick={() => setAction('confirm_pickup_claim')}>Confirm item handover</button>}
        {t.status === 'reserved' && <button className="button" disabled={busy || !!state.error} onClick={() => { setReason(''); setAction('cancel_transaction'); }}>Cancel reservation</button>}
        <Link href={`/messages/${t.conversation_id}`}>Open conversation</Link>
      </div>
      {action && <ConfirmDialog title={title} busy={busy} onClose={() => setAction(null)} onConfirm={() => void submit()}>
        <p>{action === 'claim_pickup' ? 'Only claim pickup after receiving the item. The seller must confirm the handover; this claim alone does not complete the sale.' : action === 'confirm_pickup_claim' ? 'Confirm only if you handed over the item. This completes the transaction and marks the listing SOLD.' : 'Cancel this reservation before pickup. If permitted, the listing will become available again. This record will remain in your history.'}</p>
        {action === 'cancel_transaction' && <label>Cancellation reason (optional)<textarea maxLength={1000} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} /></label>}
      </ConfirmDialog>}
    </article>}
  </Workspace>;
}
