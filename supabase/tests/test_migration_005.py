"""Local-only lifecycle integration suite, including all 14 foundation regressions.
Run: python supabase/tests/test_migration_005.py
Real user JWTs exercise public RPCs. Privileged SQL only creates controlled
fixtures, asserts state, configures operator-only settings, or injects faults.
"""
import concurrent.futures
import json
import subprocess
import time
import unittest
import uuid
import test_migration_004 as foundation

sql, uid = foundation.sql, foundation.uid


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


class LifecycleTests(foundation.TransactionTests):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.administrator = cls.signup()
        cls.admin_id = cls.administrator['user']['id']
        sql(f"insert into private.transaction_administrators(user_id) values('{cls.admin_id}')")

    def reserved(self):
        l, a, b = self.fixture()
        return l, self.ok(self.reserve(a)), a, b

    def claim(self, t, user=None):
        return self.rpc('claim_pickup', {'p_transaction_id': t}, user or self.buyer)

    def confirm(self, t, user=None):
        return self.rpc('confirm_pickup_claim', {'p_transaction_id': t}, user or self.seller)

    def resolution_args(self, t, outcome='completed', request=None):
        return {'p_transaction_id': t, 'p_request_id': request or uid(), 'p_outcome': outcome,
                'p_reason': 'Reviewed the pickup evidence and participant records.',
                'p_evidence_references': ['local-test-evidence:' + t],
                'p_review_findings': 'Both participant accounts and the recorded pickup evidence were reviewed.'}

    def resolve(self, args, user=None):
        return self.rpc('resolve_transaction', args, user or self.administrator)

    def tx(self, t):
        return json.loads(sql(f"select row_to_json(t) from public.transactions t where id='{t}'"))

    def test_20_claim_confirm_and_history(self):
        l, t, a, b = self.reserved()
        original = self.ok(self.rpc('send_message', {'p_conversation_id': a,
            'p_body': 'Pickup arrangements', 'p_client_message_id': uid()}, self.buyer))
        self.ok(self.claim(t))
        row = self.tx(t)
        self.assertEqual(row['status'], 'awaiting_buyer_confirmation')
        self.assertIsNotNone(row['pickup_claimed_at'])
        self.assertIsNone(row['completed_at'])
        self.assertEqual(self.state(l), 'reserved')
        self.assertEqual(sql(f"select count(*) from private.transaction_notification_outbox where transaction_id='{t}' and recipient_user_id='{self.seller['user']['id']}' and kind='pickup_claimed'"), '1')
        self.ok(self.confirm(t))
        self.assertEqual(self.state(l), 'sold')
        self.assertEqual(self.tx(t)['completed_by_user_id'], self.seller['user']['id'])
        self.assertEqual(sql(f"select count(*) from public.conversations where listing_id='{l}' and status='concluded'"), '2')
        self.denied(self.rpc('send_message', {'p_conversation_id': a,
            'p_body': 'After sale', 'p_client_message_id': uid()}, self.buyer), 'CONVERSATION_CONCLUDED')
        self.assertEqual(self.ok(self.request('GET', f'/rest/v1/messages?id=eq.{original}', self.buyer))[0]['id'], original)
        self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{t}'"), '3')

    def test_21_participant_auth_and_missing_data(self):
        l, t, a, b = self.reserved()
        for function, wrong in [('claim_pickup', self.seller), ('confirm_pickup_claim', self.buyer)]:
            for user in (wrong, self.other, self.stranger, None):
                self.denied(self.rpc(function, {'p_transaction_id': t}, user))
            for missing in (None, uid()):
                self.denied(self.rpc(function, {'p_transaction_id': missing}, self.buyer if function=='claim_pickup' else self.seller))
            with self.assertRaises(subprocess.CalledProcessError) as e:
                sql(f"set role authenticated;select public.{function}('{t}');")
            self.assertIn('UNAUTHENTICATED', e.exception.stderr)
        self.denied(self.confirm(t), 'BUYER_CLAIM_REQUIRED')
        self.assertEqual(self.tx(t)['status'], 'reserved')
        self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{t}'"), '1')

    def test_22_duplicate_concurrent_claims_and_confirmations(self):
        l, t, _, _ = self.reserved()
        for result in self.parallel([lambda: self.claim(t) for _ in range(8)]):
            self.assertEqual(self.ok(result), t)
        at = self.tx(t)['pickup_claimed_at']
        for result in self.parallel([lambda: self.confirm(t) for _ in range(8)]):
            self.assertEqual(self.ok(result), t)
        self.assertEqual(self.ok(self.claim(t)), t)  # durable claim receipt after completion
        self.assertEqual(self.tx(t)['pickup_claimed_at'], at)
        self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{t}'"), '3')
        self.assertEqual(sql(f"select count(*) from private.transaction_notification_outbox where transaction_id='{t}'"), '1')

    def test_23_restrictions_for_new_actions(self):
        for operation in ('claim', 'confirm', 'admin_complete', 'admin_cancel'):
            l,t,_,_=self.reserved()
            if operation != 'claim': self.ok(self.claim(t))
            args=self.resolution_args(t,'cancelled' if operation=='admin_cancel' else 'completed')
            call={'claim': lambda:self.claim(t),'confirm':lambda:self.confirm(t),
                  'admin_complete':lambda:self.resolve(args),'admin_cancel':lambda:self.resolve(args)}[operation]
            for table,row,field,value,original in [
                ('profiles',self.buyer['user']['id'],'status','suspended','active'),
                ('profiles',self.seller['user']['id'],'status','banned','active'),
                ('shops',self.shop,'status','suspended','active'),
                ('listings',l,'moderation_status','under_review','clear')]:
                before=self.tx(t)
                try:
                    sql(f"update public.{table} set {field}='{value}' where id='{row}'")
                    self.denied(call(),'TRANSACTION_RESTRICTED')
                    self.assertEqual(self.tx(t),before)
                    self.assertEqual(self.state(l),'reserved')
                finally:
                    sql(f"update public.{table} set {field}='{original}' where id='{row}'")
            self.ok(call())

    def test_24_admin_authorization_evidence_and_privacy(self):
        l,t,_,_=self.reserved(); self.ok(self.claim(t)); args=self.resolution_args(t)
        for user in (self.seller,self.buyer,self.stranger,None):
            self.denied(self.resolve(args,user) if user else self.rpc('resolve_transaction',args,None))
        # User-editable metadata is not an administrator authorization source.
        self.ok(self.request('PUT','/auth/v1/user',self.stranger,{'data':{'role':'admin','is_admin':True}}))
        self.denied(self.resolve(args,self.stranger),'ADMINISTRATOR_REQUIRED')
        for field,value,code in [('p_request_id',None,'REQUEST_ID_REQUIRED'),('p_outcome','sold','INVALID_RESOLUTION_OUTCOME'),
             ('p_reason',' \t\n ','RESOLUTION_REASON_REQUIRED'),('p_reason',None,'RESOLUTION_REASON_REQUIRED'),
             ('p_review_findings','reviewed','EVIDENCE_REVIEW_REQUIRED'),
             ('p_evidence_references',[],'EVIDENCE_REVIEW_REQUIRED'),('p_evidence_references',{},'EVIDENCE_REVIEW_REQUIRED'),
             ('p_evidence_references',[None],'EVIDENCE_REVIEW_REQUIRED'),('p_evidence_references',['   '],'EVIDENCE_REVIEW_REQUIRED')]:
            self.denied(self.resolve(dict(args,**{field:value})),code)
        for state in ('revoked','suspended'):
            try:
                if state=='revoked':sql(f"update private.transaction_administrators set enabled=false where user_id='{self.admin_id}'")
                else:sql(f"update public.profiles set status='suspended' where id='{self.admin_id}'")
                self.denied(self.resolve(args),'ADMINISTRATOR_REQUIRED')
            finally:
                sql(f"update private.transaction_administrators set enabled=true where user_id='{self.admin_id}'; update public.profiles set status='active' where id='{self.admin_id}'")
        seller_id=self.seller['user']['id']
        try:
            sql(f"insert into private.transaction_administrators(user_id) values('{seller_id}')")
            self.denied(self.resolve(args,self.seller),'ADMINISTRATOR_CONFLICT_OF_INTEREST')
        finally:sql(f"delete from private.transaction_administrators where user_id='{seller_id}'")
        self.ok(self.resolve(args))
        for user in (self.seller,self.buyer):
            public_rows=self.ok(self.request('GET',f'/rest/v1/transaction_events?transaction_id=eq.{t}',user))
            self.assertNotIn('local-test-evidence',json.dumps(public_rows))
            self.assertNotIn(args['p_review_findings'],json.dumps(public_rows))
        for table in ('transaction_administrators','transaction_resolutions','transaction_notification_policy','transaction_notification_outbox'):
            self.denied(self.request('GET','/rest/v1/'+table,self.administrator,headers={'Accept-Profile':'private'}))
            for role in ('anon','authenticated','service_role'):
                for privilege in ('SELECT','INSERT','UPDATE','DELETE'):
                    self.assertEqual(sql(f"select has_table_privilege('{role}','private.{table}','{privilege}')"),'f')

    def test_25_admin_completion_cancel_and_durable_retries(self):
        for outcome in ('completed','cancelled'):
            l,t,_,b=self.reserved(); self.ok(self.claim(t)); args=self.resolution_args(t,outcome)
            for r in self.parallel([lambda:self.resolve(args) for _ in range(8)]):self.assertEqual(self.ok(r),t)
            self.assertEqual(self.state(l),'sold' if outcome=='completed' else 'active')
            self.assertEqual(self.tx(t)['status'],outcome)
            self.assertIsNotNone(self.tx(t)['pickup_claimed_at'])
            record=json.loads(sql(f"select row_to_json(r) from private.transaction_resolutions r where transaction_id='{t}'"))
            self.assertEqual(record['administrator_id'],self.admin_id)
            self.assertEqual(record['evidence_references'],args['p_evidence_references'])
            self.assertEqual(record['review_findings'],args['p_review_findings'])
            self.denied(self.resolve(dict(args,p_reason='Changed resolution reason')),'RESOLUTION_REQUEST_CONFLICT')
            with self.assertRaises(subprocess.CalledProcessError):
                sql(f"begin;update private.transaction_resolutions set reason='Changed evidence record' where transaction_id='{t}';rollback;")
            if outcome=='cancelled':
                self.ok(self.reserve(b))
                self.assertEqual(self.ok(self.resolve(args)),t)
                self.assertEqual(self.state(l),'reserved')
        l,t,_,_=self.reserved()
        self.denied(self.resolve(self.resolution_args(t)),'BUYER_CLAIM_REQUIRED')
        self.ok(self.resolve(self.resolution_args(t,'cancelled')))
        self.assertEqual(self.state(l),'active')

    def test_26_no_deadline_followups_disabled_configurable_idempotent(self):
        l,t,_,_=self.reserved();self.ok(self.claim(t))
        self.assertEqual(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='transactions' and column_name like '%deadline%'"),'0')
        self.assertEqual(sql(f"begin;select private.enqueue_transaction_followups(clock_timestamp()+interval '10 years');rollback;"),'0')
        self.assertEqual(self.tx(t)['status'],'awaiting_buyer_confirmation')
        self.assertEqual(self.state(l),'reserved')
        # Configure TEST-ONLY timing, then roll back policy and notification intents.
        result=sql(f"""begin;
          update private.transaction_notification_policy set reminder_interval=interval '1 hour',escalation_after=interval '2 hours';
          select private.enqueue_transaction_followups(clock_timestamp()+interval '1 day');
          select private.enqueue_transaction_followups(clock_timestamp()+interval '1 day');
          do $$ begin
            if (select count(*) from private.transaction_notification_outbox where transaction_id='{t}' and kind='confirmation_reminder')<>1
              or (select count(*) from private.transaction_notification_outbox where transaction_id='{t}' and kind='administrator_escalation')<>1
              or (select status from public.transactions where id='{t}')<>'awaiting_buyer_confirmation'
              then raise exception 'INVALID_FOLLOWUP_STATE';end if;
          end $$;rollback;""")
        self.assertEqual(result.splitlines()[-1],'0')
        self.assertEqual(sql(f"select count(*) from private.transaction_notification_outbox where transaction_id='{t}'"),'1')
        for role in ('anon','authenticated','service_role'):
            self.assertEqual(sql(f"select has_function_privilege('{role}','private.enqueue_transaction_followups(timestamptz)','execute')"),'f')

    def test_27_claim_cancel_confirm_admin_races(self):
        for _ in range(4):
            l,t,_,_=self.reserved()
            results=self.parallel([lambda:self.claim(t),lambda:self.cancel(t)])
            self.assertEqual(sum(r[0]==200 for r in results),1,results)
            row=self.tx(t)
            self.assertIn(row['status'],('cancelled','awaiting_buyer_confirmation'))
            self.assertEqual(self.state(l),'active' if row['status']=='cancelled' else 'reserved')
            self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{t}'"),'2')
        for _ in range(4):
            l,t,_,_=self.reserved();self.ok(self.claim(t));args=self.resolution_args(t,'cancelled')
            results=self.parallel([lambda:self.confirm(t),lambda:self.resolve(args)])
            self.assertEqual(sum(r[0]==200 for r in results),1,results)
            state=self.tx(t)['status'];self.assertIn(state,('completed','cancelled'))
            self.assertEqual(self.state(l),'sold' if state=='completed' else 'active')
            self.assertEqual(sql(f"select count(*) from public.transaction_events where transaction_id='{t}'"),'3')
        l,t,_,_=self.reserved();self.ok(self.claim(t))
        complete=self.resolution_args(t);cancel=self.resolution_args(t,'cancelled')
        results=self.parallel([lambda:self.resolve(complete),lambda:self.resolve(cancel)])
        self.assertEqual(sum(r[0]==200 for r in results),1,results)

    def test_28_atomic_rollback_claim_and_completion(self):
        for op in ('claim','confirm','admin'):
            l,t,_,_=self.reserved()
            if op!='claim':self.ok(self.claim(t))
            before=self.tx(t); before_events=sql(f"select count(*) from public.transaction_events where transaction_id='{t}'")
            if op=='claim':
                table='private.transaction_notification_outbox';timing='before insert';condition=f"new.transaction_id='{t}'"
                call=f"public.claim_pickup('{t}')";actor=self.buyer['user']['id']
            else:
                table='public.listings';timing='before update of status';condition=f"new.id='{l}'"
                if op=='confirm':call=f"public.confirm_pickup_claim('{t}')";actor=self.seller['user']['id']
                else:
                    args=self.resolution_args(t)
                    call=f"public.resolve_transaction('{t}','{args['p_request_id']}','completed',{literal(args['p_reason'])},{literal(json.dumps(args['p_evidence_references']))}::jsonb,{literal(args['p_review_findings'])})"
                    actor=self.admin_id
            sql(f"""begin;
              create function pg_temp.inject_005() returns trigger language plpgsql as $fn$
              begin if {condition} then raise exception 'INJECTED_005_FAILURE';end if;return new;end;$fn$;
              create trigger test_005_fault {timing} on {table} for each row execute function pg_temp.inject_005();
              do $test$ begin
                perform set_config('request.jwt.claim.sub','{actor}',true);set local role authenticated;
                begin perform {call};raise exception 'FAILURE_NOT_RAISED';
                exception when sqlstate 'P0001' then if sqlerrm<>'INJECTED_005_FAILURE' then raise;end if;end;
                reset role;
                if (select count(*) from public.transaction_events where transaction_id='{t}')<>{before_events}
                  or exists(select 1 from private.transaction_resolutions where transaction_id='{t}')
                  or (select status from public.listings where id='{l}')<>'reserved'
                  then raise exception 'PARTIAL_COMMIT';end if;
              end;$test$;rollback;""")
            self.assertEqual(self.tx(t),before)

    def test_29_disputed_resolution_preserves_claim(self):
        # No dispute-entry API is introduced. Simulate a future trusted disputed
        # record only inside a rollback transaction, then exercise real admin JWT role.
        for outcome in ('completed','cancelled'):
            l,t,_,_=self.reserved();self.ok(self.claim(t));args=self.resolution_args(t,outcome)
            sql(f"""begin;
              alter table public.transactions disable trigger transactions_guard_history;
              alter table public.transactions disable trigger transactions_record_event;
              update public.transactions set status='disputed' where id='{t}';
              alter table public.transactions enable trigger transactions_guard_history;
              alter table public.transactions enable trigger transactions_record_event;
              set local role authenticated;
              select set_config('request.jwt.claim.sub','{self.admin_id}',true);
              select public.resolve_transaction('{t}','{args['p_request_id']}','{outcome}',
                {literal(args['p_reason'])},{literal(json.dumps(args['p_evidence_references']))}::jsonb,{literal(args['p_review_findings'])});
              reset role;
              do $$ begin
                if not exists(select 1 from public.transactions where id='{t}' and status='{outcome}' and pickup_claimed_at is not null)
                  or not exists(select 1 from public.transaction_events where transaction_id='{t}' and from_status='disputed' and to_status='{outcome}')
                  then raise exception 'DISPUTE_RESOLUTION_FAILED';end if;
              end $$;rollback;""")
            self.assertEqual(self.tx(t)['status'],'awaiting_buyer_confirmation')

    def test_30_administrator_key_reuse_across_transactions(self):
        l1,t1,_,_=self.reserved();l2,t2,_,_=self.reserved()
        self.ok(self.claim(t1));self.ok(self.claim(t2));key=uid()
        a=self.resolution_args(t1,request=key);b=self.resolution_args(t2,request=key)
        results=self.parallel([lambda:self.resolve(a),lambda:self.resolve(b)])
        self.assertEqual(sum(r[0]==200 for r in results),1,results)
        self.assertIn('RESOLUTION_REQUEST_CONFLICT',str(results))
        self.assertEqual(sorted([self.state(l1),self.state(l2)]),['reserved','sold'])
        self.assertEqual(sql(f"select count(*) from private.transaction_resolutions where administrator_id='{self.admin_id}' and request_id='{key}'"),'1')

    def test_31_deterministic_lifecycle_lock_order(self):
        for first in ('claim','confirm','admin_cancel'):
            l,t,_,_=self.reserved();tag='lifecycle005_'+uuid.uuid4().hex
            if first!='claim':self.ok(self.claim(t))
            if first=='claim':
                call=f"public.claim_pickup('{t}')";actor=self.buyer['user']['id']
                second=lambda:self.cancel(t)
            elif first=='confirm':
                call=f"public.confirm_pickup_claim('{t}')";actor=self.seller['user']['id']
                args=self.resolution_args(t,'cancelled');second=lambda:self.resolve(args)
            else:
                args=self.resolution_args(t,'cancelled');actor=self.admin_id
                call=f"public.resolve_transaction('{t}','{args['p_request_id']}','cancelled',{literal(args['p_reason'])},{literal(json.dumps(args['p_evidence_references']))}::jsonb,{literal(args['p_review_findings'])})"
                second=lambda:self.confirm(t)
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                held=pool.submit(sql,f"begin;set application_name='{tag}';set local role authenticated;select set_config('request.jwt.claim.sub','{actor}',true);select {call};select pg_sleep(3);commit;")
                deadline=time.monotonic()+10
                while sql(f"select count(*) from pg_stat_activity where application_name='{tag}' and wait_event='PgSleep'")!='1':
                    if time.monotonic()>deadline:self.fail('First lifecycle action did not hold locks')
                    time.sleep(.05)
                waiting=pool.submit(second);deadline=time.monotonic()+2
                while sql(f"select count(*) from pg_stat_activity w where exists(select 1 from pg_stat_activity h where h.application_name='{tag}' and h.pid=any(pg_blocking_pids(w.pid)))")=='0':
                    if time.monotonic()>deadline:self.fail('Second lifecycle action did not wait on the Listing lock')
                    time.sleep(.05)
                held.result(timeout=10);self.denied(waiting.result(timeout=10))
            self.assertEqual(self.state(l),{'claim':'reserved','confirm':'sold','admin_cancel':'active'}[first])

    def test_32_function_grants_and_new_column_protection(self):
        for fn in ('claim_pickup(uuid)','confirm_pickup_claim(uuid)','resolve_transaction(uuid,uuid,text,text,jsonb,text)'):
            for role in ('anon','service_role'):
                self.assertEqual(sql(f"select has_function_privilege('{role}','public.{fn}','execute')"),'f')
            self.assertEqual(sql(f"select has_function_privilege('authenticated','public.{fn}','execute')"),'t')
        self.assertEqual(sql("""select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='private' and p.proname in ('claim_pickup_impl','confirm_pickup_claim_impl',
          'resolve_transaction_impl','require_transaction_administrator','require_transaction_eligible',
          'enqueue_transaction_followups') and p.prosecdef and p.proconfig=array['search_path=""']"""),'6')
        l,t,_,_=self.reserved()
        for user in (self.buyer,self.seller,self.administrator):
            self.denied(self.request('PATCH',f'/rest/v1/transactions?id=eq.{t}',user,
                {'pickup_claimed_at':'2026-11-24T00:00:00Z','status':'completed'}))
        self.ok(self.claim(t))
        for user in (self.other,self.stranger,self.administrator):
            self.assertEqual(self.ok(self.request('GET',f'/rest/v1/transactions?id=eq.{t}',user)),[])
            self.assertEqual(self.ok(self.request('GET',f'/rest/v1/transaction_events?transaction_id=eq.{t}',user)),[])


if __name__ == '__main__':
    unittest.main(verbosity=2)
