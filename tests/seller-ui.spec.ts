import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const password = 'Local-only-test-42!Strong';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function sql(statement: string) {
  return execFileSync('docker', ['exec', '-i', 'supabase_db_bazaar-migration-test',
    'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { input: statement, encoding: 'utf8' }).trim();
}
async function account(selling = true) {
  const email = `ui-${randomUUID()}@example.test`;
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.auth.signUp({ email, password });
  expect(error).toBeNull();
  let shop: string | undefined;
  if (selling) {
    const result = await db.rpc('activate_selling', { p_shop_name: 'Browser test shop', p_country_code: 'US',
      p_formatted_address: '555 Hidden Test Street', p_public_precision: 'city', p_locality: 'Boston' });
    expect(result.error).toBeNull();
    shop = result.data;
  }
  return { db, email, user: data.user!.id, shop: shop! };
}
async function signIn(page: Page, email: string) {
  await page.goto('/auth');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page).toHaveURL(/\/sell$/);
}
async function fixture() {
  const owner = await account();
  const { data: listing, error } = await owner.db.rpc('create_listing', {
    p_shop_id: owner.shop, p_title: `Fixture ${randomUUID()}`, p_asking_price: 25,
    p_currency: 'USD', p_category_key: 'books', p_condition: 'good',
  });
  expect(error).toBeNull();
  const image = randomUUID();
  const path = `${listing}/${image}.png`;
  expect((await owner.db.storage.from('listing-images').upload(path, png, { contentType: 'image/png' })).error).toBeNull();
  expect((await owner.db.rpc('attach_listing_image', { p_listing_id: listing, p_image_id: image, p_extension: 'png' })).error).toBeNull();
  return { ...owner, listing: listing as string, image, path };
}

test('registration, shop activation, draft editing, photos, publication and removal', async ({ page, request }) => {
  const email = `ui-flow-${randomUUID()}@example.test`;
  const title = `Oak table ${randomUUID()}`;
  await page.goto('/auth');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await page.getByLabel('Display name').fill('Local seller');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click();
  await page.getByRole('link', { name: 'Start selling' }).click();
  await page.getByLabel('Shop name').fill('Oak & Paper');
  await page.getByLabel('City or locality').fill('Boston');
  await page.getByRole('button', { name: 'Create my shop' }).click();
  await expect(page.getByRole('heading', { name: 'Oak & Paper' })).toBeVisible();
  const dashboard = new URL(page.url()).pathname;
  await page.getByRole('link', { name: '+ New listing' }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Asking price').fill('85.50');
  await page.getByRole('combobox', { name: /^Category/ }).selectOption('furniture');
  await page.getByRole('combobox', { name: /^Condition/ }).selectOption('good');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page).not.toHaveURL(/\/new$/);
  await page.reload();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(title);
  await expect(page.getByLabel('Asking price')).toHaveValue('85.5');
  await page.getByLabel('Upload listing photos').setInputFiles({ name: 'item.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('status')).toContainText('Photo added');
  const listing = new URL(page.url()).pathname.split('/').at(-1)!;
  const image = sql(`select id from public.listing_images where listing_id='${listing}'`);
  expect((await request.get(`/api/listings/${listing}/images/${image}`, { maxRedirects: 0 })).status()).toBe(404);
  await page.screenshot({ path: 'test-results/editor-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Publish listing', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${dashboard}$`));
  const publicPage = await page.context().browser()!.newContext();
  const visitor = await publicPage.newPage();
  await visitor.goto('/browse');
  await visitor.getByRole('link').filter({ hasText: title }).click();
  await expect(visitor.getByRole('heading', { name: title })).toBeVisible();
  await expect(visitor.locator('.detail-hero img')).toBeVisible();
  await expect.poll(() => visitor.locator('.detail-hero img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await visitor.getByRole('link', { name: 'Visit shop' }).click();
  await expect(visitor.getByRole('heading', { name: 'Oak & Paper' })).toBeVisible();
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.screenshot({ path: 'test-results/shop-mobile.png', fullPage: true });
  expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove listing', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Listing removed');
  expect((await request.get(`/api/listings/${listing}/images/${image}`, { maxRedirects: 0 })).status()).toBe(404);
  await visitor.goto(`/listing/${listing}`);
  await expect(visitor.getByRole('heading', { name: title })).toHaveCount(0);
  await visitor.goto('/browse');
  await expect(visitor.getByRole('link').filter({ hasText: title })).toHaveCount(0);
  await publicPage.close();
});

test('unauthenticated and other sellers cannot access editor controls', async ({ page }) => {
  await page.goto('/sell');
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await page.goto('/sell/start');
  await expect(page).toHaveURL(/\/auth$/);
  const owner = await fixture();
  const other = await account();
  await signIn(page, other.email);
  await page.goto(`/sell/shops/${owner.shop}/listings`);
  await expect(page.locator('main').getByRole('alert')).toContainText('does not belong');
  await expect(page.getByRole('link', { name: '+ New listing' })).toHaveCount(0);
  await page.goto(`/sell/shops/${owner.shop}/listings/${owner.listing}`);
  await expect(page.locator('main').getByRole('alert')).toContainText('does not belong');
  await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0);
});

test('nullable backend drafts render, refresh and discard safely', async ({ page }) => {
  const owner = await account();
  const { data: listing, error } = await owner.db.rpc('create_listing', { p_shop_id: owner.shop });
  expect(error).toBeNull();
  await signIn(page, owner.email);
  await page.goto(`/sell/shops/${owner.shop}/listings`);
  await expect(page.getByText('Untitled draft')).toBeVisible();
  await expect(page.getByText('Price not set')).toBeVisible();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Asking price')).toHaveValue('');
  await page.reload();
  await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
  await page.goto(`/sell/shops/${owner.shop}/listings`);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Draft discarded');
  expect(sql(`select count(*) from public.listings where id='${listing}'`)).toBe('0');
});

test('public image endpoint checks every visibility condition and image relationship', async ({ request }) => {
  const owner = await fixture();
  const endpoint = `/api/listings/${owner.listing}/images/${owner.image}`;
  expect((await request.get(endpoint, { maxRedirects: 0 })).status()).toBe(404);
  expect((await owner.db.rpc('publish_listing', { p_listing_id: owner.listing })).error).toBeNull();
  const response = await request.get(endpoint, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect((await request.get(response.headers().location)).ok()).toBe(true);
  for (const [table,id,column,value,original] of [
    ['listings',owner.listing,'moderation_status','under_review','clear'],
    ['shops',owner.shop,'status','suspended','active'],
    ['profiles',owner.user,'status','banned','active'],
  ]) {
    try {
      sql(`update public.${table} set ${column}='${value}' where id='${id}'`);
      const hidden = await request.get(endpoint, { maxRedirects: 0 });
      expect(hidden.status()).toBe(404);
      expect(hidden.headers()['cache-control']).toContain('no-store');
    } finally { sql(`update public.${table} set ${column}='${original}' where id='${id}'`); }
  }
  const other = await fixture();
  expect((await request.get(`/api/listings/${owner.listing}/images/${other.image}`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await request.get('/api/listings/invalid/images/invalid', { maxRedirects: 0 })).status()).toBe(404);
  const html = await (await request.get(`/listing/${owner.listing}`)).text();
  expect(html).not.toContain('555 Hidden Test Street');
  expect(html).not.toContain('location_override_id');
  expect(html).not.toContain(process.env.SUPABASE_SERVICE_ROLE_KEY!);
  expect((await owner.db.rpc('remove_listing', { p_listing_id: owner.listing, p_reason: 'other' })).error).toBeNull();
  expect((await request.get(endpoint, { maxRedirects: 0 })).status()).toBe(404);
});

test('detached-photo cleanup failure is visible and retryable', async ({ page }) => {
  const owner = await fixture();
  await signIn(page, owner.email);
  await page.goto(`/sell/shops/${owner.shop}/listings/${owner.listing}`);
  await expect(page.getByRole('button', { name: 'Remove photo' })).toBeVisible();
  await page.route('**/storage/v1/object/listing-images', async route => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary cleanup failure' }) });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Remove photo' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('cleanup failed');
  await page.unroute('**/storage/v1/object/listing-images');
  await page.getByRole('button', { name: 'Retry unused photo cleanup' }).click();
  await expect(page.getByRole('status')).toContainText('Unused uploads cleaned up');
  expect(sql(`select count(*) from storage.objects where bucket_id='listing-images' and name='${owner.path}'`)).toBe('0');
});

test('browser assets contain no server credential', async () => {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  expect(secret.length).toBeGreaterThan(20);
  function scan(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) scan(child);
      else expect(readFileSync(child).includes(Buffer.from(secret)), child).toBe(false);
    }
  }
  scan('.next/static');
});
