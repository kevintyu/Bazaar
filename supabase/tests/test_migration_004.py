"""Migration 004 foundation integration tests, fixed local Docker/API only.
Run: python supabase/tests/test_migration_004.py
Real JWTs exercise RPC/RLS; privileged SQL creates fixtures/asserts integrity.
Audit fixtures are retained. Fault-injection DDL and mutations roll back.
"""
import concurrent.futures
import json
import subprocess
import threading
import time
import unittest
import uuid
import test_migration_002 as baseline

sql, ROOT = baseline.sql, baseline.ROOT


def uid():
    return str(uuid.uuid4())


class TransactionTests(unittest.TestCase):
    request = classmethod(baseline.MigrationTests.request.__func__)
    signup = classmethod(baseline.MigrationTests.signup.__func__)
    activate = classmethod(baseline.MigrationTests.activate.__func__)

    @classmethod
    def setUpClass(cls):
        r = subprocess.run(['npx.cmd', '--yes', 'supabase@3.0.0', 'status', '-o', 'json'],
                           cwd=ROOT, capture_output=True, text=True, check=True)
        cfg = json.loads(r.stdout)
        if cfg['API_URL'] != 'http://127.0.0.1:54321':
            raise RuntimeError('Refusing non-local endpoint')
        cls.key = cfg['ANON_KEY']
        cls.seller, cls.buyer, cls.other, cls.stranger = [cls.signup() for _ in range(4)]
        cls.shop = cls.activate(cls.seller)

    def rpc(self, name, data, user):
        return self.request('POST', '/rest/v1/rpc/' + name, user, data)

    def ok(self, result):
        self.assertEqual(result[0], 200, result)
        return result[1]

    def denied(self, result, code=None):
        self.assertGreaterEqual(result[0], 400, result)
        if code:
            self.assertIn(code, str(result[1]))

    def fixture(self):
        listing = uid()
        seller = self.seller['user']['id']
        sql(f"""insert into public.listings(id,shop_id,owner_user_id,title,asking_price,currency,category_key,condition,status,published_at)
            values('{listing}','{self.shop}','{seller}','Transaction validation',10,'USD','test','good','active',now());""")
        a = self.ok(self.rpc('start_conversation', {'p_listing_id': listing}, self.buyer))
        b = self.ok(self.rpc('start_conversation', {'p_listing_id': listing}, self.other))
        return listing, a, b

    def reserve(self, c, request_id=None, user=None):
        return self.rpc('reserve_listing', {'p_conversation_id': c, 'p_request_id': request_id or uid()}, user or self.seller)

    def cancel(self, t, user=None, reason=None):
        return self.rpc('cancel_transaction', {'p_transaction_id': t, 'p_reason': reason}, user or self.seller)

    def state(self, l):
        return sql(f"select status from public.listings where id='{l}'")

    def parallel(self, calls):
        barrier = threading.Barrier(len(calls))
        def run(call):
            barrier.wait(timeout=10)
            return call()
        with concurrent.futures.ThreadPoolExecutor(len(calls)) as pool:
            return list(pool.map(run, calls))

    def test_01_structure_and_future_operations_gated(self):
        self.assertEqual(sql("""select count(*) from pg_class where oid in
            ('public.transactions'::regclass,'public.transaction_events'::regclass) and relrowsecurity"""), '2')
        for table in ('transactions', 'transaction_events'):
            for role in ('anon', 'authenticated', 'service_role'):
                for permission in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'):
                    self.assertEqual(sql(f"select has_table_privilege('{role}','public.{table}','{permission}')"), 'f')
            self.assertEqual(sql(f"select has_table_privilege('anon','public.{table}','SELECT')"), 'f')
        self.assertEqual(sql("""select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='private' and p.proname in ('reserve_listing_impl','cancel_transaction_impl',
          'guard_transaction_history','record_transaction_event','reject_transaction_event_mutation')
          and p.prosecdef and p.proconfig=array['search_path=""']"""), '5')
        for function in ('mark_picked_up', 'confirm_pickup', 'dispute_pickup', 'finalize_timed_out_transaction'):
            self.assertEqual(sql(f"select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='{function}'"), '0')

    def test_02_reserve_authorization_and_missing_data(self):
        l, a, b = self.fixture()
        for user in (self.buyer, self.other, self.stranger, None):
            self.denied(self.rpc('reserve_listing', {'p_conversation_id': a, 'p_request_id': uid()}, user))
        self.denied(self.reserve(uid()), 'CONVERSATION_NOT_FOUND')
        self.denied(self.rpc('reserve_listing', {'p_conversation_id': None, 'p_request_id': uid()}, self.seller), 'CONVERSATION_NOT_FOUND')
        self.denied(self.rpc('reserve_listing', {'p_conversation_id': a, 'p_request_id': None}, self.seller), 'REQUEST_ID_REQUIRED')
        self.assertEqual(self.state(l), 'active')
        self.assertEqual(sql(f"select count(*) from public.transactions where listing_id='{l}'"), '0')
        with self.assertRaises(subprocess.CalledProcessError) as error:
            sql(f"set role authenticated;select public.reserve_listing('{a}','{uid()}');")
        self.assertIn('UNAUTHENTICATED', error.exception.stderr)

    def test_03_reserve_identity_rls_audit_and_chat(self):
        l, a, b = self.fixture()
        t = self.ok(self.reserve(a))
        self.assertEqual(self.state(l), 'reserved')
        self.assertEqual(sql(f"select conversation_id||':'||buyer_user_id from public.transactions where id='{t}'"), a+':'+self.buyer['user']['id'])
        for user in (self.seller, self.buyer):
            data = self.ok(self.request('GET', f'/rest/v1/transactions?id=eq.{t}', user))
            self.assertEqual(len(data), 1)
            events = self.ok(self.request('GET', f'/rest/v1/transaction_events?transaction_id=eq.{t}', user))
            self.assertEqual([e['to_status'] for e in events], ['reserved'])
        for user in (self.other, self.stranger):
            for table, query in [('transactions', 'id'), ('transaction_events','transaction_id')]:
                self.assertEqual(self.request('GET', f'/rest/v1/{table}?{query}=eq.{t}', user), (200, []))
        self.denied(self.request('GET', '/rest/v1/transactions', None))
        for user, c in [(self.buyer,a),(self.other,b),(self.seller,a)]:
            self.ok(self.rpc('send_message', {'p_conversation_id':c,'p_body':'existing chat','p_client_message_id':uid()}, user))
        self.denied(self.rpc('start_conversation', {'p_listing_id':l}, self.stranger), 'LISTING_NOT_AVAILABLE_FOR_CHAT')
        self.denied(self.rpc('remove_listing', {'p_listing_id':l,'p_reason':'other'}, self.seller), 'INVALID_LISTING_STATE')
        for table in ('transactions','transaction_events'):
            self.denied(self.request('POST',f'/rest/v1/{table}',self.buyer,{'id':uid()}))
            self.denied(self.request('PATCH',f'/rest/v1/{table}?id=eq.{t}',self.seller,{'id':uid()}))
            self.denied(self.request('DELETE',f'/rest/v1/{table}?id=eq.{t}',self.seller))

    def test_04_simultaneous_retries_and_cross_listing_key_conflicts(self):
        l, a, b = self.fixture()
        key = uid()
        results = self.parallel([lambda: self.reserve(a,key) for _ in range(12)])
        ids = [self.ok(r) for r in results]
        self.assertEqual(len(set(ids)),1)
        self.assertEqual(sql(f"select count(*) from public.transactions where listing_id='{l}'"),'1')
        self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{ids[0]}'"),'1')
        self.denied(self.reserve(b,key),'RESERVATION_REQUEST_CONFLICT')
        l1,c1,_ = self.fixture(); l2,c2,_ = self.fixture(); key2=uid()
        results=self.parallel([lambda:self.reserve(c1,key2),lambda:self.reserve(c2,key2)])
        self.assertEqual(sum(r[0]==200 for r in results),1,results)
        self.assertIn('RESERVATION_REQUEST_CONFLICT',str(results))
        self.assertEqual(sorted([self.state(l1),self.state(l2)]),['active','reserved'])

    def test_05_competing_buyers_one_winner(self):
        for _ in range(6):
            l,a,b=self.fixture()
            results=self.parallel([lambda:self.reserve(a),lambda:self.reserve(b)])
            self.assertEqual(sum(r[0]==200 for r in results),1,results)
            self.assertIn('INVALID_LISTING_STATE',str(results))
            self.assertEqual(sql(f"select count(*) from public.transactions where listing_id='{l}' and status='reserved'"),'1')
            self.assertEqual(self.state(l),'reserved')

    def test_06_reserve_eligibility(self):
        for state in ('draft','sold','removed'):
            l,a,b=self.fixture()
            extra=", removed_at=now(),removal_reason='other'" if state=='removed' else ''
            sql(f"update public.listings set status='{state}'{extra} where id='{l}'")
            self.denied(self.reserve(a),'INVALID_LISTING_STATE')
        l,a,b=self.fixture()
        for table,row,field,value,original,code in [
            ('listings',l,'moderation_status','under_review','clear','LISTING_NOT_AVAILABLE_FOR_RESERVATION'),
            ('shops',self.shop,'status','suspended','active','LISTING_NOT_AVAILABLE_FOR_RESERVATION'),
            ('profiles',self.seller['user']['id'],'status','suspended','active','LISTING_NOT_AVAILABLE_FOR_RESERVATION'),
            ('profiles',self.buyer['user']['id'],'status','suspended','active','BUYER_NOT_ACTIVE')]:
            try:
                sql(f"update public.{table} set {field}='{value}' where id='{row}'")
                self.denied(self.reserve(a),code)
            finally:
                sql(f"update public.{table} set {field}='{original}' where id='{row}'")
        self.assertEqual(self.state(l),'active')
        self.assertEqual(sql(f"select count(*) from public.transactions where listing_id='{l}'"),'0')

    def test_07_cancel_both_roles_history_and_durable_retries(self):
        for actor in (self.seller,self.buyer):
            l,a,b=self.fixture(); key=uid(); t=self.ok(self.reserve(a,key))
            reason='Changed plans' if actor is self.buyer else None
            self.assertEqual(self.ok(self.cancel(t,actor,reason)),t)
            self.assertEqual(self.state(l),'active')
            self.assertEqual(sql(f"select status||':'||cancelled_by_user_id from public.transactions where id='{t}'"),'cancelled:'+actor['user']['id'])
            self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{t}'"),'2')
            self.assertEqual(self.ok(self.cancel(t,actor,reason)),t)
            self.denied(self.cancel(t,actor,'different'),'CANCELLATION_REQUEST_CONFLICT')
            self.ok(self.rpc('start_conversation',{'p_listing_id':l},self.stranger))
            new=self.ok(self.reserve(b)); self.assertNotEqual(t,new)
            self.assertEqual(self.ok(self.reserve(a,key)),t)
            self.assertEqual(self.ok(self.cancel(t,actor,reason)),t)
            self.assertEqual(self.state(l),'reserved')
            self.assertEqual(sql(f"select count(*) from public.transactions where listing_id='{l}'"),'2')

    def test_08_cancel_restrictions_roles_reason_and_recovery(self):
        l,a,b=self.fixture();t=self.ok(self.reserve(a))
        for user in (self.other,self.stranger,None):
            self.denied(self.rpc('cancel_transaction',{'p_transaction_id':t},user))
        self.denied(self.cancel(uid()),'TRANSACTION_NOT_FOUND')
        self.denied(self.rpc('cancel_transaction',{'p_transaction_id':None},self.seller),'TRANSACTION_NOT_FOUND')
        self.denied(self.cancel(t,reason='x'*1001),'INVALID_CANCELLATION_REASON')
        for table,row,field in [('profiles',self.seller['user']['id'],'status'),
                               ('profiles',self.buyer['user']['id'],'status'),
                               ('shops',self.shop,'status'),('listings',l,'moderation_status')]:
            value,original=('under_review','clear') if field=='moderation_status' else ('suspended','active')
            try:
                sql(f"update public.{table} set {field}='{value}' where id='{row}'")
                for actor in (self.seller,self.buyer):
                    self.denied(self.cancel(t,actor),'TRANSACTION_RESTRICTED')
                    self.assertEqual(len(self.ok(self.request('GET',f'/rest/v1/transactions?id=eq.{t}',actor))),1)
                self.assertEqual(self.state(l),'reserved')
                self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{t}'"),'1')
            finally:
                sql(f"update public.{table} set {field}='{original}' where id='{row}'")
        self.ok(self.cancel(t,self.buyer,'x'*1000))
        self.assertEqual(self.state(l),'active')

    def test_09_concurrent_cancel_and_re_reserve(self):
        l,a,b=self.fixture();t=self.ok(self.reserve(a))
        results=self.parallel([lambda:self.cancel(t,self.buyer,'same') for _ in range(8)])
        self.assertTrue(all(r==(200,t) for r in results),results)
        self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{t}'"),'2')
        t2=self.ok(self.reserve(a))
        results=self.parallel([lambda:self.cancel(t2,self.seller),lambda:self.cancel(t2,self.buyer)])
        self.assertEqual(sum(r[0]==200 for r in results),1,results)
        self.assertIn('CANCELLATION_REQUEST_CONFLICT',str(results))
        t3=self.ok(self.reserve(a))
        results=self.parallel([lambda:self.cancel(t3,self.buyer),lambda:self.reserve(b)])
        self.assertEqual(results[0],(200,t3))
        if results[1][0]==200:
            self.assertEqual(self.state(l),'reserved')
        else:
            self.denied(results[1],'INVALID_LISTING_STATE')
            self.assertEqual(self.state(l),'active')
            self.ok(self.reserve(b))

    def test_10_reserve_remove_start_send_races(self):
        for _ in range(5):
            l,a,b=self.fixture()
            results=self.parallel([lambda:self.reserve(a),lambda:self.rpc('remove_listing',{'p_listing_id':l,'p_reason':'other'},self.seller)])
            self.assertEqual(sum(r[0]==200 for r in results),1,results)
            self.assertIn('INVALID_LISTING_STATE',str(results))
            self.assertIn(self.state(l),('reserved','removed'))
        l,a,b=self.fixture()
        results=self.parallel([lambda:self.reserve(a),lambda:self.rpc('start_conversation',{'p_listing_id':l},self.stranger),
            lambda:self.rpc('send_message',{'p_conversation_id':b,'p_body':'still chatting','p_client_message_id':uid()},self.other)])
        self.ok(results[0]);self.ok(results[2])
        if results[1][0]!=200:self.denied(results[1],'LISTING_NOT_AVAILABLE_FOR_CHAT')
        self.assertEqual(sql(f"select count(*) from public.conversations where listing_id='{l}' and status='concluded'"),'0')

    def test_11_identity_uniqueness_and_history_guards(self):
        l,a,b=self.fixture();t=self.ok(self.reserve(a))
        wrong_shop=uid()
        statements=[
            (f"update public.transactions set buyer_user_id='{self.other['user']['id']}' where id='{t}'",'TRANSACTION_IDENTITY_IMMUTABLE'),
            (f"delete from public.transactions where id='{t}'",'TRANSACTION_HISTORY_IMMUTABLE'),
            (f"update public.transaction_events set occurred_at=now() where transaction_id='{t}'",'TRANSACTION_EVENT_IMMUTABLE'),
            (f"delete from public.transaction_events where transaction_id='{t}'",'TRANSACTION_EVENT_IMMUTABLE'),
            (f"update public.transactions set status='awaiting_buyer_confirmation' where id='{t}'",'INVALID_TRANSACTION_STATE'),
            (f"insert into public.transactions(listing_id,shop_id,conversation_id,buyer_user_id,seller_user_id,request_id) values('{l}','{self.shop}','{b}','{self.other['user']['id']}','{self.seller['user']['id']}','{uid()}')",'one_active_transaction_per_listing')]
        l2,a2,b2=self.fixture()
        statements += [(f"insert into public.transactions(listing_id,shop_id,conversation_id,buyer_user_id,seller_user_id,request_id) values('{l2}','{self.shop}','{a2}','{self.other['user']['id']}','{self.seller['user']['id']}','{uid()}')",'transactions_conversation_identity_fk'),
            (f"insert into public.transactions(listing_id,shop_id,conversation_id,buyer_user_id,seller_user_id,request_id) values('{l2}','{wrong_shop}','{a2}','{self.buyer['user']['id']}','{self.seller['user']['id']}','{uid()}')",'transactions_listing_identity_fk')]
        for statement,error in statements:
            with self.assertRaises(subprocess.CalledProcessError) as result:sql('begin;'+statement+';rollback;')
            self.assertIn(error,result.exception.stderr)
        self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{t}'"),'1')

    def test_12_injected_failures_roll_back_transaction_listing_and_audit(self):
        for operation in ('reserve','cancel'):
            l,a,b=self.fixture(); t=self.ok(self.reserve(a)) if operation=='cancel' else None
            call=f"public.cancel_transaction('{t}','rollback')" if t else f"public.reserve_listing('{a}','{uid()}')"
            expected_status='reserved' if t else 'active'
            expected_t=1 if t else 0
            # Trigger runs after Transaction/event writes, at the Listing transition.
            result=sql(f"""begin;
              create function pg_temp.inject_failure_004() returns trigger language plpgsql as $fn$
              begin if new.id='{l}' then raise exception 'INJECTED_004_FAILURE'; end if;return new;end;$fn$;
              create trigger test_004_failure before update of status on public.listings
                for each row execute function pg_temp.inject_failure_004();
              do $test$ begin
                perform set_config('request.jwt.claim.sub','{self.seller['user']['id']}',true);
                set local role authenticated;
                begin perform {call}; raise exception 'EXPECTED_FAILURE_NOT_RAISED';
                exception when sqlstate 'P0001' then
                  if sqlerrm <> 'INJECTED_004_FAILURE' then raise;end if;
                end;
                reset role;
                if (select status from public.listings where id='{l}') <> '{expected_status}'
                  or (select count(*) from public.transactions where listing_id='{l}') <> {expected_t}
                  or (select count(*) from public.transaction_events e join public.transactions t on t.id=e.transaction_id where t.listing_id='{l}') <> {expected_t}
                  or exists(select 1 from public.transactions where listing_id='{l}' and status <> 'reserved')
                then raise exception 'PARTIAL_STATE_AFTER_ROLLBACK';end if;
              end;$test$;
              rollback;select 'rollback verified';""")
            self.assertEqual(result,'rollback verified')

    def test_13_audit_transition_null_cannot_bypass_check(self):
        l,a,b=self.fixture();t=self.ok(self.reserve(a))
        with self.assertRaises(subprocess.CalledProcessError) as error:
            sql(f"""begin;insert into public.transaction_events(transaction_id,actor_user_id,from_status,to_status,occurred_at)
              values('{t}','{self.buyer['user']['id']}',null,'cancelled',clock_timestamp());rollback;""")
        self.assertIn('transaction_events_transition',error.exception.stderr)

    def test_14_deterministic_listing_lock_order(self):
        for first in ('reserve','remove','cancel'):
            l,a,b=self.fixture();tag='txn004_'+uuid.uuid4().hex
            t=self.ok(self.reserve(a)) if first=='cancel' else None
            call=(f"public.reserve_listing('{a}','{uid()}')" if first=='reserve' else
                  f"public.remove_listing('{l}','other')" if first=='remove' else
                  f"public.cancel_transaction('{t}',null)")
            statement=f"""begin;set application_name='{tag}';set local role authenticated;
              select set_config('request.jwt.claim.sub','{self.seller['user']['id']}',true);
              select {call};select pg_sleep(3);commit;"""
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                held=pool.submit(sql,statement)
                deadline=time.monotonic()+10
                while sql(f"select count(*) from pg_stat_activity where application_name='{tag}' and wait_event='PgSleep'")!='1':
                    if time.monotonic()>deadline:self.fail('First operation did not hold locks')
                    time.sleep(.05)
                waiting=pool.submit(self.rpc,'remove_listing',{'p_listing_id':l,'p_reason':'other'},self.seller) if first=='reserve' else pool.submit(self.reserve,b)
                deadline=time.monotonic()+2
                while sql(f"""select count(*) from pg_stat_activity w where exists
                    (select 1 from pg_stat_activity h where h.application_name='{tag}'
                    and h.pid=any(pg_blocking_pids(w.pid)))""")=='0':
                    if time.monotonic()>deadline:self.fail('Second operation did not wait on held Listing lock')
                    time.sleep(.05)
                held.result(timeout=10)
                result=waiting.result(timeout=10)
            if first=='cancel':
                self.ok(result);self.assertEqual(self.state(l),'reserved')
                self.assertEqual(sql(f"select count(*) from public.transactions where listing_id='{l}'"),'2')
            else:
                self.denied(result,'INVALID_LISTING_STATE')
                self.assertEqual(self.state(l),'reserved' if first=='reserve' else 'removed')


if __name__ == '__main__':
    unittest.main(verbosity=2)
