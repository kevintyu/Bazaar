// Local-only browser transport harness, not a product chat UI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const cfg = JSON.parse(execFileSync('cmd.exe', ['/d','/s','/c','npx --yes supabase@3.0.0 status -o json'], {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
assert.equal(cfg.API_URL, 'http://127.0.0.1:54321');
const sql = s => execFileSync('docker', ['exec','-i','supabase_db_bazaar-migration-test','psql','-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1'], {input:s,encoding:'utf8'});
async function user() {
  const db = createClient(cfg.API_URL,cfg.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error} = await db.auth.signUp({email:`browser-chat-${randomUUID()}@example.test`,password:'Local-test-only-42!Strong'});
  assert.ifError(error); return {db,...data};
}
const seller = await user(), buyer = await user(), stranger = await user();
const shop = await seller.db.rpc('activate_selling',{p_shop_name:'Browser validation',p_country_code:'US'});
assert.ifError(shop.error);
const listing = randomUUID();
sql(`insert into public.listings(id,shop_id,owner_user_id,title,asking_price,currency,category_key,condition,status,published_at) values('${listing}','${shop.data}','${seller.user.id}','Browser test',1,'USD','test','good','active',now());`);
const thread = await buyer.db.rpc('start_conversation',{p_listing_id:listing});
assert.ifError(thread.error);
const sdk = readFileSync('node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const server = createServer((req,res) => {
  res.setHeader('Content-Type',req.url === '/sdk.js' ? 'application/javascript' : 'text/html');
  res.end(req.url === '/sdk.js' ? sdk : '<!doctype html><title>Local chat test harness</title><textarea aria-label="Message"></textarea><script src="/sdk.js"></script>');
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({channel:'chrome'});
async function pageFor(session) {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(origin); await initialize(page,session); return page;
}
async function initialize(page,session) {
  await page.evaluate(async ({url,key,session}) => {
    window.db = supabase.createClient(url,key,{auth:{persistSession:true,autoRefreshToken:false}});
    if(session) { const r = await db.auth.setSession(session); if(r.error) throw Error(r.error.message); }
    window.events = []; window.conversationEvents = []; window.ready = false; window.subscriptionError = null;
  }, {url:cfg.API_URL,key:cfg.ANON_KEY,session});
}
async function subscribe(page,anonymous=false) {
  await page.evaluate(async ({conversation,anonymous}) => {
    const {data} = await db.auth.getSession();
    await db.realtime.setAuth(anonymous ? undefined : data.session.access_token);
    window.channel = db.channel('browser-'+crypto.randomUUID())
      .on('system',{},p=>{if(p.extension==='postgres_changes') {if(p.status==='ok') window.ready=true; else window.subscriptionError=p.message;}})
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',...(anonymous ? {} : {filter:`conversation_id=eq.${conversation}`})},p=>events.push(p.new))
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'conversations',...(anonymous ? {} : {filter:`id=eq.${conversation}`})},p=>conversationEvents.push(p.new))
      .subscribe();
  },{conversation:thread.data,anonymous});
  await page.waitForFunction(()=>window.ready || window.subscriptionError,{},{timeout:20000});
  const error = await page.evaluate(()=>window.subscriptionError);
  if(error) {
    assert.ok(anonymous, error);
    assert.match(error,/permission|authoriz|table|schema/i);
    console.log('Anonymous subscription denied by server: '+error);
  }
}
async function rpc(page,name,args) {
  return page.evaluate(async ({name,args})=>{const r=await db.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;},{name,args});
}
const send = (page,body) => rpc(page,'send_message',{p_conversation_id:thread.data,p_body:body,p_client_message_id:randomUUID()});
const read = page => page.evaluate(async c=>{const r=await db.from('messages').select('id,body').eq('conversation_id',c);if(r.error)throw Error(r.error.message);return r.data;},thread.data);
try {
  const s = await pageFor(seller.session), b = await pageFor(buyer.session);
  const x = await pageFor(stranger.session), a = await pageFor(null);
  for(const p of [s,b,x]) await subscribe(p);
  await subscribe(a,true);
  await b.getByRole('textbox',{name:'Message'}).fill('Typed in buyer browser');
  const first = await send(b,await b.getByRole('textbox').inputValue());
  for(const p of [s,b]) await p.waitForFunction(id=>events.some(m=>m.id===id),first);
  await rpc(b,'set_conversation_hidden',{p_conversation_id:thread.data,p_hidden:true});
  await rpc(b,'set_conversation_archived',{p_conversation_id:thread.data,p_archived:true});
  const reply = await send(s,'Seller reply');
  await b.waitForFunction(id=>events.some(m=>m.id===id),reply);
  const state = await b.evaluate(async c=>(await db.from('conversation_user_states').select('*').eq('conversation_id',c).single()).data,thread.data);
  assert.equal(state.hidden_at,null); assert.equal(state.archived_at,null);
  await b.evaluate(async()=>{await db.removeAllChannels();db.realtime.disconnect();});
  const missed = await send(s,'While buyer disconnected');
  await b.reload(); await initialize(b,null); await subscribe(b);
  const history = await read(b); assert.ok(history.some(m=>m.id===missed));
  const live = await send(s,'After reload');
  await b.waitForFunction(id=>events.some(m=>m.id===id),live);
  const events = await b.evaluate(()=>window.events);
  assert.equal(new Map([...history,...events].map(m=>[m.id,m])).size,4);
  await s.waitForTimeout(1500);
  assert.equal((await read(x)).length,0);
  for(const [label,p] of [['stranger',x],['anonymous',a]]) {
    const received = await p.evaluate(()=>events);
    console.log(label+' event keys: '+JSON.stringify(received.map(m=>Object.keys(m))));
    assert.equal(received.length,0,label+' received events');
  }
  for(const table of ['messages','conversations']) {
    const result = await a.evaluate(async table=>{
      const ids=await db.from(table).select('id');
      const full=await db.from(table).select('*');
      return {ids:ids.data,idError:ids.error,fullDenied:!!full.error};
    },table);
    assert.equal(result.idError,null); assert.deepEqual(result.ids,[]); assert.ok(result.fullDenied);
  }
  await rpc(s,'remove_listing',{p_listing_id:listing,p_reason:'no_longer_selling'});
  await rpc(b,'set_conversation_hidden',{p_conversation_id:thread.data,p_hidden:true});
  await rpc(b,'set_conversation_archived',{p_conversation_id:thread.data,p_archived:true});
  await rpc(b,'mark_conversation_read',{p_conversation_id:thread.data});
  assert.equal((await read(b)).length,4);
  await assert.rejects(send(b,'After removal'),/CONVERSATION_CONCLUDED/);
  await s.waitForTimeout(1500);
  for(const p of [x,a]) assert.deepEqual(await p.evaluate(()=>({messages:events,conversations:conversationEvents})),{messages:[],conversations:[]});
  console.log('PASS: separate browser accounts, typed message, bidirectional Realtime, anonymous/stranger isolation, hidden/archive reset, reload and catch-up without duplicates');
} finally {
  await browser.close(); await new Promise(resolve=>server.close(resolve));
}
