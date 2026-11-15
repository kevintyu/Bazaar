/**
 * Candidate Migration 004 authenticated integration test.
 * DESTRUCTIVE to disposable local fixtures. Never run against production.
 * Requires @supabase/supabase-js, 1 seller + 3 buyer accounts and
 * three distinct ACTIVE+CLEAR seller-owned test Listings.
 * Does not cover successful timeout finalization (needs local DB fixture
 * clock/deadline adjustment) or production dispute resolution.
 */
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const E=process.env;
const names=['SUPABASE_URL','SUPABASE_ANON_KEY','TEST_SELLER_EMAIL','TEST_SELLER_PASSWORD',
  'TEST_BUYER_A_EMAIL','TEST_BUYER_A_PASSWORD','TEST_BUYER_B_EMAIL',
  'TEST_BUYER_B_PASSWORD','TEST_BUYER_C_EMAIL','TEST_BUYER_C_PASSWORD',
  'TEST_LISTING_CANCEL','TEST_LISTING_CONFIRM','TEST_LISTING_DISPUTE'];
for (const n of names) assert.ok(E[n],`Missing ${n}`);
assert.ok(['localhost','127.0.0.1','::1'].includes(new URL(E.SUPABASE_URL).hostname),'Local only');
assert.equal(new Set([E.TEST_LISTING_CANCEL,E.TEST_LISTING_CONFIRM,E.TEST_LISTING_DISPUTE]).size,3,
  'Every scenario needs a different ACTIVE Listing');

function client(){return createClient(E.SUPABASE_URL,E.SUPABASE_ANON_KEY,{
  auth:{persistSession:false,autoRefreshToken:false}
});}
async function login(email,password){
  const db=client();const {data,error}=await db.auth.signInWithPassword({email,password});
  if(error)throw error;assert.ok(data.user?.id);return {db,id:data.user.id};
}
const seller=await login(E.TEST_SELLER_EMAIL,E.TEST_SELLER_PASSWORD);
const buyerA=await login(E.TEST_BUYER_A_EMAIL,E.TEST_BUYER_A_PASSWORD);
const buyerB=await login(E.TEST_BUYER_B_EMAIL,E.TEST_BUYER_B_PASSWORD);
const buyerC=await login(E.TEST_BUYER_C_EMAIL,E.TEST_BUYER_C_PASSWORD);

async function rpc(user,func,args){
  const {data,error}=await user.db.rpc(func,args);
  if(error)throw new Error(`${func}: ${error.message}`);
  return data;
}
async function denied(user,func,args,pattern=/.*/){
  const {error}=await user.db.rpc(func,args);
  assert.ok(error,`Expected ${func} rejection`);
  assert.match(error.message,pattern);
}
async function readTx(user,txId){
  const {data,error}=await user.db.from('transactions')
    .select('id,status,listing_id,buyer_user_id,seller_user_id,buyer_confirmation_deadline')
    .eq('id',txId).single();
  if(error)throw error;return data;
}
async function readListing(user,id){
  const {data,error}=await user.db.from('listings')
    .select('id,status').eq('id',id).single();
  if(error)throw error;return data;
}
async function start(user,listing){return rpc(user,'start_conversation',{p_listing_id:listing});}

