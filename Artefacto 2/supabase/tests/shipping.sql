-- Run against an isolated Supabase PostgreSQL database, after migration + seed:
-- psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/shipping.sql
-- No production data survives this transaction. This is not a concurrency claim:
-- use two independent sessions for the last-seat race described at the bottom.
begin;
do $$
declare m text:='sql-test-'||gen_random_uuid()::text; c text := gen_random_uuid()::text; q text := gen_random_uuid()::text;
  q2 text := gen_random_uuid()::text; r jsonb; replay jsonb; before_count bigint;
  admin_id uuid:=gen_random_uuid();
  day date := (now() at time zone 'America/Montevideo')::date + 1;
  payload jsonb;
begin
  if has_function_privilege('anon', 'public.shipping_snapshot(text,text)', 'EXECUTE') or
     has_function_privilege('authenticated', 'public.shipping_mutate(text,jsonb)', 'EXECUTE') then
    raise exception 'internal RPC is exposed';
  end if;
  if exists(select 1 from pg_class t join pg_namespace n on n.oid=t.relnamespace
      where n.nspname='shipping' and t.relkind='r' and not t.relrowsecurity) then
    raise exception 'shipping table without RLS';
  end if;
  insert into shipping.merchants(id,name) values(m,'Isolated SQL fixture');
  insert into shipping.rate_policies(merchant_id,mode,version,data) select m,'demo',1,data from shipping.rate_policies where merchant_id='marea' and mode='demo' order by version desc limit 1;
  insert into shipping.service_days(merchant_id,mode,delivery_date,capacity) values(m,'demo',day,1)
    on conflict(merchant_id,mode,delivery_date) do update set capacity=1,enabled=true;
  perform public.shipping_mutate('checkout_create',jsonb_build_object('merchantId',m,'mode','demo','id',c,'cart',jsonb_build_array(jsonb_build_object('productId','sweater','quantity',1)),'subtotalMinor',279000,'currency','UYU','expiresAt',now()+interval '1 hour'));
  perform public.shipping_mutate('quote_create',jsonb_build_object('merchantId',m,'mode','demo','id',q,'checkoutId',c,'routeId',null,'routeVersion',0,'deliveryDate',day,'priceMinor',14900,'normalPriceMinor',15900,'safetyFloorMinor',14900,'currency','UYU','expiresAt',now()+interval '5 minutes','address',jsonb_build_object('placeId','demo-test','confirmed',true),'candidateRoute',jsonb_build_object('departureAt',day::text||'T13:00:00Z','stops','[]'::jsonb)));
  payload := jsonb_build_object('merchantId',m,'mode','demo','checkoutId',c,'quoteId',q,'expectedVersion',0,'idempotencyKey','sql-replay','bodyHash','body-a');
  r := public.shipping_mutate('reserve',payload);
  replay := public.shipping_mutate('reserve',payload);
  if r <> replay or r->>'status'<>'held' then raise exception 'replay changed response'; end if;
  begin
    perform public.shipping_mutate('reserve',payload||'{"bodyHash":"body-b"}');
    raise exception 'different body unexpectedly accepted';
  exception when sqlstate 'PT409' then null; end;
  select count(*) into before_count from shipping.shipments;
  begin
    perform public.shipping_mutate('settings_save','{"merchantId":"marea","mode":"demo","actorId":"demo-admin","policy":{}}');
    raise exception 'demo actor accepted by SQL';
  exception when sqlstate 'PT403' then null; end;
  if (select count(*) from shipping.shipments)<>before_count then raise exception 'rollback lost shipment'; end if;
  insert into auth.users(id) values(admin_id);
  insert into shipping.admin_members(merchant_id,user_id,role) values(m,admin_id,'admin');
  perform public.shipping_mutate('settings_save',jsonb_build_object('merchantId',m,'mode','demo','actorId',admin_id,'policy','{"minimumMinor":99900}'::jsonb));
  if public.shipping_admin_context(admin_id,'other') is not null then raise exception 'cross merchant admin accepted'; end if;
  if jsonb_array_length(public.shipping_snapshot(m,'live')->'shipments')<>0 then raise exception 'demo leaked into live'; end if;
  r := public.shipping_mutate('demo_confirm',jsonb_build_object('merchantId',m,'mode','demo','shipmentId',r->>'id','checkoutId',c));
  if r->>'status'<>'confirmed' or (r->>'priceMinor')::int<>14900 then raise exception 'confirmation changed price'; end if;
  -- Last seat after the accepted hold/confirmation must fail without partial writes.
  c := gen_random_uuid()::text;
  perform public.shipping_mutate('checkout_create',jsonb_build_object('merchantId',m,'mode','demo','id',c,'cart','[{"productId":"sweater","quantity":1}]'::jsonb,'subtotalMinor',279000,'currency','UYU','expiresAt',now()+interval '1 hour'));
  perform public.shipping_mutate('quote_create',jsonb_build_object('merchantId',m,'mode','demo','id',q2,'checkoutId',c,'routeId',r->>'routeId','routeVersion',2,'deliveryDate',day,'priceMinor',14900,'currency','UYU','expiresAt',now()+interval '5 minutes','address','{"placeId":"demo-test","confirmed":true}'::jsonb));
  begin
    perform public.shipping_mutate('reserve',jsonb_build_object('merchantId',m,'mode','demo','checkoutId',c,'quoteId',q2,'expectedVersion',2,'idempotencyKey','last-seat','bodyHash','last-seat'));
    raise exception 'overbooked final seat';
  exception when sqlstate 'PT409' then null; end;
  if (select count(*) from shipping.shipments)<>before_count then raise exception 'failed reservation partially wrote'; end if;
  update shipping.shipments set status='held',held_until=now()-interval '1 second' where merchant_id=m and mode='demo' and id=r->>'id';
  begin
    perform public.shipping_mutate('demo_confirm',jsonb_build_object('merchantId',m,'mode','demo','shipmentId',r->>'id','checkoutId',r->>'checkoutId'));
    raise exception 'expired hold resurrected';
  exception when sqlstate 'PT410' then null; end;
  perform public.shipping_snapshot(m,'demo');
  if (select status from shipping.shipments where merchant_id=m and mode='demo' and id=r->>'id')<>'expired' or exists(select 1 from shipping.route_stops where merchant_id=m and mode='demo') then raise exception 'expiry failed to release capacity'; end if;
