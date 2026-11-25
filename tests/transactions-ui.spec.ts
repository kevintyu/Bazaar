import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const url=process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const password='Local-only-test-42!Strong';
function sql(statement:string) { return execFileSync('docker',['exec','-i','supabase_db_bazaar-migration-test','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],{input:statement,encoding:'utf8'}).trim(); }
async function account(seller=false) {
 const db=createClient(url,key,{auth:{persistSession:false}}); const email=`transaction-ui-${randomUUID()}@example.test`;
 const auth=await db.auth.signUp({email,password});expect(auth.error).toBeNull();
 let shop='';if(seller){const r=await db.rpc('activate_selling',{p_shop_name:'Transaction UI shop',p_country_code:'US',p_formatted_address:'PRIVATE ADDRESS NOT FOR UI',p_public_precision:'city'});expect(r.error).toBeNull();shop=r.data;}
 return {db,email,user:auth.data.user!.id,shop};
}
async function fixture() {
 const seller=await account(true);const buyer=await account();
 const r=await seller.db.rpc('create_listing',{p_shop_id:seller.shop,p_title:`Handover ${randomUUID()}`,p_asking_price:42.5,p_currency:'EUR',p_category_key:'books',p_condition:'good'});expect(r.error).toBeNull();const listing=r.data as string;
 const image=randomUUID(); const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 expect((await seller.db.storage.from('listing-images').upload(`${listing}/${image}.png`,png,{contentType:'image/png'})).error).toBeNull();
 expect((await seller.db.rpc('attach_listing_image',{p_listing_id:listing,p_image_id:image,p_extension:'png'})).error).toBeNull();
 expect((await seller.db.rpc('publish_listing',{p_listing_id:listing})).error).toBeNull();
 return {seller,buyer,listing};
}
async function signIn(page:Page,email:string) {await page.goto('/auth');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).last().click();await expect(page).toHaveURL(/\/sell$/);}
async function reserveFixture() {const f=await fixture(); const c=await f.buyer.db.rpc('start_conversation',{p_listing_id:f.listing});expect(c.error).toBeNull();const t=await f.seller.db.rpc('reserve_listing',{p_conversation_id:c.data,p_request_id:randomUUID()});expect(t.error).toBeNull();return {...f,conversation:c.data as string,transaction:t.data as string};}

test('buyer and seller handover flow, retained history, mobile and unrelated access',async({browser,page})=>{
 const f=await fixture();const buyerContext=await browser.newContext();const buyer=await buyerContext.newPage();
 try {
 await signIn(buyer,f.buyer.email);await buyer.goto(`/listing/${f.listing}`);await buyer.getByRole('button',{name:'Message seller'}).click();await expect(buyer).toHaveURL(/\/messages\//);
 const conversation=new URL(buyer.url()).pathname.split('/').at(-1)!;
 await buyer.getByLabel('Message',{exact:true}).fill('Can I pick this up today?');await buyer.getByRole('button',{name:'Send message',exact:true}).click();await expect(buyer.getByRole('status')).toContainText('Message sent');
 await signIn(page,f.seller.email);await page.goto(`/messages/${conversation}`);await expect(page.getByText('Can I pick this up today?')).toBeVisible();
 await page.getByRole('button',{name:'Reserve for this buyer',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click();
 await page.getByRole('link',{name:'View reservation result'}).click();await expect(page).toHaveURL(/\/transactions\//);const transaction=new URL(page.url()).pathname.split('/').at(-1)!;
 expect(sql(`select buyer_user_id from public.transactions where id='${transaction}'`)).toBe(f.buyer.user);
 await expect(page.getByTestId('transaction-status')).toHaveText('Reserved');await expect(page.getByRole('button',{name:"I've picked up this item"})).toHaveCount(0);
 await buyer.goto('/purchases');await expect(buyer.getByText('Listing details unavailable')).toBeVisible();await buyer.getByRole('link',{name:'View transaction'}).click();
 await buyer.getByRole('button',{name:"I've picked up this item"}).click();await expect(buyer.getByRole('dialog')).toContainText('seller must confirm');
 let calls=0;await buyer.route('**/rest/v1/rpc/claim_pickup',async route=>{calls++;await new Promise(r=>setTimeout(r,300));await route.continue();});
 await buyer.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).dblclick();
 await expect(buyer.getByTestId('transaction-status')).toHaveText('Awaiting seller confirmation');expect(calls).toBe(1);
 expect(sql(`select status from public.listings where id='${f.listing}'`)).toBe('reserved');
 await buyer.reload();await expect(buyer.getByTestId('transaction-status')).toHaveText('Awaiting seller confirmation');await expect(buyer.getByRole('button',{name:'Confirm item handover'})).toHaveCount(0);
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Confirm item handover'}).click();await expect(page.getByRole('dialog')).toContainText('marks the listing SOLD');await page.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click();
 await expect(page.getByTestId('transaction-status')).toHaveText('Completed');expect(sql(`select status from public.listings where id='${f.listing}'`)).toBe('sold');expect(sql(`select count(*) from public.transaction_events where transaction_id='${transaction}' and to_status='completed'`)).toBe('1');
 await page.goto('/sales');await expect(page.locator('.status.completed')).toBeVisible();await page.screenshot({path:'test-results/transactions-desktop.png',fullPage:true});
 await buyer.goto('/purchases');await expect(buyer.locator('.status.completed')).toBeVisible();await buyer.setViewportSize({width:390,height:844});await buyer.screenshot({path:'test-results/transactions-mobile.png',fullPage:true});expect(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await buyer.getByRole('link',{name:'Open conversation'}).click();await expect(buyer.getByText('This conversation is read-only.',{exact:false})).toBeVisible();await expect(buyer.getByLabel('Message',{exact:true})).toHaveCount(0);await expect(buyer.getByText('Can I pick this up today?')).toBeVisible();
 expect(await buyer.locator('main').innerText()).not.toContain('PRIVATE ADDRESS');
 expect((await f.buyer.db.rpc('set_conversation_hidden',{p_conversation_id:conversation,p_hidden:true})).error).toBeNull();await buyer.goto('/messages');await expect(buyer.getByText('No conversations yet')).toBeVisible();await buyer.getByLabel('Include hidden and archived history').check();await expect(buyer.locator('main').getByRole('link',{name:'Open conversation',exact:true})).toBeVisible();
 const stranger=await account();await signIn(page,stranger.email);await page.goto(`/transactions/${transaction}`);await expect(page.getByText('Transaction unavailable.',{exact:false})).toBeVisible();await expect(page.getByTestId('transaction-status')).toHaveCount(0);await page.goto(`/messages/${conversation}`);await expect(page.getByText('Conversation unavailable.',{exact:false})).toBeVisible();
 } finally {await buyerContext.close();}
});

test('restriction errors, stale confirmation and cancellation history',async({page})=>{
 const f=await reserveFixture();await signIn(page,f.buyer.email);await page.goto(`/transactions/${f.transaction}`);
 try {
 sql(`update public.listings set moderation_status='under_review' where id='${f.listing}'`);
 await page.getByRole('button',{name:'Cancel reservation',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click();await expect(page.locator('main').getByRole('alert')).toContainText('restricted');await expect(page.getByTestId('transaction-status')).toHaveText('Reserved');
 } finally {sql(`update public.listings set moderation_status='clear' where id='${f.listing}'`);}
 await page.getByRole('button',{name:"I've picked up this item"}).click();
 expect((await f.seller.db.rpc('cancel_transaction',{p_transaction_id:f.transaction,p_reason:'Plans changed'})).error).toBeNull();
 await page.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click();await expect(page.locator('main').getByRole('alert')).toContainText('no longer allows');await expect(page.getByTestId('transaction-status')).toHaveText('Cancelled');await expect(page.getByText('Request processed.',{exact:false})).toHaveCount(0);
 await page.goto('/purchases');await expect(page.locator('.status.cancelled')).toBeVisible();await page.getByRole('link',{name:'View transaction'}).click();await expect(page.getByText('Cancellation reason: Plans changed')).toBeVisible();
 const other=await reserveFixture();await signIn(page,other.buyer.email);await page.goto(`/transactions/${other.transaction}`);await page.getByRole('button',{name:'Cancel reservation',exact:true}).click();await page.getByLabel('Cancellation reason (optional)').fill('Cannot collect');await page.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click();await expect(page.getByTestId('transaction-status')).toHaveText('Cancelled');expect(sql(`select status from public.listings where id='${other.listing}'`)).toBe('active');
});

test('reservation response loss preserves request key and does not reserve twice',async({page})=>{
 const f=await fixture();const c=await f.buyer.db.rpc('start_conversation',{p_listing_id:f.listing});expect(c.error).toBeNull();await signIn(page,f.seller.email);await page.goto(`/messages/${c.data}`);
 let original='';await page.route('**/rest/v1/rpc/reserve_listing',async route=>{original=route.request().postDataJSON().p_request_id;await route.fetch();await route.abort('failed');});
 await page.getByRole('button',{name:'Reserve for this buyer',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirm',exact:true}).click();await expect(page.locator('main').getByRole('alert')).toContainText('Could not confirm');await page.unroute('**/rest/v1/rpc/reserve_listing');await page.reload();
 await expect(page.getByRole('link',{name:'Reserved transaction',exact:true})).toBeVisible();expect(sql(`select count(*) from public.transactions where conversation_id='${c.data}'`)).toBe('1');expect(sql(`select request_id from public.transactions where conversation_id='${c.data}'`)).toBe(original);
 expect(await page.evaluate(([u,c])=>localStorage.getItem(`bazaar:reserve:${u}:${c}`),[f.seller.user,c.data])).toBe(original);
 await page.getByRole('link',{name:'Reserved transaction',exact:true}).click();await expect(page.getByTestId('transaction-status')).toHaveText('Reserved');
});

test('signed-out transaction pages and empty buyer/seller views',async({page})=>{
 await page.goto('/purchases');await expect(page.locator('main').getByRole('link',{name:'Sign in'})).toBeVisible();
 const a=await account();await signIn(page,a.email);await page.goto('/purchases');await expect(page.getByText('No transactions on this page')).toBeVisible();await page.goto('/sales');await expect(page.getByText('No transactions on this page')).toBeVisible();
});