// Case 1: seller reserves from a listing-specific Conversation, concurrent
// reservations serialize, cancellation returns the item to ACTIVE.
const cancelId=E.TEST_LISTING_CANCEL;
const cA=await start(buyerA,cancelId);
const cB=await start(buyerB,cancelId);
const reserved=await rpc(seller,'reserve_listing',{p_conversation_id:cA});
assert.equal((await readTx(buyerA,reserved)).buyer_user_id,buyerA.id);
assert.equal((await readListing(seller,cancelId)).status,'reserved');
await denied(buyerA,'reserve_listing',{p_conversation_id:cB},/CONVERSATION_NOT_OWNED_BY_SELLER/);
await denied(seller,'reserve_listing',{p_conversation_id:cB},/LISTING_NOT_ELIGIBLE_FOR_RESERVATION/);
await denied(buyerC,'start_conversation',{p_listing_id:cancelId},/LISTING_NOT_AVAILABLE_FOR_CHAT/);
// Conversation B already existed when reservation began: sending continues.
await rpc(buyerB,'send_message',{
  p_conversation_id:cB,p_body:`Still interested ${randomUUID()}`,
  p_client_message_id:randomUUID()
});
await rpc(buyerA,'cancel_transaction',{p_transaction_id:reserved,p_reason:'Changed plans'});
assert.equal((await readTx(buyerA,reserved)).status,'cancelled');
assert.equal((await readListing(seller,cancelId)).status,'active');
const cC=await start(buyerC,cancelId);assert.ok(cC);
const newReservation=await rpc(seller,'reserve_listing',{p_conversation_id:cB});
assert.notEqual(newReservation,reserved,'Cancelled reservation must be historical');
await rpc(seller,'cancel_transaction',{p_transaction_id:newReservation,p_reason:'Reset test listing'});

// Case 2: seller marks picked up; buyer confirms; only one SOLD transaction.
const confirmId=E.TEST_LISTING_CONFIRM;
const cConfirm=await start(buyerA,confirmId);
const txConfirm=await rpc(seller,'reserve_listing',{p_conversation_id:cConfirm});
await denied(buyerA,'mark_picked_up',{p_transaction_id:txConfirm},/SELLER_ONLY/);
await denied(seller,'confirm_pickup',{p_transaction_id:txConfirm},/BUYER_ONLY/);
await denied(seller,'finalize_unconfirmed_pickup',{p_transaction_id:txConfirm},
  /CONFIRMATION_DEADLINE_NOT_REACHED_OR_INVALID_STATE/);
const deadline=await rpc(seller,'mark_picked_up',{p_transaction_id:txConfirm});
assert.ok(Date.parse(deadline)>Date.now());
await denied(seller,'cancel_transaction',{p_transaction_id:txConfirm,p_reason:'too late'},
  /CANNOT_CANCEL_AFTER_PICKUP/);
await rpc(buyerA,'confirm_pickup',{p_transaction_id:txConfirm});
assert.equal((await readTx(buyerA,txConfirm)).status,'completed');
assert.equal((await readListing(seller,confirmId)).status,'sold');
await denied(buyerA,'confirm_pickup',{p_transaction_id:txConfirm},/INVALID_TRANSACTION_STATE/);
const {data:closed,error:closedError}=await buyerA.db.from('conversations')
  .select('status').eq('id',cConfirm).single();
if(closedError)throw closedError;
assert.equal(closed.status,'concluded','SOLD Listing must close chat via 003 trigger');

// Case 3: dispute freezes the listing and disables seller timeout finalize.
const disputeId=E.TEST_LISTING_DISPUTE;
const cDispute=await start(buyerB,disputeId);
const txDispute=await rpc(seller,'reserve_listing',{p_conversation_id:cDispute});
await rpc(seller,'mark_picked_up',{p_transaction_id:txDispute});
await rpc(buyerB,'dispute_pickup',{
  p_transaction_id:txDispute,p_reason:'Item has not been received.'
});
assert.equal((await readTx(buyerB,txDispute)).status,'disputed');
assert.equal((await readListing(seller,disputeId)).status,'reserved');
await denied(seller,'finalize_unconfirmed_pickup',{p_transaction_id:txDispute},
  /CONFIRMATION_DEADLINE_NOT_REACHED_OR_INVALID_STATE/);
const {data:outside,error:outsideError}=await buyerC.db.from('transactions')
  .select('id').eq('id',txDispute);
assert.ifError(outsideError);assert.equal(outside.length,0,'Outsider accessed a Transaction');
const {error:directUpdateError}=await seller.db.from('transactions')
  .update({status:'completed'}).eq('id',txDispute);
assert.ok(directUpdateError,'Client directly updated Transaction state');

console.log('PASS: reserve/cancel/re-reserve, reserved messaging, buyer-confirmed completion, dispute freeze, roles and RLS');
console.log('UNTESTED: seller finalization after deadline, operator policy change, deterministic simultaneous reserve race');
