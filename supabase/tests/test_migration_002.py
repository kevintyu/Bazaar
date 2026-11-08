"""Local-only integration tests. Run: python supabase/tests/test_migration_002.py

Uses Python's standard library, the pinned Supabase CLI, and Docker's psql.
Fixtures are isolated by UUID; reruns are safe. Reset the disposable local DB
to remove fixtures. Never accepts a remote API or database URL.
"""
import base64
import concurrent.futures
import json
from pathlib import Path
import subprocess
import threading
import unittest
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
CONTAINER = 'supabase_db_bazaar-migration-test'
API = 'http://127.0.0.1:54321'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


def sql(statement):
    result = subprocess.run(
        ['docker', 'exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
         '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
        input=statement, text=True, capture_output=True, check=True)
    return result.stdout.strip()


class MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['npx.cmd', '--yes', 'supabase@3.0.0', 'status', '-o', 'json'],
                                cwd=ROOT, capture_output=True, text=True, check=True)
        config = json.loads(result.stdout)
        if config['API_URL'].rstrip('/') != API:
            raise RuntimeError('Refusing non-local or unexpected Supabase endpoint')
        cls.key = config['ANON_KEY']
        cls.owner = cls.signup()
        cls.other = cls.signup()
        cls.buyer = cls.signup()
        cls.shop = cls.activate(cls.owner)
        cls.other_shop = cls.activate(cls.other)

    @classmethod
    def request(cls, method, path, user=None, data=None, headers=None, raw=False):
        h = {'apikey': cls.key, 'Authorization': 'Bearer ' + (user['access_token'] if user else cls.key)}
        if headers:
            h.update(headers)
        if data is not None and not raw:
            data = json.dumps(data).encode()
            h['Content-Type'] = 'application/json'
        req = urllib.request.Request(API + path, data=data, headers=h, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        try:
            body = response.read()
        finally:
            response.close()
        try:
            body = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            pass
        return response.status, body

    @classmethod
    def signup(cls):
        status, body = cls.request('POST', '/auth/v1/signup', data={
            'email': f'migration-{uuid.uuid4().hex}@example.test',
            'password': 'Local-test-only-42!Strong'})
        if status != 200 or 'access_token' not in body:
            raise RuntimeError(f'Local signup failed ({status})')
        return body

    @classmethod
    def activate(cls, user):
        status, body = cls.request('POST', '/rest/v1/rpc/activate_selling', user, {
            'p_shop_name': 'Migration test shop', 'p_country_code': 'US',
            'p_locality': 'Test City', 'p_formatted_address': '123 Private Test Street'})
        if status != 200:
            raise RuntimeError(f'Seller activation failed: {body}')
        return body

    def rpc(self, name, data, user=None):
        return self.request('POST', '/rest/v1/rpc/' + name, user or self.owner, data)

    def draft(self, complete=True):
        data = {'p_shop_id': self.shop, 'p_title': 'Test item'}
        if complete:
            data.update(p_asking_price=12.50, p_currency='USD', p_category_key='household', p_condition='good')
        status, body = self.rpc('create_listing', data)
        self.assertEqual(status, 200, body)
        return body

    def upload(self, listing, user=None, image=None):
        image = image or str(uuid.uuid4())
        path = f'{listing}/{image}.png'
        status, body = self.request('POST', '/storage/v1/object/listing-images/' + path,
                                    user or self.owner, PNG, {'Content-Type': 'image/png', 'x-upsert': 'false'}, True)
        self.assertEqual(status, 200, body)
        return image, path

    def attach(self, listing, image):
        status, body = self.rpc('attach_listing_image', {
            'p_listing_id': listing, 'p_image_id': image, 'p_extension': 'png'})
        self.assertEqual(status, 200, body)

    def ready(self):
        listing = self.draft()
        image, path = self.upload(listing)
        self.attach(listing, image)
        return listing, image, path

    def denied(self, result, message=None):
        status, body = result
        self.assertGreaterEqual(status, 400, body)
        if message:
            self.assertIn(message, str(body))

    def test_01_structural_checks(self):
        sql((ROOT / 'supabase/tests/002_structural_checks.sql').read_text())

    def test_02_private_schema_not_exposed(self):
        for schema in ('private', 'internal'):
            status, body = self.request('GET', '/rest/v1/', self.owner, headers={'Accept-Profile': schema})
            self.assertEqual(status, 406, body)
        self.assertNotIn('private', __import__('tomllib').loads((ROOT / 'supabase/config.toml').read_text())['api']['schemas'])

    def test_03_auth_profile_and_activation(self):
        user = self.buyer['user']['id']
        self.assertEqual(sql(f"select count(*) from public.profiles where id='{user}' and not selling_enabled"), '1')
        self.denied(self.rpc('activate_selling', {'p_shop_name': 'Again', 'p_country_code': 'US'}), 'SELLING_ALREADY_ENABLED')

    def test_04_owner_nonowner_and_anonymous_creation(self):
        listing = self.draft()
        self.denied(self.rpc('create_listing', {'p_shop_id': self.other_shop}), 'SHOP_NOT_OWNED')
        self.denied(self.rpc('create_listing', {'p_shop_id': self.shop}, self.buyer))
        self.denied(self.request('POST', '/rest/v1/rpc/create_listing', data={'p_shop_id': self.shop}))
        status, body = self.request('GET', f'/rest/v1/listings?id=eq.{listing}', self.other)
        self.assertEqual((status, body), (200, []))
        self.denied(self.rpc('publish_listing', {'p_listing_id': listing}, self.other), 'LISTING_NOT_OWNED')

    def test_05_content_and_protected_columns(self):
        listing = self.draft()
        status, body = self.request('PATCH', f'/rest/v1/listings?id=eq.{listing}', self.owner,
                                    {'title': 'Updated'}, {'Prefer': 'return=representation'})
        self.assertEqual(status, 200, body)
        self.assertEqual(body[0]['title'], 'Updated')
        for field, value in [('status','active'), ('moderation_status','under_review'),
                             ('owner_user_id',self.other['user']['id']), ('published_at','2026-01-01T00:00:00Z')]:
            self.denied(self.request('PATCH', f'/rest/v1/listings?id=eq.{listing}', self.owner, {field:value}))
        status, body = self.request('PATCH', f'/rest/v1/listings?id=eq.{listing}', self.other,
                                    {'title':'Stolen'}, {'Prefer':'return=representation'})
        self.assertEqual((status,body),(200,[]))

    def test_06_invalid_location_override(self):
        location = sql(f"select default_location_id from public.shops where id='{self.other_shop}'")
        listing = self.draft()
        self.denied(self.request('PATCH', f'/rest/v1/listings?id=eq.{listing}', self.owner,
                                 {'location_override_id':location}), 'listings_location_owner_fk')
        self.denied(self.rpc('create_listing', {'p_shop_id':self.shop,'p_location_override_id':location}),
                    'listings_location_owner_fk')

    def test_07_missing_content_image_and_rollback(self):
        listing = self.draft(False)
        self.denied(self.rpc('publish_listing', {'p_listing_id':listing}), 'LISTING_INCOMPLETE')
        listing = self.draft()
        self.denied(self.rpc('publish_listing', {'p_listing_id':listing}), 'IMAGE_REQUIRED')
        self.assertEqual(sql(f"select status||':'||(published_at is null)::text from public.listings where id='{listing}'"), 'draft:true')

    def test_08_storage_owner_restrictions(self):
        listing = self.draft()
        image, path = self.upload(listing)
        self.denied(self.request('POST', '/storage/v1/object/listing-images/'+f'{listing}/{uuid.uuid4()}.png',
                                 self.other, PNG, {'Content-Type':'image/png'}, True))
        self.denied(self.request('POST', '/storage/v1/object/listing-images/'+path,
                                 self.owner, PNG, {'Content-Type':'image/png','x-upsert':'true'}, True))
        self.denied(self.request('POST', '/storage/v1/object/sign/listing-images/'+path, self.other, {'expiresIn':60}))
        self.denied(self.request('GET', '/storage/v1/object/public/listing-images/'+path))
        self.denied(self.request('GET', '/storage/v1/object/authenticated/listing-images/'+path, self.other))
        status, body = self.request('POST', '/storage/v1/object/sign/listing-images/'+path, self.owner, {'expiresIn':60})
        self.assertEqual(status, 200, body)

    def test_09_attach_requires_existing_owned_object(self):
        listing = self.draft()
        self.denied(self.rpc('attach_listing_image', {'p_listing_id':listing,'p_image_id':str(uuid.uuid4()),
                                                     'p_extension':'png'}), 'IMAGE_MISSING_OR_NOT_OWNED')
        image, path = self.upload(listing)
        self.denied(self.rpc('attach_listing_image', {'p_listing_id':listing,'p_image_id':image,'p_extension':'png'},
                             self.other), 'LISTING_NOT_OWNED')
        sql(f"update storage.objects set owner_id='{self.other['user']['id']}' where bucket_id='listing-images' and name='{path}'")
        self.denied(self.rpc('attach_listing_image', {'p_listing_id':listing,'p_image_id':image,'p_extension':'png'}),
                    'IMAGE_MISSING_OR_NOT_OWNED')
        self.denied(self.request('POST','/rest/v1/listing_images',self.owner,
                                 {'listing_id':listing,'storage_path':path,'sort_order':0}))

    def test_10_publish_remove_and_public_projection(self):
        listing, image, path = self.ready()
        self.assertEqual(self.rpc('get_public_listing', {'p_listing_id':listing})[1], None)
        self.assertEqual(self.rpc('publish_listing', {'p_listing_id':listing})[0], 200)
        stamp = sql(f"select published_at from public.listings where id='{listing}'")
        self.denied(self.rpc('publish_listing', {'p_listing_id':listing}), 'INVALID_LISTING_STATE')
        self.assertEqual(sql(f"select published_at from public.listings where id='{listing}'"), stamp)
        status, body = self.request('POST','/rest/v1/rpc/get_public_listing',data={'p_listing_id':listing})
        self.assertEqual(status,200,body)
        self.assertEqual(body['id'],listing)
        for key in ('owner_user_id','location_override_id','moderation_status','removal_details'):
            self.assertNotIn(key,body)
        self.assertNotIn('123 Private', str(body))
        self.denied(self.rpc('remove_listing', {'p_listing_id':listing,'p_reason':'other'},self.other))
        self.assertEqual(self.rpc('remove_listing', {'p_listing_id':listing,'p_reason':'other'})[0],200)
        self.assertEqual(self.request('POST','/rest/v1/rpc/get_public_listing',data={'p_listing_id':listing}), (200,None))
        status, body = self.request('GET',f'/rest/v1/listings?id=eq.{listing}',self.owner)
        self.assertEqual(body[0]['status'],'removed')
        self.denied(self.request('POST','/storage/v1/object/sign/listing-images/'+path,self.other,{'expiresIn':60}))

    def test_11_detach_delete_and_discard(self):
        listing, image, path = self.ready()
        self.request('DELETE','/storage/v1/object/listing-images',self.owner,{'prefixes':[path]})
        self.assertEqual(sql(f"select count(*) from storage.objects where bucket_id='listing-images' and name='{path}'"),'1')
        self.denied(self.rpc('discard_draft_listing',{'p_listing_id':listing}),'LISTING_IMAGES_REQUIRE_CLEANUP')
        self.assertEqual(self.rpc('detach_listing_image',{'p_image_id':image}), (200,path))
        self.denied(self.rpc('discard_draft_listing',{'p_listing_id':listing}),'LISTING_IMAGES_REQUIRE_CLEANUP')
        status, body = self.request('DELETE','/storage/v1/object/listing-images',self.owner,{'prefixes':[path]})
        self.assertEqual(status,200,body)
        self.assertEqual(sql(f"select count(*) from storage.objects where bucket_id='listing-images' and name='{path}'"),'0')
        self.assertEqual(self.rpc('discard_draft_listing',{'p_listing_id':listing})[0],200)

    def test_12_active_last_image_and_required_fields(self):
        listing,image,path = self.ready()
        self.assertEqual(self.rpc('publish_listing',{'p_listing_id':listing})[0],200)
        self.denied(self.rpc('detach_listing_image',{'p_image_id':image}),'LAST_ACTIVE_IMAGE_REQUIRED')
        self.denied(self.request('PATCH',f'/rest/v1/listings?id=eq.{listing}',self.owner,{'title':None}))
        image2,path2 = self.upload(listing)
        self.attach(listing,image2)
        self.assertEqual(self.rpc('detach_listing_image',{'p_image_id':image2}),(200,path2))
        self.assertEqual(self.request('DELETE','/storage/v1/object/listing-images',self.owner,{'prefixes':[path2]})[0],200)

    def test_13_suspension_moderation_and_reserved_state(self):
        listing,image,path = self.ready()
        owner = self.owner['user']['id']
        try:
            sql(f"update public.profiles set status='suspended' where id='{owner}'")
            self.denied(self.rpc('create_listing',{'p_shop_id':self.shop}),'SELLING_NOT_ALLOWED')
            self.denied(self.rpc('publish_listing',{'p_listing_id':listing}),'SELLING_NOT_ALLOWED')
        finally:
            sql(f"update public.profiles set status='active' where id='{owner}'")
        sql(f"update public.listings set moderation_status='under_review' where id='{listing}'")
        self.denied(self.rpc('publish_listing',{'p_listing_id':listing}),'INVALID_LISTING_STATE')
        sql(f"update public.listings set status='reserved',published_at=now() where id='{listing}'")
        self.denied(self.rpc('remove_listing',{'p_listing_id':listing,'p_reason':'other'}),'INVALID_LISTING_STATE')

    def test_14_concurrent_attach_and_publish(self):
        listing = self.draft()
        images = [self.upload(listing)[0] for _ in range(2)]
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda image: self.rpc('attach_listing_image',
                {'p_listing_id':listing,'p_image_id':image,'p_extension':'png'}), images))
        self.assertEqual([x[0] for x in results],[200,200],results)
        self.assertEqual(sql(f"select count(distinct sort_order) from public.listing_images where listing_id='{listing}'"),'2')
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _:self.rpc('publish_listing',{'p_listing_id':listing}), range(2)))
        self.assertEqual(sum(x[0] == 200 for x in results),1,results)
        self.assertIn('INVALID_LISTING_STATE',str(results))

    def test_15_concurrent_detach_preserves_active_image(self):
        listing,image,path = self.ready()
        image2,path2 = self.upload(listing)
        self.attach(listing,image2)
        self.assertEqual(self.rpc('publish_listing',{'p_listing_id':listing})[0],200)
        barrier = threading.Barrier(2)
        def detach(image_id):
            barrier.wait()
            return self.rpc('detach_listing_image',{'p_image_id':image_id})
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(detach, [image,image2]))
        self.assertEqual(sum(x[0] == 200 for x in results),1,results)
        self.assertIn('LAST_ACTIVE_IMAGE_REQUIRED',str(results))
        self.assertEqual(sql(f"select count(*) from public.listing_images where listing_id='{listing}'"),'1')

    def test_16_concurrent_attach_and_storage_delete(self):
        listing = self.draft()
        image,path = self.upload(listing)
        barrier = threading.Barrier(2)
        def attach():
            barrier.wait()
            return self.rpc('attach_listing_image',{'p_listing_id':listing,'p_image_id':image,'p_extension':'png'})
        def delete():
            barrier.wait()
            return self.request('DELETE','/storage/v1/object/listing-images',self.owner,{'prefixes':[path]})
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(attach),pool.submit(delete)]
            results = [f.result() for f in futures]
        self.assertEqual(results[1][0],200,results)
        self.assertEqual(sql(f"""select count(*) from public.listing_images i
          where i.listing_id='{listing}' and not exists (
            select 1 from storage.objects o where o.bucket_id='listing-images' and o.name=i.storage_path)"""),'0')
        if results[0][0] != 200:
            self.assertIn('IMAGE_MISSING_OR_NOT_OWNED',str(results[0]))

    def test_17_public_visibility_checks_account_shop_and_moderation(self):
        listing,image,path = self.ready()
        self.assertEqual(self.rpc('publish_listing',{'p_listing_id':listing})[0],200)
        for table, row_id, field, hidden_value, original in [
            ('listings',listing,'moderation_status','under_review','clear'),
            ('shops',self.shop,'status','suspended','active'),
            ('profiles',self.owner['user']['id'],'status','suspended','active')]:
            try:
                sql(f"update public.{table} set {field}='{hidden_value}' where id='{row_id}'")
                self.assertEqual(self.request('POST','/rest/v1/rpc/get_public_listing',data={'p_listing_id':listing}), (200,None))
            finally:
                sql(f"update public.{table} set {field}='{original}' where id='{row_id}'")

    def test_18_missing_location_and_owner_fks_are_structurally_impossible(self):
        # Missing effective location cannot be constructed: Shop default is NOT NULL,
        # and both Shop/Listing location references are constrained to their owner.
        self.assertEqual(sql("select attnotnull from pg_attribute where attrelid='public.shops'::regclass and attname='default_location_id'"),'t')
        listing = self.draft()
        with self.assertRaises(subprocess.CalledProcessError):
            sql(f"update public.listings set owner_user_id='{self.other['user']['id']}' where id='{listing}'")

    def test_19_unauthenticated_claim_and_price_validation(self):
        with self.assertRaises(subprocess.CalledProcessError) as error:
            sql(f"set role authenticated; select public.create_listing('{self.shop}');")
        self.assertIn('UNAUTHENTICATED',error.exception.stderr)
        listing = self.draft()
        for price in (-1, 'NaN'):
            self.denied(self.request('PATCH',f'/rest/v1/listings?id=eq.{listing}',self.owner,{'asking_price':price}))

    def test_20_image_attachment_failure_rolls_back(self):
        listing,image,path = self.ready()
        before = sql(f"select count(*) from public.listing_images where listing_id='{listing}'")
        self.denied(self.rpc('attach_listing_image',{'p_listing_id':listing,'p_image_id':image,'p_extension':'png'}))
        self.assertEqual(sql(f"select count(*) from public.listing_images where listing_id='{listing}'"),before)
        self.assertEqual(sql(f"select status from public.listings where id='{listing}'"),'draft')


if __name__ == '__main__':
    unittest.main(verbosity=2)