end $$;
-- Review regressions run in a second fresh merchant, including on a used seed.
do $$
declare m text:='sql-review-'||gen_random_uuid()::text; actor uuid:=gen_random_uuid();
 c text; q text; route_id text; plan jsonb; external_payload jsonb; accepted jsonb;
 d date; n integer; before_count bigint; departure timestamptz;
begin
 insert into shipping.merchants(id,name) values(m,'Review fixture');
 insert into shipping.rate_policies(merchant_id,mode,version,data) select m,'demo',1,data from shipping.rate_policies where merchant_id='marea' and mode='demo' order by version desc limit 1;
 insert into auth.users(id) values(actor);
 insert into shipping.admin_members(merchant_id,user_id,role) values(m,actor,'admin');
 for n in 1..2 loop
   d:=(clock_timestamp() at time zone 'America/Montevideo')::date+n;
   route_id:=null; c:=gen_random_uuid()::text; q:=gen_random_uuid()::text;
   insert into shipping.service_days(merchant_id,mode,delivery_date) values(m,'demo',d);
   if n=1 then insert into shipping.routes(merchant_id,mode,delivery_date,departure_at,capacity,max_duration_seconds) values(m,'demo',d,(d+time '10:00') at time zone 'America/Montevideo',10,14400) returning id into route_id; end if;
   perform public.shipping_mutate('checkout_create',jsonb_build_object('merchantId',m,'mode','demo','id',c,'cart','[{}]'::jsonb,'subtotalMinor',1,'currency','UYU','expiresAt',clock_timestamp()+interval '1 hour'));
   plan:=jsonb_build_object('merchantId',m,'mode','demo','id',q,'checkoutId',c,'routeId',route_id,'routeVersion',0,'dayVersion',1,'deliveryDate',d,'priceMinor',14900,'currency','UYU','expiresAt',clock_timestamp()+interval '5 minutes','address','{"placeId":"demo-test"}'::jsonb,'candidateRoute',jsonb_build_object('deliveryDate',d,'departureAt',(d+time '10:00') at time zone 'America/Montevideo','stops','[]'::jsonb));
   perform public.shipping_mutate('quote_create',plan);
   perform public.shipping_mutate('service_day_save',jsonb_build_object('merchantId',m,'mode','demo','actorId',actor,'day',jsonb_build_object('deliveryDate',d,'enabled',true,'departureTime','11:00','capacity',10,'maxDurationSeconds',60)));
   if route_id is not null and (select departure_at from shipping.routes where merchant_id=m and mode='demo' and id=route_id)<>((d+time '11:00') at time zone 'America/Montevideo') then raise exception 'empty route ignored departure edit'; end if;
   begin perform public.shipping_mutate('reserve',jsonb_build_object('merchantId',m,'mode','demo','checkoutId',c,'quoteId',q,'expectedVersion',0,'idempotencyKey','day-'||n,'bodyHash','day')); raise exception 'stale day reserved'; exception when sqlstate 'PT409' then if sqlerrm<>'service_day_changed' then raise; end if; end;
   begin perform public.shipping_mutate('quote_create',plan||jsonb_build_object('id',gen_random_uuid()::text)); raise exception 'old in-flight snapshot accepted'; exception when sqlstate 'PT409' then if sqlerrm<>'service_day_changed' then raise; end if; end;
   external_payload:=jsonb_build_object('merchantId',m,'mode','demo','actorId',actor,'routeId',route_id,'expectedVersion',0,'expectedDayVersion',1,'idempotencyKey','external-'||n,'bodyHash','external','candidateRoute',plan->'candidateRoute','shipment',jsonb_build_object('externalOrderRef','order-'||n,'priceMinor',14900,'address','{"placeId":"demo-test"}'::jsonb));
   begin perform public.shipping_mutate('external_create',external_payload); raise exception 'stale external accepted'; exception when sqlstate 'PT409' then if sqlerrm<>'service_day_changed' then raise; end if; end;
   if n=2 then
     if public.shipping_mutate('external_replay',external_payload) is not null then raise exception 'nonexistent replay returned response'; end if;
     external_payload:=external_payload||'{"expectedDayVersion":2}'::jsonb;
     accepted:=public.shipping_mutate('external_create',external_payload);
     if public.shipping_mutate('external_create',external_payload)<>accepted or public.shipping_mutate('external_replay',external_payload)<>accepted then raise exception 'external replay changed response'; end if;
     begin perform public.shipping_mutate('external_create',external_payload||'{"bodyHash":"changed"}'); raise exception 'external key reused for another body'; exception when sqlstate 'PT409' then if sqlerrm<>'idempotency_conflict' then raise; end if; end;
     begin perform public.shipping_mutate('service_day_save',jsonb_build_object('merchantId',m,'mode','demo','actorId',actor,'day',jsonb_build_object('deliveryDate',d,'enabled',true,'departureTime','12:00','capacity',10,'maxDurationSeconds',60))); raise exception 'assigned departure edited'; exception when sqlstate 'PT409' then if sqlerrm<>'assigned_departure_immutable' then raise; end if; end;
   end if;
 end loop;
 -- clock_timestamp must advance within one transaction; now() does not.
 d:=(clock_timestamp() at time zone 'America/Montevideo')::date;
 insert into shipping.service_days(merchant_id,mode,delivery_date) values(m,'demo',d);
 departure:=clock_timestamp()+interval '0.1 seconds';
 insert into shipping.routes(merchant_id,mode,delivery_date,departure_at,capacity,max_duration_seconds) values(m,'demo',d,departure,10,14400) returning id into route_id;
 c:=gen_random_uuid()::text; q:=gen_random_uuid()::text;
 perform public.shipping_mutate('checkout_create',jsonb_build_object('merchantId',m,'mode','demo','id',c,'cart','[{}]'::jsonb,'subtotalMinor',1,'currency','UYU','expiresAt',clock_timestamp()+interval '1 hour'));
 plan:=plan||jsonb_build_object('id',q,'checkoutId',c,'routeId',route_id,'routeVersion',0,'dayVersion',1,'deliveryDate',d);
 perform public.shipping_mutate('quote_create',plan);
 select count(*) into before_count from shipping.shipments where merchant_id=m;
 perform pg_sleep(0.2);
 begin perform public.shipping_mutate('reserve',jsonb_build_object('merchantId',m,'mode','demo','checkoutId',c,'quoteId',q,'expectedVersion',0,'idempotencyKey','late','bodyHash','late')); raise exception 'late reserve accepted'; exception when sqlstate 'PT409' then if sqlerrm<>'route_departed' then raise; end if; end;
 external_payload:=external_payload||jsonb_build_object('routeId',route_id,'expectedVersion',0,'expectedDayVersion',1,'idempotencyKey','late-external','bodyHash','late-external','candidateRoute',jsonb_build_object('deliveryDate',d));
 begin perform public.shipping_mutate('external_create',external_payload); raise exception 'late external accepted'; exception when sqlstate 'PT409' then if sqlerrm<>'route_departed' then raise; end if; end;
 if (select count(*) from shipping.shipments where merchant_id=m)<>before_count or (select version from shipping.routes where merchant_id=m and mode='demo' and id=route_id)<>0 then raise exception 'failed departure commit left partial writes'; end if;
