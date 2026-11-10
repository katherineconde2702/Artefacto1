-- Additive B2B configuration. Apply after the two existing shipping migrations.
-- No merchants, credentials, live prices or demo orders are installed here.
begin;
create table if not exists shipping.discount_rules(
 merchant_id text references shipping.merchants(id),mode text check(mode in ('demo','live')),area_id text,
 enabled boolean not null,tiers jsonb not null check(jsonb_typeof(tiers)='array'),version integer not null default 1,
 primary key(merchant_id,mode,area_id)
);
create table if not exists shipping.delivery_windows(
 merchant_id text references shipping.merchants(id),mode text check(mode in ('demo','live')),id text,
 delivery_date date not null,start_time time not null,end_time time not null,capacity integer not null check(capacity between 1 and 1000),
 enabled boolean not null,version integer not null default 1 check(version>0),check(end_time>start_time),
 primary key(merchant_id,mode,id),foreign key(merchant_id,mode,delivery_date) references shipping.service_days(merchant_id,mode,delivery_date)
);
alter table shipping.discount_rules enable row level security;
alter table shipping.delivery_windows enable row level security;
revoke all on shipping.discount_rules,shipping.delivery_windows from public,anon,authenticated,service_role;
alter table shipping.routes add column if not exists window_id text;
alter table shipping.routes add column if not exists dispatch_key text generated always as (case when window_id is null then 'legacy' else 'window:'||window_id end) stored;
alter table shipping.routes drop constraint if exists routes_merchant_id_mode_delivery_date_key;
alter table shipping.routes drop constraint if exists routes_capacity_check;
alter table shipping.routes add constraint routes_capacity_check check(capacity between 1 and 1000);
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='shipping.routes'::regclass and conname='routes_dispatch_unique') then
  alter table shipping.routes add constraint routes_dispatch_unique unique(merchant_id,mode,delivery_date,dispatch_key);
 end if;
 if not exists(select 1 from pg_constraint where conrelid='shipping.routes'::regclass and conname='routes_window_fk') then
  alter table shipping.routes add constraint routes_window_fk foreign key(merchant_id,mode,window_id) references shipping.delivery_windows(merchant_id,mode,id);
 end if;
end $$;

create or replace function shipping.b2b_rule_valid(item jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare tier jsonb; threshold numeric; amount numeric; seen integer[]:='{}';
begin
 if jsonb_typeof(item) is distinct from 'object' or exists(select 1 from jsonb_object_keys(item) key where key not in ('areaId','enabled','tiers')) or
 jsonb_typeof(item->'areaId') is distinct from 'string' or (item->>'areaId')!~'^([a-z0-9_-]{1,80}|\*)$' or
 jsonb_typeof(item->'enabled') is distinct from 'boolean' or jsonb_typeof(item->'tiers') is distinct from 'array' then return false;end if;
 if jsonb_array_length(item->'tiers')>20 or ((item->>'enabled')::boolean and jsonb_array_length(item->'tiers')=0) then return false;end if;
 for tier in select value from jsonb_array_elements(item->'tiers') loop
  if jsonb_typeof(tier) is distinct from 'object' or exists(select 1 from jsonb_object_keys(tier) key where key not in ('minOrders','type','value')) or
   jsonb_typeof(tier->'minOrders') is distinct from 'number' or jsonb_typeof(tier->'value') is distinct from 'number' or
   jsonb_typeof(tier->'type') is distinct from 'string' or tier->>'type' not in ('fixed','percent') then return false;end if;
  threshold:=(tier->>'minOrders')::numeric;amount:=(tier->>'value')::numeric;
  if threshold<>trunc(threshold) or threshold<1 or threshold>1000 or threshold::integer=any(seen) or amount<>trunc(amount) or amount<1 or amount>(case when tier->>'type'='percent' then 10000 else 1000000000 end) then return false;end if;
  seen:=array_append(seen,threshold::integer);
 end loop;
 return true;
end $$;

do $$ begin
 if to_regprocedure('public.shipping_snapshot_v2(text,text)') is null then alter function public.shipping_snapshot(text,text) rename to shipping_snapshot_v2;end if;
 if to_regprocedure('public.shipping_mutate_v2(text,jsonb)') is null then alter function public.shipping_mutate(text,jsonb) rename to shipping_mutate_v2;end if;
end $$;

create or replace function public.shipping_snapshot(p_merchant_id text,p_mode text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; windows jsonb; rules jsonb; routes jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_merchant_id||':'||p_mode||':admin',0));
 result:=public.shipping_snapshot_v2(p_merchant_id,p_mode);
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'deliveryDate',delivery_date,'startTime',to_char(start_time,'HH24:MI'),'endTime',to_char(end_time,'HH24:MI'),'capacity',capacity,'enabled',enabled,'version',version) order by delivery_date,start_time,id),'[]') into windows from shipping.delivery_windows where merchant_id=p_merchant_id and mode=p_mode;
 select coalesce(jsonb_agg(jsonb_build_object('areaId',area_id,'enabled',enabled,'tiers',tiers,'version',version) order by area_id),'[]') into rules from shipping.discount_rules where merchant_id=p_merchant_id and mode=p_mode;
 select coalesce(jsonb_agg(entry.value||case when r.window_id is not null then jsonb_build_object('windowId',r.window_id) else '{}'::jsonb end),'[]') into routes from jsonb_array_elements(result->'routes') entry join shipping.routes r on r.id=entry.value->>'id' and r.merchant_id=p_merchant_id and r.mode=p_mode;
 return result||jsonb_build_object('b2bVersion',1,'windows',windows,'discountRules',rules,'routes',routes);
