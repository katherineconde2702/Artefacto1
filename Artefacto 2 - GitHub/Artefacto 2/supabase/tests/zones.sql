-- PREPARED ONLY: not executed by the JavaScript suite.
-- Run against an isolated Supabase PostgreSQL database after both migrations:
-- psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/zones.sql
-- Apply the additive migration twice first to check its repeatability. This
-- transaction rolls back every fixture and does not modify existing tariffs.
begin;
do $$
declare
 m text:='sql-zones-'||gen_random_uuid()::text; actor uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid();
 d date:=(clock_timestamp() at time zone 'America/Montevideo')::date+1;
 c text:=gen_random_uuid()::text; q text:=gen_random_uuid()::text;
 stale_c text:=gen_random_uuid()::text; stale_q text:=gen_random_uuid()::text;
 payload jsonb; invalid jsonb; result jsonb; accepted jsonb; external_payload jsonb; external_accepted jsonb;
 state jsonb; history jsonb; latest jsonb; route_id text; route_version integer;
 before_audits bigint; before_version integer; latest_version integer;
begin
 if not (select relrowsecurity from pg_class where oid='shipping.zone_rates'::regclass) then raise exception 'zone rates lack RLS'; end if;
 if has_table_privilege('anon','shipping.zone_rates','SELECT') or has_table_privilege('authenticated','shipping.zone_rates','SELECT') or
    has_table_privilege('service_role','shipping.zone_rates','INSERT') then raise exception 'private tariffs have direct role access'; end if;
 if has_function_privilege('anon','public.shipping_snapshot(text,text)','EXECUTE') or
    has_function_privilege('authenticated','public.shipping_mutate(text,jsonb)','EXECUTE') or
    has_function_privilege('service_role','public.shipping_mutate_v1(text,jsonb)','EXECUTE') or
    has_function_privilege('service_role','public.shipping_snapshot_v1(text,text)','EXECUTE') then raise exception 'RPC wrapper can be bypassed'; end if;
 if not has_function_privilege('service_role','public.shipping_snapshot(text,text)','EXECUTE') or
    not has_function_privilege('service_role','public.shipping_mutate(text,jsonb)','EXECUTE') then raise exception 'service RPC access missing'; end if;
 if exists(select 1 from pg_proc where oid in ('public.shipping_snapshot(text,text)'::regprocedure,'public.shipping_mutate(text,jsonb)'::regprocedure) and
           (not prosecdef or not coalesce(proconfig @> array['search_path=""'],false))) then raise exception 'RPC security context changed'; end if;

 -- The merchant trigger must populate a clean installation even when the old
 -- seed runs after migrations. No demo amounts may become enabled live rates.
 insert into shipping.merchants(id,name) values(m,'Zone repository fixture');
 insert into auth.users(id) values(actor),(stranger);
 insert into shipping.admin_members(merchant_id,user_id,role) values(m,actor,'admin');
 insert into shipping.rate_policies(merchant_id,mode,version,data) values(m,'demo',1,
  '{"minimumMinor":14900,"fuelPriceMinorPerLiter":9045,"fuelLitersPer100Km":3,"laborMinorPerHour":25000,"serviceMinutes":5,"marginBps":1500,"roundingMinor":100,"quoteMinutes":5,"holdMinutes":15}');
 insert into shipping.service_days(merchant_id,mode,delivery_date) values(m,'demo',d);
 state:=public.shipping_snapshot(m,'demo');
 if jsonb_array_length(state->'areas')<>80 or jsonb_array_length(state->'zoneRates')<>0 then raise exception 'canonical catalog or empty tariff contract broken'; end if;
 if not exists(select 1 from jsonb_array_elements(state->'areas') area where area->>'id'='centro' and area->>'departmentId'='montevideo' and area->>'kind'='neighborhood') or
    not exists(select 1 from jsonb_array_elements(state->'areas') area where area->>'id'='dept-canelones' and area->>'departmentId'='canelones' and area->>'kind'='department' and area->>'city'='Canelones') then raise exception 'catalog incorrectly labels interior Montevideo'; end if;
 if exists(select 1 from shipping.zone_rates where merchant_id=m) or jsonb_array_length(public.shipping_snapshot(m,'live')->'zoneRates')<>0 then raise exception 'migration installed live sample rates'; end if;
 perform shipping.sync_zone_catalog(m);
 if (select count(*) from shipping.neighborhoods where merchant_id=m)<>80 then raise exception 'catalog resync duplicates areas'; end if;

 payload:=jsonb_build_object('merchantId',m,'mode','demo','actorId',actor,'areaId','centro','priceMinor',24900,'enabled',true);
 begin perform public.shipping_mutate('zone_rate_save',(payload-'actorId')||'{"serverAuthorized":true}'); raise exception 'missing administrator accepted'; exception when sqlstate 'PT403' then null; end;
 begin perform public.shipping_mutate('zone_rate_save',payload||jsonb_build_object('actorId',stranger)); raise exception 'nonmember administrator accepted'; exception when sqlstate 'PT403' then null; end;
 begin perform public.shipping_mutate('zone_rate_save',payload||'{"actorId":"demo-admin"}'); raise exception 'unverified demo actor accepted'; exception when sqlstate 'PT403' then null; end;
 begin perform public.shipping_mutate('zone_rate_save',payload||'{"merchantId":"other-merchant"}'); raise exception 'cross merchant edit accepted'; exception when sqlstate 'PT404' then null; end;
 select count(*) into before_audits from shipping.audit_events where merchant_id=m;
 select max(version) into before_version from shipping.rate_policies where merchant_id=m and mode='demo';
 for invalid in select value from jsonb_array_elements('[{"areaId":"invented"},{"areaId":null},{"priceMinor":0},{"priceMinor":-1},{"priceMinor":14900.5},{"priceMinor":"24900"},{"priceMinor":1000000001},{"priceMinor":14899},{"enabled":null},{"enabled":"true"}]'::jsonb) loop
   begin perform public.shipping_mutate('zone_rate_save',payload||invalid); raise exception 'invalid rate accepted: %',invalid; exception when sqlstate 'PT400' then if sqlerrm<>'zone_rate_invalid' then raise; end if; end;
 end loop;
 if (select count(*) from shipping.audit_events where merchant_id=m)<>before_audits or
    (select max(version) from shipping.rate_policies where merchant_id=m and mode='demo')<>before_version or
    exists(select 1 from shipping.zone_rates where merchant_id=m) then raise exception 'invalid tariff left partial changes'; end if;
 -- Direct table writes also enforce the current minimum. Public roles cannot
 -- use this path; this checks the private relation's last line of validation.
 begin insert into shipping.zone_rates(merchant_id,mode,area_id,price_minor,enabled) values(m,'demo','centro',14899,true); raise exception 'direct tariff below minimum accepted'; exception when sqlstate 'PT400' then null; end;

 perform public.shipping_mutate('checkout_create',jsonb_build_object('merchantId',m,'mode','demo','id',stale_c,'cart','[{}]'::jsonb,'subtotalMinor',1,'currency','UYU','expiresAt',clock_timestamp()+interval '1 hour'));
 perform public.shipping_mutate('quote_create',jsonb_build_object('merchantId',m,'mode','demo','id',stale_q,'checkoutId',stale_c,'routeId',null,'routeVersion',0,'dayVersion',1,'policyVersion',1,'deliveryDate',d,'priceMinor',24900,'currency','UYU','expiresAt',clock_timestamp()+interval '5 minutes','address','{"provider":"zones","areaId":"centro","placeId":"zone:centro"}'::jsonb));
 result:=public.shipping_mutate('zone_rate_save',payload||'{"inputAddress":"Private doorstep","address":{"name":"Private buyer"},"version":100}');
 if result<>'{"areaId":"centro","priceMinor":24900,"enabled":true,"version":1}'::jsonb then raise exception 'tariff result accepts arbitrary payload'; end if;
 result:=public.shipping_mutate('zone_rate_save',payload||'{"priceMinor":1000000000,"enabled":false}');
 if (result->>'version')::integer<>2 or (select max(version) from shipping.rate_policies where merchant_id=m and mode='demo')<>3 then raise exception 'tariff/policy version not advanced'; end if;
 begin perform public.shipping_mutate('reserve',jsonb_build_object('merchantId',m,'mode','demo','checkoutId',stale_c,'quoteId',stale_q,'expectedVersion',0,'idempotencyKey','stale','bodyHash','stale')); raise exception 'old tariff quote reserved'; exception when sqlstate 'PT409' then if sqlerrm<>'policy_changed' then raise; end if; end;
 if exists(select 1 from shipping.routes where merchant_id=m) or exists(select 1 from shipping.shipments where merchant_id=m) then raise exception 'stale tariff created a partial route'; end if;

 perform public.shipping_mutate('zone_rate_save',payload);
 perform public.shipping_mutate('checkout_create',jsonb_build_object('merchantId',m,'mode','demo','id',c,'cart','[{}]'::jsonb,'subtotalMinor',1,'currency','UYU','expiresAt',clock_timestamp()+interval '1 hour'));
 perform public.shipping_mutate('quote_create',jsonb_build_object('merchantId',m,'mode','demo','id',q,'checkoutId',c,'routeId',null,'routeVersion',0,'dayVersion',1,'policyVersion',4,'deliveryDate',d,'priceMinor',24900,'normalPriceMinor',24900,'currency','UYU','expiresAt',clock_timestamp()+interval '5 minutes','address','{"provider":"zones","areaId":"centro","placeId":"zone:centro","inputAddress":"Centro, Montevideo, Uruguay"}'::jsonb,'candidateRoute',jsonb_build_object('deliveryDate',d,'stops','[{"shipmentId":null,"placeId":"zone:centro"}]'::jsonb)));
 payload:=jsonb_build_object('merchantId',m,'mode','demo','checkoutId',c,'quoteId',q,'expectedVersion',0,'idempotencyKey','accepted','bodyHash','accepted');
 accepted:=public.shipping_mutate('reserve',payload);
 perform public.shipping_mutate('settings_save',jsonb_build_object('merchantId',m,'mode','demo','actorId',actor,'policy','{"minimumMinor":49900}'::jsonb));
 begin perform public.shipping_mutate('zone_rate_save',jsonb_build_object('merchantId',m,'mode','demo','actorId',actor,'areaId','centro','priceMinor',24900,'enabled',false)); raise exception 'disabled tariff bypassed current minimum'; exception when sqlstate 'PT400' then null; end;
 perform public.shipping_mutate('zone_rate_save',jsonb_build_object('merchantId',m,'mode','demo','actorId',actor,'areaId','centro','priceMinor',69900,'enabled',true));
 if public.shipping_mutate('reserve',payload)<>accepted then raise exception 'tariff edit changed accepted replay'; end if;
 begin perform public.shipping_mutate('reserve',payload||'{"bodyHash":"different"}'); raise exception 'accepted key reused'; exception when sqlstate 'PT409' then if sqlerrm<>'idempotency_conflict' then raise; end if; end;
 result:=public.shipping_mutate('demo_confirm',jsonb_build_object('merchantId',m,'mode','demo','shipmentId',accepted->>'id','checkoutId',c));
 if result->>'status'<>'confirmed' or (result->>'priceMinor')::bigint<>24900 then raise exception 'accepted price changed after settings'; end if;
 select id,version into route_id,route_version from shipping.routes where merchant_id=m and mode='demo' and delivery_date=d;
 external_payload:=jsonb_build_object('merchantId',m,'mode','demo','actorId',actor,'routeId',route_id,'expectedVersion',route_version,'expectedDayVersion',1,'expectedPolicyVersion',6,'idempotencyKey','external','bodyHash','external','candidateRoute',jsonb_build_object('deliveryDate',d),'shipment','{"externalOrderRef":"zone-order","priceMinor":69900,"address":{"provider":"zones","areaId":"centro","placeId":"zone:centro"}}'::jsonb);
 external_accepted:=public.shipping_mutate('external_create',external_payload);
 perform public.shipping_mutate('zone_rate_save',jsonb_build_object('merchantId',m,'mode','demo','actorId',actor,'areaId','centro','priceMinor',69900,'enabled',false));
 if public.shipping_mutate('external_create',external_payload)<>external_accepted or public.shipping_mutate('external_replay',external_payload)<>external_accepted then raise exception 'external replay changed after tariff disable'; end if;

 state:=public.shipping_snapshot(m,'demo'); history:=state->'auditEvents';
 select value into latest from jsonb_array_elements(history) where value->>'operation'='zone_rate_save' order by (value->>'createdAt')::timestamptz desc limit 1;
 if latest->>'entityType'<>'zone_rate' or latest->>'entityId'<>'centro' or latest->>'actor'<>actor::text or
    latest->'changes'<>'{"before":{"priceMinor":69900,"enabled":true},"after":{"priceMinor":69900,"enabled":false}}'::jsonb then raise exception 'tariff audit has missing or excessive fields'; end if;
 if history::text like '%Private%' or exists(select 1 from shipping.audit_events where merchant_id=m and operation='zone_rate_save' and (data->'before' ? 'areaId' or data->'after' ? 'version')) then raise exception 'tariff audit retains request or private data'; end if;
 if jsonb_array_length(public.shipping_snapshot(m,'live')->'zoneRates')<>0 then raise exception 'demo tariff leaked live'; end if;
end $$;
set local role anon;
do $$ begin
 begin perform public.shipping_snapshot('marea','live'); raise exception 'anon snapshot allowed'; exception when insufficient_privilege then null; end;
 begin perform public.shipping_mutate('zone_rate_save','{}'); raise exception 'anon mutation allowed'; exception when insufficient_privilege then null; end;
 begin perform count(*) from shipping.zone_rates; raise exception 'anon tariffs allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;

-- Pending two-session protocol (not a concurrency claim): for the same
-- merchant/mode, BEGIN A; change a tariff; keep the transaction open. B must
-- block on reserve, settings_save, external_create or another tariff save.
-- COMMIT A: stale quotes/external plans fail policy_changed; accepted replay
-- still returns its saved response. ROLLBACK A: no rate/policy/audit change.
-- Reverse A/B (reserve first) and verify tariff edit waits until the accepted
-- price is committed. Repeat settings minimum edit vs a tariff below that new
-- minimum; the tariff must validate against the policy after obtaining lock.
