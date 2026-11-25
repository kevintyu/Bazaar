import type { SupabaseClient } from '@supabase/supabase-js';
export async function command(db: SupabaseClient, name: 'reserve_listing' | 'cancel_transaction' | 'claim_pickup' | 'confirm_pickup_claim' | 'start_conversation' | 'send_message', args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data as string;
}
// Persist before sending; an uncertain transport result must reuse the same key,
// including after navigation or reload. Keys contain no message/evidence contents.
export function reservationKey(user: string, conversation: string) {
  const key = `bazaar:reserve:${user}:${conversation}`;
  let value = localStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
  return value;
}
export function clearReservationKey(user: string, conversation: string) {
  localStorage.removeItem(`bazaar:reserve:${user}:${conversation}`);
}
export function operationError(error: unknown): string {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (/TRANSACTION_RESTRICTED|NOT_AVAILABLE|NOT_ACTIVE/.test(code)) return 'This action is restricted by the current account, shop or listing status. Try again after the restriction clears.';
  if (/NOT_FOUND|NOT_OWNED|permission denied|UNAUTHENTICATED/.test(code)) return 'This record is unavailable or you do not have permission. Sign in with the participating account.';
  if (/INVALID_.*STATE|BUYER_CLAIM_REQUIRED|CONCLUDED|REQUEST_CONFLICT/.test(code)) return 'The current state no longer allows this action. Review the refreshed details before trying again.';
  if (/MESSAGE|REASON/.test(code)) return 'Check your text and try again. Messages allow 4,000 characters; cancellation reasons allow 1,000.';
  return 'Could not confirm the result. Refresh to check the latest state, or retry the same action.';
}
