"""Local Docker-only compatibility checks; all fixtures/DDL roll back.

Run: python supabase/tests/test_chat_eligibility_compat.py
"""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261109_002_chat_eligibility_compat.sql'


class CompatibilityTests(unittest.TestCase):
    def test_install_preservation_eligibility_and_chat(self):
        migration = MIGRATION.read_text(encoding='utf-8')
        statement = """
begin;
-- Exercise absent-helper installation even on a previously migrated database.
drop function private.shop_is_publicly_eligible(uuid);
""" + migration + """
do $$
begin
  if has_function_privilege('anon', 'private.shop_is_publicly_eligible(uuid)', 'execute')
     or has_function_privilege('authenticated', 'private.shop_is_publicly_eligible(uuid)', 'execute') then
    raise exception 'New helper should be callable only by trusted operations';
  end if;
  if not exists (select 1 from pg_proc
    where oid = 'private.shop_is_publicly_eligible(uuid)'::regprocedure
      and prosecdef and provolatile = 's' and proconfig = array['search_path=""']) then
    raise exception 'Incorrect function security configuration';
  end if;
end $$;
-- Deliberately customize ACL; the already-present path must preserve it too.
grant execute on function private.shop_is_publicly_eligible(uuid) to authenticated;
create temp table helper_before as
select oid, pg_get_functiondef(oid) as definition, proowner, proacl
from pg_proc where oid = 'private.shop_is_publicly_eligible(uuid)'::regprocedure;
""" + migration + """
do $$
declare
  seller uuid := gen_random_uuid();
  buyer uuid := gen_random_uuid();
  loc uuid := gen_random_uuid();
  shop uuid := gen_random_uuid();
  listing uuid := gen_random_uuid();
  conversation uuid;
  account_state public.account_status;
  shop_state public.shop_status;
  selling boolean;
  expected boolean;
begin
  if exists (select 1 from helper_before b join pg_proc p on p.oid = b.oid
    where b.definition is distinct from pg_get_functiondef(p.oid)
       or b.proowner is distinct from p.proowner or b.proacl is distinct from p.proacl)
    or not exists (select 1 from helper_before b join pg_proc p on p.oid = b.oid) then
    raise exception 'Existing helper changed';
  end if;
  insert into auth.users(id,email) values
    (seller, seller::text || '@example.test'), (buyer, buyer::text || '@example.test');
  insert into public.locations(id,owner_user_id,country_code) values(loc,seller,'US');
  insert into public.shops(id,owner_user_id,display_name,default_location_id)
    values(shop,seller,'Compatibility test',loc);
  foreach account_state in array enum_range(null::public.account_status) loop
    foreach shop_state in array enum_range(null::public.shop_status) loop
      foreach selling in array array[false,true] loop
        update public.profiles set status = account_state, selling_enabled = selling where id = seller;
        update public.shops set status = shop_state where id = shop;
        expected := account_state = 'active' and shop_state = 'active' and selling;
        if private.shop_is_publicly_eligible(shop) is distinct from expected then
          raise exception 'Eligibility mismatch: %, %, %', account_state, shop_state, selling;
        end if;
      end loop;
    end loop;
  end loop;
  if private.shop_is_publicly_eligible(null) or private.shop_is_publicly_eligible(gen_random_uuid()) then
    raise exception 'Missing shop must be ineligible';
  end if;
  update public.profiles set status = 'active', selling_enabled = true where id = seller;
  update public.shops set status = 'active' where id = shop;
  insert into public.listings(id,shop_id,owner_user_id,title,asking_price,currency,category_key,condition,status,published_at)
    values(listing,shop,seller,'Compatibility test',1,'USD','test','good','active',now());
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  -- Remove the test ACL customization: chat definers must work without it.
  revoke execute on function private.shop_is_publicly_eligible(uuid) from authenticated;
  set local role authenticated;
  conversation := public.start_conversation(listing);
  perform public.send_message(conversation,'Compatibility check',gen_random_uuid());
  reset role;
  update public.profiles set selling_enabled = false where id = seller;
  set local role authenticated;
  begin
    perform public.send_message(conversation,'Must fail',gen_random_uuid());
    raise exception 'Ineligible seller accepted a message';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'LISTING_NOT_AVAILABLE_FOR_CHAT' then raise; end if;
  end;
  reset role;
end $$;
rollback;
"""
        result = subprocess.run(
            ['docker', 'exec', '-i', 'supabase_db_bazaar-migration-test',
             'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1'],
            input=statement, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
