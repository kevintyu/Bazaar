export type TransactionStatus = 'reserved' | 'awaiting_buyer_confirmation' | 'completed' | 'cancelled' | 'disputed';
export type Transaction = {
  id: string; listing_id: string; shop_id: string; conversation_id: string;
  buyer_user_id: string; seller_user_id: string; status: TransactionStatus;
  reserved_at: string; pickup_claimed_at: string | null; seller_confirmed_at: string | null;
  completed_at: string | null; cancelled_at: string | null; cancellation_reason: string | null;
  administrator_resolution_id: string | null;
};
export type ListingSummary = { title: string; price: number | null; currency: string | null; image: string | null; status?: string; shop?: string };
export type TransactionView = Transaction & { listing: ListingSummary; shopName: string };
export type Conversation = { id: string; listing_id: string; buyer_user_id: string; seller_user_id: string; status: 'active' | 'concluded'; created_at: string };
export type Message = { id: string; sender_user_id: string; body: string; created_at: string };
export const statusLabel: Record<TransactionStatus, string> = {
  reserved: 'Reserved', awaiting_buyer_confirmation: 'Awaiting seller confirmation',
  completed: 'Completed', cancelled: 'Cancelled', disputed: 'Disputed',
};
export function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}