end $$;

create or replace function public.shipping_mutate(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
<<b2b>>
declare
 m text:=p_payload->>'merchantId';md text:=p_payload->>'mode';actor uuid;item jsonb;before_values jsonb:='{}';result jsonb;audit_type text;audit_id text;
 policy shipping.rate_policies;w shipping.delivery_windows;old_w shipping.delivery_windows;d shipping.service_days;
 r shipping.routes;q shipping.quotes;c shipping.checkout_sessions;s shipping.shipments;previous shipping.idempotency_keys;
 window_id text;date_value date;day_version integer;cap integer;departure timestamptz;occupied integer;is_external boolean;entity_id text;
 candidate jsonb;stop jsonb;position_value integer;version_value integer;amount numeric;scope_key text;route_window text;
begin
 if md is null or md not in ('demo','live') then raise sqlstate 'PT400' using message='mode_invalid';end if;
 if not exists(select 1 from shipping.merchants where id=m) then raise sqlstate 'PT404' using message='merchant_not_found';end if;
 -- One lock order across every RPC, including confirmations and snapshots.
 perform pg_advisory_xact_lock(hashtextextended(m||':'||md||':admin',0));
 if p_operation='service_day_save' and exists(select 1 from shipping.delivery_windows where merchant_id=m and mode=md and delivery_date=(p_payload->'day'->>'deliveryDate')::date) then raise sqlstate 'PT409' using message='use_delivery_windows';end if;
 if p_operation='promotion_save' then
  result:=public.shipping_mutate_v2(p_operation,p_payload);
  select * into policy from shipping.rate_policies where merchant_id=m and mode=md order by version desc limit 1;
  insert into shipping.rate_policies(merchant_id,mode,version,data) values(m,md,policy.version+1,policy.data);
  return result;
 end if;
 if p_operation='service_day_save' then
  perform public.shipping_snapshot_v2(m,md);
  select * into r from shipping.routes where merchant_id=m and mode=md and delivery_date=(p_payload->'day'->>'deliveryDate')::date and shipping.routes.window_id is null for update;
  if (p_payload->'day'->>'capacity')::integer<(select count(*) from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id) then raise sqlstate 'PT409' using message='window_capacity_below_occupancy';end if;
  result:=public.shipping_mutate_v2(p_operation,p_payload);
  if r.id is not null then update shipping.routes set capacity=(p_payload->'day'->>'capacity')::integer,max_duration_seconds=(p_payload->'day'->>'maxDurationSeconds')::integer,version=version+1 where merchant_id=m and mode=md and id=r.id;end if;
  return result;
 end if;
 if p_operation not in ('discount_rule_save','delivery_window_save','quote_create','reserve','external_create') then return public.shipping_mutate_v2(p_operation,p_payload);end if;
 if p_operation in ('discount_rule_save','delivery_window_save','external_create') then
  begin actor:=(p_payload->>'actorId')::uuid;exception when invalid_text_representation then actor:=null;end;
  if actor is null or public.shipping_admin_context(actor,m) is null then raise sqlstate 'PT403' using message='admin_forbidden';end if;
 end if;
 select * into policy from shipping.rate_policies where merchant_id=m and mode=md order by version desc limit 1;
 if policy.version is null then raise sqlstate 'PT409' using message='policy_missing';end if;
 if p_operation='discount_rule_save' then
  item:=p_payload->'rule';
  if shipping.b2b_rule_valid(item) is distinct from true or (item->>'areaId'<>'*' and not exists(select 1 from shipping.neighborhoods where merchant_id=m and id=item->>'areaId')) then raise sqlstate 'PT400' using message='discount_rule_invalid';end if;
  select jsonb_build_object('areaId',area_id,'enabled',enabled,'tiers',tiers) into before_values from shipping.discount_rules where merchant_id=m and mode=md and area_id=item->>'areaId';
  select coalesce(jsonb_agg(value order by (value->>'minOrders')::integer),'[]') into candidate from jsonb_array_elements(item->'tiers');
  insert into shipping.discount_rules(merchant_id,mode,area_id,enabled,tiers) values(m,md,item->>'areaId',(item->>'enabled')::boolean,candidate)
  on conflict(merchant_id,mode,area_id) do update set enabled=excluded.enabled,tiers=excluded.tiers,version=shipping.discount_rules.version+1 returning version into version_value;
  result:=item||jsonb_build_object('tiers',candidate,'version',version_value);audit_type:='discount_rule';audit_id:=item->>'areaId';
 elsif p_operation='delivery_window_save' then
  item:=p_payload->'window';
  if jsonb_typeof(item) is distinct from 'object' or exists(select 1 from jsonb_object_keys(item) key where key not in ('id','deliveryDate','startTime','endTime','capacity','enabled')) or
    jsonb_typeof(item->'id') is distinct from 'string' or (item->>'id')!~'^[a-zA-Z0-9_-]{1,80}$' or jsonb_typeof(item->'deliveryDate') is distinct from 'string' or (item->>'deliveryDate')!~'^\d{4}-\d{2}-\d{2}$' or
    jsonb_typeof(item->'startTime') is distinct from 'string' or (item->>'startTime')!~'^([01]\d|2[0-3]):[0-5]\d$' or
    jsonb_typeof(item->'endTime') is distinct from 'string' or (item->>'endTime')!~'^([01]\d|2[0-3]):[0-5]\d$' or item->>'endTime'<=item->>'startTime' or
    jsonb_typeof(item->'capacity') is distinct from 'number' or jsonb_typeof(item->'enabled') is distinct from 'boolean' then raise sqlstate 'PT400' using message='delivery_window_invalid';end if;
  amount:=(item->>'capacity')::numeric;date_value:=(item->>'deliveryDate')::date;departure:=(date_value+(item->>'startTime')::time) at time zone 'America/Montevideo';
  if amount<>trunc(amount) or amount<1 or amount>1000 or ((item->>'enabled')::boolean and (departure<=clock_timestamp() or date_value>(now() at time zone 'America/Montevideo')::date+31)) then raise sqlstate 'PT400' using message='delivery_window_invalid';end if;
  select * into old_w from shipping.delivery_windows where merchant_id=m and mode=md and id=item->>'id' for update;
  perform public.shipping_snapshot_v2(m,md);
  select * into r from shipping.routes where merchant_id=m and mode=md and shipping.routes.window_id=item->>'id' for update;
  select count(*) into occupied from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id;
  if occupied>0 and (old_w.delivery_date<>date_value or old_w.start_time<>(item->>'startTime')::time or old_w.end_time<>(item->>'endTime')::time) then raise sqlstate 'PT409' using message='assigned_departure_immutable';end if;
  if amount<occupied then raise sqlstate 'PT409' using message='window_capacity_below_occupancy';end if;
  if exists(select 1 from shipping.routes rr join shipping.route_stops st on st.merchant_id=rr.merchant_id and st.mode=rr.mode and st.route_id=rr.id where rr.merchant_id=m and rr.mode=md and rr.delivery_date=date_value and rr.window_id is null) then raise sqlstate 'PT409' using message='legacy_day_assigned';end if;
  if (item->>'enabled')::boolean and exists(select 1 from shipping.delivery_windows where merchant_id=m and mode=md and id<>item->>'id' and delivery_date=date_value and enabled and (item->>'startTime')::time<end_time and (item->>'endTime')::time>start_time) then raise sqlstate 'PT409' using message='window_overlap';end if;
  if (select count(*) from shipping.delivery_windows where merchant_id=m and mode=md and delivery_date=date_value and id<>item->>'id')>=24 then raise sqlstate 'PT409' using message='window_limit';end if;
  insert into shipping.service_days(merchant_id,mode,delivery_date,enabled) values(m,md,date_value,false) on conflict do nothing;
  if old_w.id is not null then before_values:=jsonb_build_object('deliveryDate',old_w.delivery_date,'startTime',to_char(old_w.start_time,'HH24:MI'),'endTime',to_char(old_w.end_time,'HH24:MI'),'capacity',old_w.capacity,'enabled',old_w.enabled);end if;
  insert into shipping.delivery_windows(merchant_id,mode,id,delivery_date,start_time,end_time,capacity,enabled) values(m,md,item->>'id',date_value,(item->>'startTime')::time,(item->>'endTime')::time,amount::integer,(item->>'enabled')::boolean)
  on conflict(merchant_id,mode,id) do update set delivery_date=excluded.delivery_date,start_time=excluded.start_time,end_time=excluded.end_time,capacity=excluded.capacity,enabled=excluded.enabled,version=shipping.delivery_windows.version+1 returning * into w;
  if r.id is not null then update shipping.routes set delivery_date=date_value,departure_at=departure,capacity=w.capacity,version=version+1 where merchant_id=m and mode=md and id=r.id;end if;
  result:=item||jsonb_build_object('version',w.version);audit_type:='delivery_window';audit_id:=w.id;
 elsif p_operation='quote_create' then
  select * into c from shipping.checkout_sessions where merchant_id=m and mode=md and id=p_payload->>'checkoutId';
  if c.id is null or c.expires_at<=clock_timestamp() then raise sqlstate 'PT410' using message='checkout_expired';end if;
  amount:=(p_payload->>'priceMinor')::numeric;
  if amount is null or amount<>trunc(amount) or amount<(policy.data->>'minimumMinor')::bigint or amount>1000000000 or p_payload->>'currency' is distinct from 'UYU' or (p_payload->>'expiresAt')::timestamptz<=clock_timestamp() then raise sqlstate 'PT400' using message='quote_invalid';end if;
  if p_payload ? 'policyVersion' and (p_payload->>'policyVersion')::integer<>policy.version then raise sqlstate 'PT409' using message='policy_changed';end if;
  date_value:=(p_payload->>'deliveryDate')::date;window_id:=p_payload->>'windowId';
  if window_id is not null then
   select * into w from shipping.delivery_windows where merchant_id=m and mode=md and id=window_id;
   if w.id is null or not w.enabled or w.delivery_date<>date_value then raise sqlstate 'PT409' using message='window_unavailable';end if;
   day_version:=w.version;
  else
   select * into d from shipping.service_days where merchant_id=m and mode=md and delivery_date=date_value;
   if d.delivery_date is null or not d.enabled or exists(select 1 from shipping.delivery_windows where merchant_id=m and mode=md and delivery_date=date_value) then raise sqlstate 'PT409' using message='service_day_unavailable';end if;
   day_version:=d.version;
  end if;
  if coalesce((p_payload->>'dayVersion')::integer,case when md='demo' then 1 end) is distinct from day_version then raise sqlstate 'PT409' using message='service_day_changed';end if;
  insert into shipping.quotes values(coalesce(p_payload->>'id',gen_random_uuid()::text),m,md,c.id,p_payload->>'routeId',(p_payload->>'routeVersion')::integer,day_version,date_value,amount::bigint,'UYU',least((p_payload->>'expiresAt')::timestamptz,clock_timestamp()+interval '5 minutes'),(p_payload-'actorId')||jsonb_build_object('dayVersion',day_version)) returning * into q;
  return q.data||jsonb_build_object('id',q.id,'expiresAt',q.expires_at);
 else
  -- Both legacy and window departures use this reservation path. Older RPCs
  -- retain confirmations/cancellations but cannot create date-ambiguous routes.
  is_external:=p_operation='external_create';
  if coalesce(p_payload->>'idempotencyKey','')='' or coalesce(p_payload->>'bodyHash','')='' then raise sqlstate 'PT400' using message='idempotency_required';end if;
  select * into previous from shipping.idempotency_keys where merchant_id=m and mode=md and operation=p_operation and key=p_payload->>'idempotencyKey';
  if previous.key is not null then
   if previous.body_hash is distinct from p_payload->>'bodyHash' then raise sqlstate 'PT409' using message='idempotency_conflict';end if;
   return previous.response;
  end if;
  if is_external then
   item:=p_payload->'shipment';date_value:=coalesce(p_payload->'candidateRoute'->>'deliveryDate',item->>'deliveryDate')::date;window_id:=item->>'windowId';day_version:=(p_payload->>'expectedDayVersion')::integer;
   if (window_id is not null or p_payload ? 'expectedPolicyVersion') and (p_payload->>'expectedPolicyVersion')::integer is distinct from policy.version then raise sqlstate 'PT409' using message='policy_changed';end if;
   candidate:=p_payload->'candidateRoute'->'stops';route_window:=p_payload->>'routeId';
  else
   select * into q from shipping.quotes where merchant_id=m and mode=md and id=p_payload->>'quoteId';
   select * into c from shipping.checkout_sessions where merchant_id=m and mode=md and id=p_payload->>'checkoutId';
   if q.id is null or c.id is null or q.checkout_id<>c.id then raise sqlstate 'PT404' using message='quote_not_found';end if;
   if q.data ? 'policyVersion' and (q.data->>'policyVersion')::integer is distinct from policy.version then raise sqlstate 'PT409' using message='policy_changed';end if;
   if q.expires_at<=clock_timestamp() or c.expires_at<=clock_timestamp() then raise sqlstate 'PT410' using message='quote_expired';end if;
   date_value:=q.delivery_date;window_id:=q.data->>'windowId';day_version:=q.day_version;candidate:=q.data->'candidateRoute'->'stops';route_window:=q.route_id;
  end if;
  if window_id is not null then
   select * into w from shipping.delivery_windows where merchant_id=m and mode=md and id=window_id for update;
   if w.id is null or not w.enabled or w.delivery_date<>date_value or w.version is distinct from day_version then raise sqlstate 'PT409' using message='window_unavailable';end if;
   cap:=w.capacity;departure:=(date_value+w.start_time) at time zone 'America/Montevideo';
  else
   select * into d from shipping.service_days where merchant_id=m and mode=md and delivery_date=date_value for update;
   if d.delivery_date is null or not d.enabled or exists(select 1 from shipping.delivery_windows where merchant_id=m and mode=md and delivery_date=date_value) then raise sqlstate 'PT409' using message='service_day_unavailable';end if;
   if d.version is distinct from coalesce(day_version,case when md='demo' then 1 end) then raise sqlstate 'PT409' using message='service_day_changed';end if;
   cap:=d.capacity;departure:=(date_value+d.departure_time) at time zone 'America/Montevideo';
  end if;
  if departure<=clock_timestamp() then raise sqlstate 'PT409' using message='route_departed';end if;
  perform public.shipping_snapshot_v2(m,md);
  if route_window is null then
   insert into shipping.routes(merchant_id,mode,delivery_date,departure_at,capacity,max_duration_seconds,window_id) values(m,md,date_value,departure,cap,coalesce(d.max_duration_seconds,14400),window_id) on conflict(merchant_id,mode,delivery_date,dispatch_key) do nothing;
   select * into r from shipping.routes where merchant_id=m and mode=md and delivery_date=date_value and shipping.routes.window_id is not distinct from b2b.window_id for update;
  else select * into r from shipping.routes where merchant_id=m and mode=md and id=route_window for update;end if;
  if r.id is null or r.delivery_date<>date_value or r.window_id is distinct from window_id or r.version is distinct from (p_payload->>'expectedVersion')::integer or (not is_external and r.version<>q.route_version) then raise sqlstate 'PT409' using message='route_changed';end if;
  if (select count(*) from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id)>=least(r.capacity,cap) then raise sqlstate 'PT409' using message='route_full';end if;
  if not is_external and (q.expires_at<=clock_timestamp() or c.expires_at<=clock_timestamp()) then raise sqlstate 'PT410' using message='quote_expired';end if;
  if is_external then
   amount:=(item->>'priceMinor')::numeric;
   if coalesce(item->>'externalOrderRef','')='' or amount is null or amount<>trunc(amount) or amount<(policy.data->>'minimumMinor')::bigint or amount>1000000000 then raise sqlstate 'PT400' using message='external_invalid';end if;
   insert into shipping.shipments(merchant_id,mode,route_id,status,price_minor,external_order_ref,data) values(m,md,r.id,'confirmed',amount::bigint,item->>'externalOrderRef',jsonb_build_object('address',(item->'address')-'formattedAddress'-'geometry','externalOrderRef',item->>'externalOrderRef','deliveryDate',date_value)) returning * into s;
  else
   if exists(select 1 from shipping.shipments where merchant_id=m and mode=md and (quote_id=q.id or checkout_id=c.id)) then raise sqlstate 'PT409' using message='checkout_reserved';end if;
   insert into shipping.shipments(merchant_id,mode,quote_id,checkout_id,route_id,status,price_minor,held_until,data) values(m,md,q.id,c.id,r.id,'held',q.price_minor,clock_timestamp()+interval '15 minutes',jsonb_build_object('deliveryDate',date_value,'address',(q.data->'address')-'formattedAddress'-'geometry','normalPriceMinor',q.data->'normalPriceMinor','promotionId',q.data->'promotionId','calculation',q.data->'calculation')) returning * into s;
  end if;
  if window_id is not null then
   update shipping.shipments set data=data||jsonb_build_object('windowId',window_id,'windowStart',to_char(w.start_time,'HH24:MI'),'windowEnd',to_char(w.end_time,'HH24:MI')) where merchant_id=m and mode=md and id=s.id returning * into s;
  end if;
  if candidate is not null and jsonb_typeof(candidate)='array' and exists(select 1 from jsonb_array_elements(candidate) entry where entry->'shipmentId'='null'::jsonb) then
   if jsonb_array_length(candidate)<>(select count(*)+1 from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id) or (select count(*) from jsonb_array_elements(candidate) entry where entry->'shipmentId'='null'::jsonb)<>1 or exists(select 1 from shipping.route_stops st where st.merchant_id=m and st.mode=md and st.route_id=r.id and not exists(select 1 from jsonb_array_elements(candidate) entry where entry->>'shipmentId'=st.shipment_id)) then raise sqlstate 'PT409' using message='route_changed';end if;
   update shipping.route_stops set position=position+1001 where merchant_id=m and mode=md and route_id=r.id;position_value:=0;
   for stop in select value from jsonb_array_elements(candidate) loop
    position_value:=position_value+1;
    if stop->'shipmentId'='null'::jsonb then insert into shipping.route_stops values(m,md,r.id,s.id,position_value,case when is_external then item->'address'->>'placeId' else q.data->'address'->>'placeId' end,'Entrega');
    else update shipping.route_stops set position=position_value where merchant_id=m and mode=md and route_id=r.id and shipment_id=stop->>'shipmentId';end if;
   end loop;
  else
   select coalesce(max(position),0)+1 into position_value from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id;
   insert into shipping.route_stops values(m,md,r.id,s.id,position_value,case when is_external then item->'address'->>'placeId' else q.data->'address'->>'placeId' end,'Entrega');
  end if;
  update shipping.routes set version=version+1 where merchant_id=m and mode=md and id=r.id;
  result:=shipping.shipment_json(s);
  insert into shipping.idempotency_keys values(m,md,p_operation,p_payload->>'idempotencyKey',p_payload->>'bodyHash',result,clock_timestamp());
  insert into shipping.audit_events(merchant_id,mode,actor_id,actor,operation,entity_type,entity_id,data) values(m,md,actor,coalesce(actor::text,'checkout-buyer'),p_operation,'shipment',s.id,jsonb_build_object('before','{}'::jsonb,'after',shipping.audit_values('shipment',result)));
  return result;
 end if;
 insert into shipping.rate_policies(merchant_id,mode,version,data) values(m,md,policy.version+1,policy.data);
 insert into shipping.audit_events(merchant_id,mode,actor_id,actor,operation,entity_type,entity_id,data) values(m,md,actor,actor::text,p_operation,audit_type,audit_id,jsonb_build_object('before',coalesce(before_values,'{}'::jsonb),'after',result-'version'));
 return result;
exception when unique_violation then raise sqlstate 'PT409' using message='shipping_conflict';
 when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow then raise sqlstate 'PT400' using message='shipping_invalid';
end $$;

revoke all on function shipping.b2b_rule_valid(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.shipping_snapshot_v2(text,text),public.shipping_mutate_v2(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.shipping_snapshot(text,text),public.shipping_mutate(text,jsonb) from public,anon,authenticated;
grant execute on function public.shipping_snapshot(text,text),public.shipping_mutate(text,jsonb) to service_role;
commit;