end $$;
-- Final-review regressions: prepared for PostgreSQL, NOT exercised by JS tests.
do $$
declare m text:='sql-final-'||gen_random_uuid()::text; admin_user uuid:=gen_random_uuid();
 d date:=(clock_timestamp() at time zone 'America/Montevideo')::date+1;
 route_id text; shipment_id text; accepted jsonb; retried jsonb; events jsonb;
 c text:=gen_random_uuid()::text; q text:=gen_random_uuid()::text; amount integer;
begin
 insert into shipping.merchants(id,name) values(m,'Final regression fixture');
 insert into auth.users(id) values(admin_user);
 insert into shipping.admin_members(merchant_id,user_id,role) values(m,admin_user,'admin');
 insert into shipping.service_days(merchant_id,mode,delivery_date) values(m,'demo',d);
 insert into shipping.routes(merchant_id,mode,delivery_date,departure_at,capacity,max_duration_seconds) values(m,'demo',d,(d+time '10:00') at time zone 'America/Montevideo',10,14400) returning id into route_id;
 insert into shipping.shipments(merchant_id,mode,route_id,status,price_minor,held_until,data) values(m,'demo',route_id,'held',14900,clock_timestamp()+interval '0.05 seconds','{"address":{"inputAddress":"Own address","placeId":"demo-test"}}') returning id into shipment_id;
 -- now() remains transaction-start time while the wall clock crosses the deadline.
 perform pg_sleep(0.1);
 begin perform public.shipping_mutate('confirm',jsonb_build_object('merchantId',m,'mode','demo','shipmentId',shipment_id,'serverAuthorized',true)); raise exception 'wall-clock expired hold confirmed'; exception when sqlstate 'PT410' then null; end;
 update shipping.shipments set held_until=clock_timestamp()+interval '15 minutes' where merchant_id=m and mode='demo' and id=shipment_id;
 accepted:=public.shipping_mutate('confirm',jsonb_build_object('merchantId',m,'mode','demo','shipmentId',shipment_id,'serverAuthorized',true));
 update shipping.shipments set held_until=now()-interval '1 second' where merchant_id=m and mode='demo' and id=shipment_id;
 retried:=public.shipping_mutate('confirm',jsonb_build_object('merchantId',m,'mode','demo','shipmentId',shipment_id,'serverAuthorized',true));
 if retried->>'status'<>'confirmed' then raise exception 'confirmed replay failed after deadline'; end if;
 if (select count(*) from shipping.audit_events where merchant_id=m and mode='demo' and operation='confirm')<>1 or not exists(select 1 from shipping.audit_events ae where ae.merchant_id=m and ae.actor='commerce-server' and ae.entity_type='shipment' and ae.entity_id=shipment_id and ae.data='{"before":{"status":"held"},"after":{"status":"confirmed"}}'::jsonb) then raise exception 'confirmation audit missing or duplicated'; end if;
 begin perform public.shipping_mutate('cancel',jsonb_build_object('merchantId',m,'mode','demo','actorId',admin_user,'shipmentId',shipment_id,'reason','x')); raise exception 'invalid cancellation reason accepted'; exception when sqlstate 'PT400' then null; end;
 begin perform public.shipping_mutate('cancel',jsonb_build_object('merchantId',m,'mode','demo','actorId',admin_user,'shipmentId',shipment_id,'reason',123)); raise exception 'numeric cancellation reason accepted'; exception when sqlstate 'PT400' then null; end;
 accepted:=public.shipping_mutate('cancel',jsonb_build_object('merchantId',m,'mode','demo','actorId',admin_user,'shipmentId',shipment_id,'reason',' First reason '));
 retried:=public.shipping_mutate('cancel',jsonb_build_object('merchantId',m,'mode','demo','actorId',admin_user,'shipmentId',shipment_id,'reason','Second reason'));
 if accepted<>retried or accepted->>'cancellationReason'<>'First reason' or accepted->>'cancelledBy'<>admin_user::text or accepted->>'cancelledAt' is null or (accepted->>'priceMinor')::integer<>14900 then raise exception 'cancellation metadata/price not immutable'; end if;
 if (select count(*) from shipping.audit_events where merchant_id=m and mode='demo' and operation='cancel')<>1 then raise exception 'cancel replay duplicated audit'; end if;
 perform public.shipping_mutate('price_save',jsonb_build_object('merchantId',m,'mode','demo','actorId',admin_user,'productId','sweater','priceMinor',279000));
 perform public.shipping_mutate('price_save',jsonb_build_object('merchantId',m,'mode','demo','actorId',admin_user,'productId','sweater','priceMinor',300150));
 if not exists(select 1 from shipping.audit_events ae where ae.merchant_id=m and ae.mode='demo' and ae.actor=admin_user::text and ae.entity_type='product_price' and ae.entity_id='sweater' and ae.data='{"before":{"priceMinor":279000},"after":{"priceMinor":300150}}'::jsonb) then raise exception 'price change audit lacks target/values'; end if;
 events:=public.shipping_snapshot(m,'live')->'auditEvents';
 if jsonb_array_length(events)<>0 then raise exception 'audit leaked across modes'; end if;
 if exists(select 1 from shipping.audit_events where merchant_id=m and data::text like '%Own address%') then raise exception 'audit retained address'; end if;
 insert into shipping.checkout_sessions values(c,m,'demo','[{}]',1,'UYU',now()-interval '1 hour');
 insert into shipping.quotes values(q,m,'demo',c,null,0,1,d,14900,'UYU',now()-interval '1 minute','{"address":{"formattedAddress":"Temporary provider output"},"metrics":{"distanceMeters":1}}');
 amount:=shipping.purge_quote_metadata();
 if amount<1 or (select data from shipping.quotes where merchant_id=m and mode='demo' and id=q)<>'{"purged":true}'::jsonb then raise exception 'cleanup retained expired metadata'; end if;
 if (select price_minor from shipping.shipments where merchant_id=m and mode='demo' and id=shipment_id)<>14900 or (select data->'address'->>'inputAddress' from shipping.shipments where merchant_id=m and mode='demo' and id=shipment_id)<>'Own address' then raise exception 'cleanup changed accepted price/address'; end if;
end $$;
set local role anon;
do $$ begin
  begin perform public.shipping_snapshot('marea','demo'); raise exception 'anon RPC allowed';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from shipping.shipments; raise exception 'anon private rows allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
-- Concurrency protocol (pending): create two distinct valid checkouts + quotes
-- for a route with capacity=1/version=0. In session A BEGIN; call reserve; keep
-- transaction open. In B call reserve using its own key: B must block. COMMIT A;
-- B must return PT409; exactly one held shipment and one active stop must exist.
-- Repeat with ROLLBACK A: B must succeed. Execute expiry by updating held_until
-- in this isolated database, then confirm: PT410, never resurrection.
