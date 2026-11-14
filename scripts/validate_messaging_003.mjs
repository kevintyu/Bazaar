/** Local-only Migration 003 integration validation. Leaves UUID-tagged audit fixtures. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
const container = 'supabase_db_bazaar-migration-test';
const cfg = JSON.parse(execFileSync('cmd.exe', ['/d','/s','/c','npx --yes supabase@3.0.0 status -o json'], {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
assert.equal(cfg.API_URL,'http://127.0.0.1:54321');
assert.equal(new URL(cfg.DB_URL).hostname,'127.0.0.1');
const sqlArgs=['exec','-i',container,'psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'];
function sql(s){return execFileSync('docker',sqlArgs,{input:s,encoding:'utf8'}).trim();}
function sqlAsync(s){return new Promise((resolve,reject)=>{const p=spawn('docker',sqlArgs);let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',c=>c?reject(new Error(err)):resolve(out.trim()));p.stdin.end(s);});}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await f())return;await pause(100);}throw Error('Timeout: '+label);}
const clients=[];
async function user(){const db=createClient(cfg.API_URL,cfg.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});clients.push(db);const {data,error}=await db.auth.signUp({email:`chat003-${randomUUID()}@example.test`,password:'Local-test-only-42!Strong'});assert.ifError(error);assert.ok(data.session);return {db,id:data.user.id};}
async function rpc(u,fn,args){const r=await u.db.rpc(fn,args);assert.ifError(r.error);return r.data;}
async function reject(u,fn,args,code){const r=await u.db.rpc(fn,args);assert.ok(r.error,fn+' unexpectedly accepted');if(code)assert.match(r.error.message,code);}
const seller=await user(),buyer=await user(),other=await user(),stranger=await user();
const shop=await rpc(seller,'activate_selling',{p_shop_name:'Messaging 003 validation',p_country_code:'US'});
function listing(){const id=randomUUID();sql(`insert into public.listings(id,shop_id,owner_user_id,title,asking_price,currency,category_key,condition,status,published_at) values('${id}','${shop}','${seller.id}','Chat validation',1,'USD','test','good','active',now());`);return id;}
async function fixture(){const l=listing();const c=await rpc(buyer,'start_conversation',{p_listing_id:l});return {l,c};}
const send=(u,c,body='Test message',id=randomUUID())=>rpc(u,'send_message',{p_conversation_id:c,p_body:body,p_client_message_id:id});
async function rows(u,table,c){const r=await u.db.from(table).select('*').eq(table==='conversations'?'id':'conversation_id',c);assert.ifError(r.error);return r.data;}
let failures=0;const results=[];
async function test(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS: '+name);}catch(e){failures++;results.push({name,status:'FAIL',error:e.message});console.error('FAIL: '+name+' — '+e.stack);}}
const main=await fixture();
await test('RESERVED blocks new threads; both existing buyers and seller continue; cancellation reopens',async()=>{
 const c2=await rpc(other,'start_conversation',{p_listing_id:main.l});
 sql(`update public.listings set status='reserved' where id='${main.l}';`);
 await reject(stranger,'start_conversation',{p_listing_id:main.l},/LISTING_NOT_AVAILABLE_FOR_CHAT/);
 await reject(buyer,'start_conversation',{p_listing_id:main.l},/LISTING_NOT_AVAILABLE_FOR_CHAT/);
 await send(buyer,main.c);await send(seller,main.c);await send(other,c2);await send(seller,c2);
 assert.equal((await rows(buyer,'conversations',main.c))[0].status,'active');
 sql(`update public.listings set status='active' where id='${main.l}';`);
 assert.ok(await rpc(stranger,'start_conversation',{p_listing_id:main.l}));
});
await test('simultaneous same-message-ID sends, changed body and cross-conversation conflict',async()=>{
 const id=randomUUID();const ids=await Promise.all(Array.from({length:16},()=>send(buyer,main.c,'same',id)));
 assert.equal(new Set(ids).size,1);assert.equal(sql(`select count(*) from public.messages where sender_user_id='${buyer.id}' and client_message_id='${id}';`),'1');
 const conflict=randomUUID();const r=await Promise.allSettled([send(buyer,main.c,'one',conflict),send(buyer,main.c,'two',conflict)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.match(r.find(x=>x.status==='rejected').reason.message,/MESSAGE_ID_REUSE_CONFLICT/);
 const f=await fixture(),cross=randomUUID();const cr=await Promise.allSettled([send(buyer,main.c,'cross',cross),send(buyer,f.c,'cross',cross)]);
 assert.equal(cr.filter(x=>x.status==='fulfilled').length,1);assert.match(cr.find(x=>x.status==='rejected').reason.message,/MESSAGE_ID_REUSE_CONFLICT/);
});
await test('body limits, identity/RLS isolation, direct mutation denied, per-user inbox',async()=>{
 for(const body of [' '.repeat(4000)+'X','\t \n'])await reject(buyer,'send_message',{p_conversation_id:main.c,p_body:body,p_client_message_id:randomUUID()},/INVALID_MESSAGE_BODY/);
 await send(buyer,main.c,' '.repeat(3999)+'X');
 for(const t of ['conversations','messages','conversation_user_states'])assert.equal((await rows(stranger,t,main.c)).length,0);
 await reject(stranger,'send_message',{p_conversation_id:main.c,p_body:'Intrusion',p_client_message_id:randomUUID()},/CONVERSATION_NOT_FOUND/);
 const anon={db:createClient(cfg.API_URL,cfg.ANON_KEY,{auth:{persistSession:false}})};clients.push(anon.db);
 assert.ok((await anon.db.from('messages').select('*')).error);
 await reject(anon,'start_conversation',{p_listing_id:main.l});
 assert.ok((await buyer.db.from('messages').insert({conversation_id:main.c,sender_user_id:seller.id,type:'system',body:'spoof'})).error);
 assert.ok((await buyer.db.from('conversations').update({status:'concluded'}).eq('id',main.c)).error);
 await rpc(buyer,'set_conversation_hidden',{p_conversation_id:main.c,p_hidden:true});
 await rpc(buyer,'set_conversation_archived',{p_conversation_id:main.c,p_archived:true});
 assert.ok((await rows(buyer,'conversation_user_states',main.c))[0].hidden_at);
 assert.equal((await rows(seller,'conversation_user_states',main.c))[0].hidden_at,null);
 assert.equal((await rows(buyer,'conversation_user_states',main.c)).length,1);
 await send(seller,main.c,'Unhide');const state=(await rows(buyer,'conversation_user_states',main.c))[0];assert.equal(state.hidden_at,null);assert.equal(state.archived_at,null);
});
await test('terminal history, eligibility and rejected writes leave no partial records',async()=>{
 const f=await fixture();const original=await send(buyer,f.c,'history');
 for(const state of ['reserved','sold']){
  sql(`update public.listings set status='${state}' where id='${f.l}';`);
  await reject(other,'start_conversation',{p_listing_id:f.l},/LISTING_NOT_AVAILABLE_FOR_CHAT/);
 }
 await reject(buyer,'send_message',{p_conversation_id:f.c,p_body:'after sold',p_client_message_id:randomUUID()},/CONVERSATION_CONCLUDED/);
 assert.equal((await rows(buyer,'messages',f.c)).length,1);assert.equal((await rows(seller,'messages',f.c))[0].id,original);
 const g=await fixture();
 sql(`update public.listings set moderation_status='under_review' where id='${g.l}';`);
 await reject(other,'start_conversation',{p_listing_id:g.l},/LISTING_NOT_AVAILABLE_FOR_CHAT/);
 await reject(buyer,'send_message',{p_conversation_id:g.c,p_body:'moderated',p_client_message_id:randomUUID()},/LISTING_NOT_AVAILABLE_FOR_CHAT/);
 sql(`update public.listings set moderation_status='clear' where id='${g.l}';update public.profiles set status='suspended' where id='${buyer.id}';`);
 try{await reject(buyer,'send_message',{p_conversation_id:g.c,p_body:'suspended',p_client_message_id:randomUUID()},/ACCOUNT_NOT_ACTIVE/);}
 finally{sql(`update public.profiles set status='active' where id='${buyer.id}';`);}
 assert.equal((await rows(buyer,'messages',g.c)).length,0);
 await reject(seller,'start_conversation',{p_listing_id:g.l},/CANNOT_MESSAGE_OWN_LISTING/);
});
await test('parallel sends/read acknowledgements preserve timestamp maxima',async()=>{
 const before=(await rows(buyer,'conversation_user_states',main.c))[0].last_read_at;
 await Promise.all(Array.from({length:24},(_,i)=>i%3===0?rpc(buyer,'mark_conversation_read',{p_conversation_id:main.c}):send(i%2?buyer:seller,main.c)));
 assert.equal(sql(`select c.last_message_at=max(m.created_at) from public.conversations c join public.messages m on m.conversation_id=c.id where c.id='${main.c}' group by c.id;`),'t');
 assert.ok((await rows(buyer,'conversation_user_states',main.c))[0].last_read_at>=before);
});
await test('send/remove races: 12 simultaneous runs and deterministic both lock orders',async()=>{
 for(let i=0;i<12;i++){const f=await fixture();const result=await Promise.allSettled([send(buyer,f.c),rpc(seller,'remove_listing',{p_listing_id:f.l,p_reason:'no_longer_selling'})]);assert.equal(result[1].status,'fulfilled');if(result[0].status==='rejected')assert.match(result[0].reason.message,/CONVERSATION_CONCLUDED|LISTING_NOT_AVAILABLE_FOR_CHAT/);assert.equal((await rows(buyer,'conversations',f.c))[0].status,'concluded');await reject(buyer,'send_message',{p_conversation_id:f.c,p_body:'after',p_client_message_id:randomUUID()},/CONVERSATION_CONCLUDED/);}
 for(const first of ['send','remove']){
  const f=await fixture(),id=randomUUID(),tag='chat003_'+randomUUID().replaceAll('-','');
  const statement=first==='send'?`select public.send_message('${f.c}','first','${id}');`:`select public.remove_listing('${f.l}','no_longer_selling');`;
  const pending=sqlAsync(`begin;set application_name='${tag}';set local role authenticated;select set_config('request.jwt.claim.sub','${first==='send'?buyer.id:seller.id}',true);${statement}select pg_sleep(3);commit;`);
  await until(()=>sql(`select count(*) from pg_stat_activity where application_name='${tag}' and wait_event='PgSleep';`)==='1','first operation holds locks');
  const second=first==='send'?rpc(seller,'remove_listing',{p_listing_id:f.l,p_reason:'no_longer_selling'}):reject(buyer,'send_message',{p_conversation_id:f.c,p_body:'second',p_client_message_id:randomUUID()},/CONVERSATION_CONCLUDED/);
  await Promise.all([pending,second]);assert.equal((await rows(buyer,'conversations',f.c))[0].status,'concluded');
  assert.equal((await rows(buyer,'messages',f.c)).length,first==='send'?1:0);
  if(first==='send')assert.ok(await send(buyer,f.c,'first',id));
 }
});
await test('Realtime multi-user delivery, participant isolation, disconnect/reconnect history recovery',async()=>{
 const f=await fixture(),events={buyer:[],seller:[],stranger:[],control:[]},channels=[];
 async function subscribe(u,label,conversation=f.c){let postgresReady=false;await u.db.realtime.setAuth((await u.db.auth.getSession()).data.session.access_token);const ch=u.db.channel('test-'+randomUUID()).on('system',{},p=>{if(p.extension==='postgres_changes'&&p.status==='ok')postgresReady=true;else console.error('Realtime system '+label+': '+JSON.stringify(p));}).on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',filter:`conversation_id=eq.${conversation}`},p=>events[label].push(p.new));channels.push([u,ch]);await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error(label+' subscribe timeout')),15000);ch.subscribe((status,error)=>{if(status==='SUBSCRIBED'){clearTimeout(timer);res();}else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'){clearTimeout(timer);rej(error||Error(status));}});});await until(()=>postgresReady,label+' PostgreSQL subscription ready');return ch;}
 try{
  let buyerCh=await subscribe(buyer,'buyer');await subscribe(seller,'seller');await subscribe(stranger,'stranger');
  const separate=await rpc(stranger,'start_conversation',{p_listing_id:f.l});await subscribe(stranger,'control',separate);
  const control=await send(seller,separate,'isolation positive control');await until(()=>events.control.some(m=>m.id===control),'other buyer receives own Conversation event');
  const first=await send(buyer,f.c,'live buyer');await until(()=>events.buyer.some(m=>m.id===first)&&events.seller.some(m=>m.id===first),'both participants receive buyer message');
  const reply=await send(seller,f.c,'live seller');await until(()=>events.buyer.some(m=>m.id===reply)&&events.seller.some(m=>m.id===reply),'both participants receive seller reply');
  await buyer.db.removeChannel(buyerCh);buyer.db.realtime.disconnect();
  const missed=await send(seller,f.c,'offline message');await until(()=>events.seller.some(m=>m.id===missed),'sender receives offline message');
  assert.ok(!events.buyer.some(m=>m.id===missed));buyerCh=await subscribe(buyer,'buyer');
  const history=await rows(buyer,'messages',f.c);assert.ok(history.some(m=>m.id===missed));
  const after=await send(seller,f.c,'after reconnect');await until(()=>events.buyer.some(m=>m.id===after),'live delivery after reconnect');
  const merged=new Map([...history,...events.buyer].map(m=>[m.id,m]));assert.equal(merged.size,4);
  await pause(1500);assert.equal(events.stranger.length,0);assert.equal((await rows(stranger,'messages',f.c)).length,0);
 }finally{await Promise.all(channels.map(([u,ch])=>u.db.removeChannel(ch)));}
});
await Promise.all(clients.map(c=>c.removeAllChannels()));clients.forEach(c=>c.realtime.disconnect());
console.log(JSON.stringify({results,failures,fixtureShop:shop},null,2));process.exitCode=failures?1:0;
