/**
 * Local-only Realtime test for Migration 003.
 * Requires @supabase/supabase-js; seller + buyer + outsider credentials.
 * The buyer must already have a valid Conversation about a seller's ACTIVE item.
 * It sends one test message, then tests participant INSERT event delivery,
 * outsider isolation and durable message retrieval after disconnection.
 * For a trustworthy regression, also perform the browser-to-browser QA.
 */
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const E = process.env;
const required = ['SUPABASE_URL','SUPABASE_ANON_KEY','TEST_SELLER_EMAIL',
  'TEST_SELLER_PASSWORD','TEST_BUYER_EMAIL','TEST_BUYER_PASSWORD',
  'TEST_STRANGER_EMAIL','TEST_STRANGER_PASSWORD','TEST_CONVERSATION_ID'];
for (const name of required) assert.ok(E[name], `Missing ${name}`);
const host = new URL(E.SUPABASE_URL).hostname;
assert.ok(['127.0.0.1','localhost','::1'].includes(host), 'Local Supabase only');

function client() {
  return createClient(E.SUPABASE_URL,E.SUPABASE_ANON_KEY,{
    auth: {persistSession:false,autoRefreshToken:false}
  });
}
async function signIn(email,password) {
  const db=client();
  const {data,error}=await db.auth.signInWithPassword({email,password});
  if (error) throw error;
  if (!data.session?.access_token) throw new Error('No access token');
  db.realtime.setAuth(data.session.access_token);
  return db;
}
const [buyer,seller,stranger] = await Promise.all([
  signIn(E.TEST_BUYER_EMAIL,E.TEST_BUYER_PASSWORD),
  signIn(E.TEST_SELLER_EMAIL,E.TEST_SELLER_PASSWORD),
  signIn(E.TEST_STRANGER_EMAIL,E.TEST_STRANGER_PASSWORD),
]);
const conversationId=E.TEST_CONVERSATION_ID;
const buyerEvents=[]; const sellerEvents=[]; const outsiderEvents=[];
const channels=[];

function subscribe(db,label,target) {
  const channel=db.channel(`migration-003-${label}-${randomUUID()}`)
    .on('postgres_changes',{
      event:'INSERT',schema:'public',table:'messages',
      filter:`conversation_id=eq.${conversationId}`
    },(event)=>target.push(event.new));
  channels.push([db,channel]);
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`${label}: subscription timed out`)),12000);
    channel.subscribe(status=>{
      if(status==='SUBSCRIBED'){clearTimeout(timeout);resolve();}
      if(status==='CHANNEL_ERROR' || status==='TIMED_OUT'){
        clearTimeout(timeout);reject(new Error(`${label}: ${status}`));
      }
    });
  });
}
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(predicate,desc,waitMs=7500){
  const end=Date.now()+waitMs;
  while(Date.now()<end){if(predicate())return;await sleep(150);}
  throw new Error(`Timed out waiting for ${desc}`);
}
try {
  await Promise.all([
    subscribe(buyer,'buyer',buyerEvents),
    subscribe(seller,'seller',sellerEvents),
    subscribe(stranger,'stranger',outsiderEvents),
  ]);

  const key=randomUUID();
  const body=`realtime-e2e-${key}`;
  const {data:id,error}=await buyer.rpc('send_message',{
    p_conversation_id:conversationId,p_body:body,p_client_message_id:key
  });
  if(error)throw error;
  await eventually(()=>buyerEvents.some(x=>x.id===id),'buyer event');
  await eventually(()=>sellerEvents.some(x=>x.id===id),'seller event');
  await sleep(1200);
  assert.equal(outsiderEvents.filter(x=>x.id===id).length,0,
    'Unrelated user received private conversation event');

  // Unsubscribe seller, insert while offline, then load persisted history.
  const sellerChannel=channels.find(([,channel])=>channel.topic.includes('seller'));
  await seller.removeChannel(sellerChannel[1]);
  const missedKey=randomUUID();
  const {data:missedId,error:missedError}=await buyer.rpc('send_message',{
    p_conversation_id:conversationId,p_body:`offline-${missedKey}`,p_client_message_id:missedKey
  });
  if(missedError)throw missedError;
  const {data:history,error:historyError}=await seller.from('messages')
    .select('id,body').eq('id',missedId).eq('conversation_id',conversationId);
  if(historyError)throw historyError;
  assert.equal(history.length,1,'Missed message unavailable for history backfill');

  console.log('PASS: two participants received, outsider did not, and offline message remained queryable');
} finally {
  await Promise.all(channels.map(async ([db,channel])=>{
    try{await db.removeChannel(channel)}catch{}
  }));
}
