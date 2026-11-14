/**
 * Authenticated local Supabase smoke test for Messaging Migration 003.
 * Requires @supabase/supabase-js and two disposable test user accounts.
 * It deliberately inserts test messages; never run against production.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const env = process.env;
const url = env.SUPABASE_URL;
const key = env.SUPABASE_ANON_KEY;
const listingId = env.TEST_LISTING_ID;
for (const name of ['SUPABASE_URL','SUPABASE_ANON_KEY','TEST_LISTING_ID','TEST_BUYER_EMAIL','TEST_BUYER_PASSWORD','TEST_SELLER_EMAIL','TEST_SELLER_PASSWORD']) {
  if (!env[name]) throw new Error(`Missing ${name}`);
}
const hostname = new URL(url).hostname;
if (!['localhost','127.0.0.1','::1'].includes(hostname)) {
  throw new Error('Only a local Supabase instance is allowed for this test');
}

async function loggedIn(email, password) {
  const db = createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error} = await db.auth.signInWithPassword({email,password});
  if (error) throw error;
  assert.ok(data.user?.id);
  return db;
}
const buyer = await loggedIn(env.TEST_BUYER_EMAIL,env.TEST_BUYER_PASSWORD);
const seller = await loggedIn(env.TEST_SELLER_EMAIL,env.TEST_SELLER_PASSWORD);
const buyerId = (await buyer.auth.getUser()).data.user.id;
const sellerId = (await seller.auth.getUser()).data.user.id;

async function rpc(db,fn,args) {
  const {data,error} = await db.rpc(fn,args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
async function shouldReject(body) {
  const {error} = await buyer.rpc('send_message',{
    p_conversation_id:conversationId,p_body:body,p_client_message_id:randomUUID()
  });
  assert.ok(error,`Expected invalid body of ${body.length} JS units to fail`);
  assert.match(error.message,/INVALID_MESSAGE_BODY/);
}
const conversationId = await rpc(buyer,'start_conversation',{p_listing_id:listingId});
assert.ok(conversationId);

await shouldReject(' '.repeat(4000) + 'X');
await shouldReject('\t \n');
const accepted = ' '.repeat(3999) + 'X';
const id = randomUUID();
const firstMessageId = await rpc(buyer,'send_message',{
  p_conversation_id:conversationId,p_body:accepted,p_client_message_id:id
});
const retryId = await rpc(buyer,'send_message',{
  p_conversation_id:conversationId,p_body:accepted,p_client_message_id:id
});
assert.equal(firstMessageId,retryId,'Idempotent retry returned different message IDs');
const {error:duplicateChanged} = await buyer.rpc('send_message',{
  p_conversation_id:conversationId,p_body:'Changed content',p_client_message_id:id
});
assert.ok(duplicateChanged,'Message ID reuse with changed content was accepted');

async function readState(db,userId) {
  const {data,error} = await db.from('conversation_user_states')
    .select('last_read_at')
    .eq('conversation_id',conversationId).eq('user_id',userId).single();
  if(error) throw error;
  return data.last_read_at;
}
const initialBuyerRead = await readState(buyer,buyerId);
const initialSellerRead = await readState(seller,sellerId);

const tasks = [];
for(let i=0;i<24;i++) {
  const db = i%2===0?buyer:seller;
  tasks.push(rpc(db,'send_message',{
    p_conversation_id:conversationId,
    p_body:`concurrency test ${randomUUID()} #${i}`,
    p_client_message_id:randomUUID()
  }));
  if(i%3===0) {
    tasks.push(rpc(db,'mark_conversation_read',{p_conversation_id:conversationId}));
  }
}
await Promise.all(tasks);

const {data:msgs,error:msgsError} = await buyer.from('messages')
  .select('id,created_at').eq('conversation_id',conversationId)
  .order('created_at',{ascending:false}).limit(100);
if(msgsError) throw msgsError;
assert.ok(msgs.length>=25,'Not all test messages are visible');
const {data:conv,error:convError} = await buyer.from('conversations')
  .select('last_message_at').eq('id',conversationId).single();
if(convError) throw convError;
const maximum = msgs.map(m=>m.created_at).sort().at(-1);
assert.equal(conv.last_message_at,maximum,'Conversation last_message_at regressed');
const buyerRead = await readState(buyer,buyerId);
const sellerRead = await readState(seller,sellerId);
assert.ok(buyerRead>=initialBuyerRead,'Buyer read timestamp regressed');
assert.ok(sellerRead>=initialSellerRead,'Seller read timestamp regressed');
console.log('PASS: body validation, idempotence, timestamp monotonicity, concurrent RPC smoke test');
