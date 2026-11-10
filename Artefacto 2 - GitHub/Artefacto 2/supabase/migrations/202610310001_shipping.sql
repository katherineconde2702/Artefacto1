-- Shipping owns only its private schema and the three named public RPCs.
begin;
create schema shipping;
revoke all on schema shipping from public, anon, authenticated;

create table shipping.merchants (
  id text primary key, name text not null, currency text not null default 'UYU' check(currency='UYU'),
  timezone text not null default 'America/Montevideo', origin_place_id text,
  data jsonb not null default '{}'
);
create table shipping.admin_members (
  merchant_id text references shipping.merchants(id), user_id uuid references auth.users(id),
  role text not null check(role in ('owner','admin')), enabled boolean not null default true,
  primary key(merchant_id,user_id)
);
create table shipping.rate_policies (
  merchant_id text references shipping.merchants(id), mode text check(mode in ('demo','live')),
  version integer check(version>0), data jsonb not null,
  created_at timestamptz not null default now(), primary key(merchant_id,mode,version),
  check(data ?& array['minimumMinor','roundingMinor','fuelPriceMinorPerLiter','fuelLitersPer100Km','laborMinorPerHour','serviceMinutes','marginBps','quoteMinutes','holdMinutes']),
  check((data->>'minimumMinor')::bigint>0), check((data->>'roundingMinor')::bigint>0),
  check((data->>'marginBps')::integer between 0 and 9999),
  check((data->>'fuelPriceMinorPerLiter')::bigint>=0 and (data->>'fuelLitersPer100Km')::numeric>=0 and (data->>'laborMinorPerHour')::bigint>=0 and (data->>'serviceMinutes')::numeric>=0),
  check((data->>'quoteMinutes')::integer=5 and (data->>'holdMinutes')::integer=15)
);
create table shipping.product_prices (
  merchant_id text references shipping.merchants(id), mode text check(mode in ('demo','live')),
  product_id text, price_minor bigint not null check(price_minor>0), version integer not null default 1,
  primary key(merchant_id,mode,product_id)
);
create table shipping.neighborhoods (
  merchant_id text references shipping.merchants(id), id text, name text not null,
  data jsonb not null default '{}', primary key(merchant_id,id)
);
create table shipping.service_days (
  merchant_id text references shipping.merchants(id), mode text check(mode in ('demo','live')), delivery_date date,
  enabled boolean not null default true, departure_time time not null default '10:00',
  capacity integer not null default 10 check(capacity between 1 and 10),
  max_duration_seconds integer not null default 14400 check(max_duration_seconds>0),
  version integer not null default 1 check(version>0),
  primary key(merchant_id,mode,delivery_date)
);
create table shipping.promotions (
  id text not null default gen_random_uuid()::text, merchant_id text references shipping.merchants(id),
  mode text check(mode in ('demo','live')), area_id text not null, delivery_date date not null,
  price_minor bigint not null check(price_minor>0), active boolean not null default true, version integer not null default 1,
  primary key(merchant_id,mode,id), foreign key(merchant_id,area_id) references shipping.neighborhoods(merchant_id,id)
);
create unique index promotions_active on shipping.promotions(merchant_id,mode,area_id,delivery_date) where active;
create table shipping.checkout_sessions (
  id text not null, merchant_id text references shipping.merchants(id), mode text check(mode in ('demo','live')),
  cart jsonb not null check(jsonb_typeof(cart)='array'), subtotal_minor bigint not null check(subtotal_minor>0),
  currency text not null check(currency='UYU'), expires_at timestamptz not null,
  primary key(merchant_id,mode,id)
);
create table shipping.routes (
  id text not null default gen_random_uuid()::text, merchant_id text references shipping.merchants(id),
  mode text check(mode in ('demo','live')), delivery_date date not null, departure_at timestamptz not null,
  capacity integer not null check(capacity between 1 and 10), max_duration_seconds integer not null check(max_duration_seconds>0),
  version integer not null default 0 check(version>=0), primary key(merchant_id,mode,id),
  unique(merchant_id,mode,delivery_date), foreign key(merchant_id,mode,delivery_date) references shipping.service_days(merchant_id,mode,delivery_date)
);
create table shipping.quotes (
  id text not null, merchant_id text references shipping.merchants(id), mode text check(mode in ('demo','live')),
  checkout_id text not null, route_id text, route_version integer not null check(route_version>=0),
  day_version integer not null check(day_version>0),
  delivery_date date not null, price_minor bigint not null check(price_minor>0), currency text not null check(currency='UYU'),
  expires_at timestamptz not null, data jsonb not null, primary key(merchant_id,mode,id),
  foreign key(merchant_id,mode,checkout_id) references shipping.checkout_sessions(merchant_id,mode,id),
  foreign key(merchant_id,mode,route_id) references shipping.routes(merchant_id,mode,id)
);
create table shipping.shipments (
  id text not null default gen_random_uuid()::text, merchant_id text references shipping.merchants(id),
  mode text check(mode in ('demo','live')), quote_id text, checkout_id text, route_id text not null,
  external_order_ref text, status text not null check(status in ('held','confirmed','completed','cancelled','expired')),
  price_minor bigint not null check(price_minor>0), currency text not null default 'UYU' check(currency='UYU'),
  held_until timestamptz, data jsonb not null default '{}', created_at timestamptz not null default now(),
  primary key(merchant_id,mode,id), unique(merchant_id,mode,quote_id), unique(merchant_id,mode,checkout_id),
  unique(merchant_id,mode,external_order_ref),
  foreign key(merchant_id,mode,quote_id) references shipping.quotes(merchant_id,mode,id),
  foreign key(merchant_id,mode,checkout_id) references shipping.checkout_sessions(merchant_id,mode,id),
  foreign key(merchant_id,mode,route_id) references shipping.routes(merchant_id,mode,id),
  check(status<>'held' or held_until is not null)
);
create table shipping.route_stops (
  merchant_id text, mode text, route_id text, shipment_id text, position integer not null check(position>0),
  place_id text not null, label text not null default 'Entrega',
  primary key(merchant_id,mode,shipment_id), unique(merchant_id,mode,route_id,position),
  foreign key(merchant_id,mode,route_id) references shipping.routes(merchant_id,mode,id),
  foreign key(merchant_id,mode,shipment_id) references shipping.shipments(merchant_id,mode,id)
);
create table shipping.idempotency_keys (
  merchant_id text references shipping.merchants(id), mode text check(mode in ('demo','live')),
  operation text, key text, body_hash text not null, response jsonb not null, created_at timestamptz not null default now(),
  primary key(merchant_id,mode,operation,key)
);
create table shipping.audit_events (
  id uuid primary key default gen_random_uuid(), merchant_id text references shipping.merchants(id),
  mode text not null check(mode in ('demo','live')), actor_id uuid references auth.users(id), actor text not null,
  operation text not null, entity_type text not null, entity_id text not null, created_at timestamptz not null default clock_timestamp(),
  data jsonb not null default '{}'
);
create index audit_events_recent on shipping.audit_events(merchant_id,mode,created_at desc,id desc);
create index shipments_expiry on shipping.shipments(merchant_id,mode,held_until) where status='held';
create index shipments_route_status on shipping.shipments(merchant_id,mode,route_id,status);
create index quotes_expiry on shipping.quotes(expires_at);
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='shipping' loop
    execute format('alter table shipping.%I enable row level security',t.tablename);
    execute format('revoke all on table shipping.%I from public, anon, authenticated',t.tablename);
  end loop;
end $$;

create function public.shipping_admin_context(p_user_id uuid,p_merchant_id text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('userId',user_id,'merchantId',merchant_id,'role',role)
 from shipping.admin_members where merchant_id=p_merchant_id and user_id=p_user_id and enabled;
$$;

create function public.shipping_snapshot(p_merchant_id text,p_mode text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; expired_route record;
begin
 if p_mode is null or p_mode not in ('demo','live') then raise sqlstate 'PT400' using message='mode_invalid'; end if;
 if not exists(select 1 from shipping.merchants where id=p_merchant_id) then raise sqlstate 'PT404' using message='merchant_not_found'; end if;
 -- Expiration is part of reading planning state, so the returned route version
 -- and filtered stops describe the same committed state for the next quote.
 for expired_route in select r.id from shipping.routes r where r.merchant_id=p_merchant_id and r.mode=p_mode and exists(select 1 from shipping.shipments s where s.merchant_id=r.merchant_id and s.mode=r.mode and s.route_id=r.id and s.status='held' and s.held_until<=now()) order by r.id for update of r loop
   update shipping.shipments set status='expired' where merchant_id=p_merchant_id and mode=p_mode and route_id=expired_route.id and status='held' and held_until<=now();
   delete from shipping.route_stops st using shipping.shipments s where st.merchant_id=p_merchant_id and st.mode=p_mode and st.route_id=expired_route.id and s.merchant_id=st.merchant_id and s.mode=st.mode and s.id=st.shipment_id and s.status='expired';
   update shipping.routes set version=version+1 where merchant_id=p_merchant_id and mode=p_mode and id=expired_route.id;
 end loop;
 select jsonb_build_object(
  'mode',p_mode,
  'merchant',(select data||jsonb_build_object('id',id,'name',name,'currency',currency,'timezone',timezone,'originPlaceId',case when p_mode='demo' then 'demo-centro' else origin_place_id end) from shipping.merchants where id=p_merchant_id),
  'policy',coalesce((select data||jsonb_build_object('version',version) from shipping.rate_policies where merchant_id=p_merchant_id and mode=p_mode order by version desc limit 1),'{}'),
  'prices',coalesce((select jsonb_object_agg(product_id,price_minor) from shipping.product_prices where merchant_id=p_merchant_id and mode=p_mode),'{}'),
  'areas',coalesce((select jsonb_agg(data||jsonb_build_object('id',id,'name',name,'country','UY','city','Montevideo')) from shipping.neighborhoods where merchant_id=p_merchant_id),'[]'),
  'days',coalesce((select jsonb_agg(jsonb_build_object('deliveryDate',delivery_date,'enabled',enabled,'departureTime',to_char(departure_time,'HH24:MI'),'capacity',capacity,'maxDurationSeconds',max_duration_seconds,'version',version) order by delivery_date) from shipping.service_days where merchant_id=p_merchant_id and mode=p_mode and delivery_date>=(now() at time zone 'America/Montevideo')::date),'[]'),
  'promotions',coalesce((select jsonb_agg(jsonb_build_object('id',id,'areaId',area_id,'deliveryDate',delivery_date,'priceMinor',price_minor,'active',active,'version',version)) from shipping.promotions where merchant_id=p_merchant_id and mode=p_mode),'[]'),
  'routes',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'deliveryDate',r.delivery_date,'departureAt',r.departure_at,'capacity',r.capacity,'maxDurationSeconds',r.max_duration_seconds,'version',r.version,'stops',coalesce((select jsonb_agg(jsonb_build_object('shipmentId',s.id,'placeId',st.place_id,'label',st.label,'priceMinor',s.price_minor,'status',s.status) order by st.position) from shipping.route_stops st join shipping.shipments s on s.merchant_id=st.merchant_id and s.mode=st.mode and s.id=st.shipment_id where st.merchant_id=r.merchant_id and st.mode=r.mode and st.route_id=r.id and (s.status='confirmed' or (s.status='held' and s.held_until>now()))),'[]'))) from shipping.routes r where r.merchant_id=p_merchant_id and r.mode=p_mode),'[]'),
  'shipments',coalesce((select jsonb_agg(data||jsonb_build_object('id',id,'checkoutId',checkout_id,'quoteId',quote_id,'routeId',route_id,'status',case when status='held' and held_until<=now() then 'expired' else status end,'priceMinor',price_minor,'currency',currency,'expiresAt',held_until,'mode',mode)) from shipping.shipments where merchant_id=p_merchant_id and mode=p_mode),'[]'),
  'auditEvents',coalesce((select jsonb_agg(jsonb_build_object('id',id,'merchantId',merchant_id,'mode',mode,'actor',actor,'operation',operation,'entityType',entity_type,'entityId',entity_id,'createdAt',created_at,'changes',data) order by created_at desc,id desc) from (select * from shipping.audit_events where merchant_id=p_merchant_id and mode=p_mode order by created_at desc,id desc limit 100) recent),'[]')
 ) into result;
 return result;
end $$;

-- Private helper exposes only accepted shipment conditions, never quote metrics.
create function shipping.shipment_json(s shipping.shipments) returns jsonb
language sql stable set search_path='' as $$
 select s.data||jsonb_build_object('id',s.id,'checkoutId',s.checkout_id,'quoteId',s.quote_id,'routeId',s.route_id,'status',s.status,'priceMinor',s.price_minor,'currency',s.currency,'expiresAt',s.held_until,'mode',s.mode);
$$;

-- Audit stores only business changes; never arbitrary request/provider/address data.
create function shipping.audit_values(entity_type text, value jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(key,val),'{}'::jsonb) from jsonb_each(coalesce(value,'{}'::jsonb)) entry(key,val)
 where key=any(case entity_type
 when 'rate_policy' then array['minimumMinor','fuelPriceMinorPerLiter','fuelLitersPer100Km','laborMinorPerHour','serviceMinutes','marginBps','roundingMinor','quoteMinutes','holdMinutes']
 when 'product_price' then array['priceMinor']
 when 'promotion' then array['areaId','deliveryDate','priceMinor','active']
 when 'service_day' then array['deliveryDate','departureTime','capacity','maxDurationSeconds','enabled']
 when 'shipment' then array['status','priceMinor','deliveryDate'] else array[]::text[] end);
$$;

create function public.shipping_mutate(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m text:=p_payload->>'merchantId'; md text:=p_payload->>'mode';
 actor uuid; q shipping.quotes; r shipping.routes; s shipping.shipments;
 c shipping.checkout_sessions; d shipping.service_days; previous shipping.idempotency_keys;
 result jsonb; item jsonb; entity_id text; v integer; affected integer; next_position integer; candidate jsonb; stop jsonb;
 audit_type text; audit_id text; before_values jsonb:='{}'::jsonb; after_values jsonb;
begin
 if md not in ('demo','live') or md is null then raise sqlstate 'PT400' using message='mode_invalid'; end if;
 if not exists(select 1 from shipping.merchants where id=m) then raise sqlstate 'PT404' using message='merchant_not_found'; end if;
 -- Opportunistic purge backs up the daily trusted maintenance job.
 update shipping.quotes set data=jsonb_build_object('purged',true) where merchant_id=m and mode=md and expires_at<now() and data<>'{"purged":true}'::jsonb;
 if p_operation in ('confirm','cancel','settings_save','promotion_save','service_day_save','price_save','external_create','external_replay') and not (p_operation='confirm' and coalesce(p_payload->'serverAuthorized'='true'::jsonb,false)) then
   begin actor:=(p_payload->>'actorId')::uuid; exception when invalid_text_representation then actor:=null; end;
   if actor is null or public.shipping_admin_context(actor,m) is null then raise sqlstate 'PT403' using message='admin_forbidden'; end if;
   -- Serializes versioned admin edits for the merchant/mode.
   perform pg_advisory_xact_lock(hashtextextended(m||':'||md||':admin',0));
 end if;
 if p_operation in ('external_create','external_replay') then
   if coalesce(p_payload->>'idempotencyKey','')='' or coalesce(p_payload->>'bodyHash','')='' then raise sqlstate 'PT400' using message='idempotency_required'; end if;
   perform pg_advisory_xact_lock(hashtextextended(m||':'||md||':external_create:'||(p_payload->>'idempotencyKey'),0));
   select * into previous from shipping.idempotency_keys where merchant_id=m and mode=md and operation='external_create' and key=p_payload->>'idempotencyKey';
   if previous.key is not null then
     if previous.body_hash<>p_payload->>'bodyHash' then raise sqlstate 'PT409' using message='idempotency_conflict'; end if;
     return previous.response;
   end if;
   if p_operation='external_replay' then return null; end if;
 end if;
 if p_operation='checkout_create' then
   entity_id:=coalesce(p_payload->>'id',gen_random_uuid()::text);
   if p_payload->>'currency'<>'UYU' or jsonb_array_length(p_payload->'cart')<1 or (p_payload->>'expiresAt')::timestamptz<=now() then raise sqlstate 'PT400' using message='checkout_invalid'; end if;
   insert into shipping.checkout_sessions values(entity_id,m,md,p_payload->'cart',(p_payload->>'subtotalMinor')::bigint,'UYU',least((p_payload->>'expiresAt')::timestamptz,now()+interval '24 hours')) returning * into c;
   return jsonb_build_object('id',c.id,'cart',c.cart,'subtotalMinor',c.subtotal_minor,'currency',c.currency,'expiresAt',c.expires_at);
 elsif p_operation='quote_create' then
   select * into c from shipping.checkout_sessions where merchant_id=m and mode=md and id=p_payload->>'checkoutId';
   if c.id is null or c.expires_at<=now() then raise sqlstate 'PT410' using message='checkout_expired'; end if;
   if p_payload->>'currency'<>'UYU' or (p_payload->>'expiresAt')::timestamptz<=now() or (p_payload->>'priceMinor')::bigint<coalesce((p_payload->>'safetyFloorMinor')::bigint,1) then raise sqlstate 'PT400' using message='quote_invalid'; end if;
   select * into d from shipping.service_days where merchant_id=m and mode=md and delivery_date=(p_payload->>'deliveryDate')::date for share;
   if d.delivery_date is null or not d.enabled or coalesce((p_payload->>'dayVersion')::integer,case when md='demo' then 1 end) is distinct from d.version then raise sqlstate 'PT409' using message='service_day_changed'; end if;
   entity_id:=coalesce(p_payload->>'id',gen_random_uuid()::text);
   insert into shipping.quotes values(entity_id,m,md,c.id,p_payload->>'routeId',(p_payload->>'routeVersion')::integer,d.version,(p_payload->>'deliveryDate')::date,(p_payload->>'priceMinor')::bigint,'UYU',least((p_payload->>'expiresAt')::timestamptz,now()+interval '5 minutes'),(p_payload-'actorId')||jsonb_build_object('dayVersion',d.version)) returning * into q;
   return q.data||jsonb_build_object('id',q.id,'expiresAt',q.expires_at);
 elsif p_operation='reserve' then
   perform pg_advisory_xact_lock(hashtextextended(m||':'||md||':admin',0));
   if coalesce(p_payload->>'idempotencyKey','')='' or coalesce(p_payload->>'bodyHash','')='' then raise sqlstate 'PT400' using message='idempotency_required'; end if;
   perform pg_advisory_xact_lock(hashtextextended(m||':'||md||':reserve:'||(p_payload->>'idempotencyKey'),0));
   select * into previous from shipping.idempotency_keys where merchant_id=m and mode=md and operation=p_operation and key=p_payload->>'idempotencyKey';
   if previous.key is not null then
     if previous.body_hash<>p_payload->>'bodyHash' then raise sqlstate 'PT409' using message='idempotency_conflict'; end if;
     return previous.response;
   end if;
   select * into q from shipping.quotes where merchant_id=m and mode=md and id=p_payload->>'quoteId';
   select * into c from shipping.checkout_sessions where merchant_id=m and mode=md and id=p_payload->>'checkoutId';
   if q.id is null or c.id is null or q.checkout_id<>c.id then raise sqlstate 'PT404' using message='quote_not_found'; end if;
   if q.data ? 'policyVersion' and (q.data->>'policyVersion')::integer is distinct from (select max(version) from shipping.rate_policies where merchant_id=m and mode=md) then raise sqlstate 'PT409' using message='policy_changed'; end if;
   if q.expires_at<=now() or c.expires_at<=now() then raise sqlstate 'PT410' using message='quote_expired'; end if;
   select * into d from shipping.service_days where merchant_id=m and mode=md and delivery_date=q.delivery_date for update;
   if d.delivery_date is null or not d.enabled or d.delivery_date<(now() at time zone 'America/Montevideo')::date then raise sqlstate 'PT409' using message='service_day_unavailable'; end if;
   if q.day_version<>d.version then raise sqlstate 'PT409' using message='service_day_changed'; end if;
   if q.route_id is null then
     insert into shipping.routes(merchant_id,mode,delivery_date,departure_at,capacity,max_duration_seconds) values(m,md,q.delivery_date,(q.delivery_date+d.departure_time) at time zone 'America/Montevideo',d.capacity,d.max_duration_seconds) on conflict(merchant_id,mode,delivery_date) do nothing;
     select * into r from shipping.routes where merchant_id=m and mode=md and delivery_date=q.delivery_date for update;
   else select * into r from shipping.routes where merchant_id=m and mode=md and id=q.route_id for update; end if;
   if r.id is null or r.delivery_date<>q.delivery_date then raise sqlstate 'PT409' using message='route_changed'; end if;
   if r.departure_at<=clock_timestamp() then raise sqlstate 'PT409' using message='route_departed'; end if;
   if q.expires_at<=clock_timestamp() or c.expires_at<=clock_timestamp() then raise sqlstate 'PT410' using message='quote_expired'; end if;
   update shipping.shipments set status='expired' where merchant_id=m and mode=md and route_id=r.id and status='held' and held_until<=now();
   get diagnostics affected=row_count;
   delete from shipping.route_stops st using shipping.shipments sh where st.merchant_id=m and st.mode=md and st.route_id=r.id and sh.merchant_id=st.merchant_id and sh.mode=st.mode and sh.id=st.shipment_id and sh.status='expired';
   if affected>0 then update shipping.routes set version=version+1 where merchant_id=m and mode=md and id=r.id returning * into r; end if;
   if r.version is distinct from (p_payload->>'expectedVersion')::integer or r.version<>q.route_version then raise sqlstate 'PT409' using message='route_changed'; end if;
   if (select count(*) from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id)>=least(r.capacity,d.capacity,10) then raise sqlstate 'PT409' using message='route_full'; end if;
   if exists(select 1 from shipping.shipments where merchant_id=m and mode=md and (quote_id=q.id or checkout_id=c.id)) then raise sqlstate 'PT409' using message='checkout_reserved'; end if;
   insert into shipping.shipments(merchant_id,mode,quote_id,checkout_id,route_id,status,price_minor,held_until,data) values(m,md,q.id,c.id,r.id,'held',q.price_minor,clock_timestamp()+interval '15 minutes',jsonb_build_object('deliveryDate',q.delivery_date,'address',(q.data->'address')-'formattedAddress'-'geometry','normalPriceMinor',q.data->'normalPriceMinor','promotionId',q.data->'promotionId')) returning * into s;
   candidate:=q.data->'candidateRoute'->'stops';
   if candidate is not null and exists(select 1 from jsonb_array_elements(candidate) entry where entry->'shipmentId'='null'::jsonb) then
     if jsonb_array_length(candidate)<>(select count(*)+1 from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id) or
        (select count(*) from jsonb_array_elements(candidate) entry where entry->'shipmentId'='null'::jsonb)<>1 or
        exists(select 1 from shipping.route_stops st where st.merchant_id=m and st.mode=md and st.route_id=r.id and not exists(select 1 from jsonb_array_elements(candidate) entry where entry->>'shipmentId'=st.shipment_id)) then raise sqlstate 'PT409' using message='route_changed'; end if;
     update shipping.route_stops set position=position+1000 where merchant_id=m and mode=md and route_id=r.id;
     next_position:=0;
     for stop in select value from jsonb_array_elements(candidate) loop
       next_position:=next_position+1;
       if stop->'shipmentId'='null'::jsonb then insert into shipping.route_stops values(m,md,r.id,s.id,next_position,q.data->'address'->>'placeId',coalesce(q.data->>'label','Entrega'));
       else update shipping.route_stops set position=next_position where merchant_id=m and mode=md and route_id=r.id and shipment_id=stop->>'shipmentId'; end if;
     end loop;
   else
     select coalesce(max(position),0)+1 into next_position from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id;
     insert into shipping.route_stops values(m,md,r.id,s.id,next_position,q.data->'address'->>'placeId',coalesce(q.data->>'label','Entrega'));
   end if;
   update shipping.routes set version=version+1 where merchant_id=m and mode=md and id=r.id;
   result:=shipping.shipment_json(s);
   insert into shipping.idempotency_keys values(m,md,p_operation,p_payload->>'idempotencyKey',p_payload->>'bodyHash',result,now());
   insert into shipping.audit_events(merchant_id,mode,actor,operation,entity_type,entity_id,data) values(m,md,'checkout-buyer',p_operation,'shipment',s.id,jsonb_build_object('before','{}'::jsonb,'after',shipping.audit_values('shipment',result)));
   return result;
 elsif p_operation in ('demo_confirm','confirm','cancel') then
   select * into s from shipping.shipments where merchant_id=m and mode=md and id=p_payload->>'shipmentId';
   if s.id is null then raise sqlstate 'PT404' using message='shipment_not_found'; end if;
   select * into r from shipping.routes where merchant_id=m and mode=md and id=s.route_id for update;
   select * into s from shipping.shipments where merchant_id=m and mode=md and id=s.id for update;
   if p_operation='demo_confirm' and (md<>'demo' or p_payload->>'checkoutId' is distinct from s.checkout_id) then raise sqlstate 'PT403' using message='demo_forbidden'; end if;
   if p_operation='cancel' and (jsonb_typeof(p_payload->'reason') is distinct from 'string' or coalesce(length(btrim(p_payload->>'reason')),0)<3 or length(p_payload->>'reason')>300) then raise sqlstate 'PT400' using message='cancellation_invalid'; end if;
   if s.status='expired' or (s.status='held' and s.held_until<=clock_timestamp()) then raise sqlstate 'PT410' using message='reservation_expired'; end if;
   entity_id:=case when p_operation='cancel' then 'cancelled' else 'confirmed' end;
   if s.status=entity_id then return shipping.shipment_json(s); end if;
   if s.status not in ('held','confirmed') or (s.status='confirmed' and entity_id='confirmed') then raise sqlstate 'PT409' using message='transition_invalid'; end if;
   audit_type:='shipment'; audit_id:=s.id; before_values:=jsonb_build_object('status',s.status);
   update shipping.shipments set status=entity_id,data=data||case when p_operation='demo_confirm' then '{"demo":true}'::jsonb when p_operation='cancel' then jsonb_build_object('cancellationReason',btrim(p_payload->>'reason'),'cancelledBy',actor::text,'cancelledAt',clock_timestamp()) else '{}'::jsonb end where merchant_id=m and mode=md and id=s.id returning * into s;
   after_values:=jsonb_build_object('status',s.status);
   if entity_id='cancelled' then delete from shipping.route_stops where merchant_id=m and mode=md and shipment_id=s.id; end if;
   update shipping.routes set version=version+1 where merchant_id=m and mode=md and id=r.id;
   result:=shipping.shipment_json(s);
 elsif p_operation='settings_save' then
   select coalesce(max(version),0)+1 into v from shipping.rate_policies where merchant_id=m and mode=md;
   select data into item from shipping.rate_policies where merchant_id=m and mode=md order by version desc limit 1;
   audit_type:='rate_policy'; audit_id:='current'; before_values:=shipping.audit_values(audit_type,item);
   item:=coalesce(item,'{}'::jsonb)||(p_payload->'policy');
   insert into shipping.rate_policies(merchant_id,mode,version,data) values(m,md,v,item);
   result:=item||jsonb_build_object('version',v);
 elsif p_operation='price_save' then
   audit_type:='product_price'; audit_id:=p_payload->>'productId';
   select coalesce(jsonb_build_object('priceMinor',price_minor),'{}'::jsonb) into before_values from shipping.product_prices where merchant_id=m and mode=md and product_id=audit_id;
   insert into shipping.product_prices values(m,md,p_payload->>'productId',(p_payload->>'priceMinor')::bigint,1) on conflict(merchant_id,mode,product_id) do update set price_minor=excluded.price_minor,version=shipping.product_prices.version+1;
   result:=jsonb_build_object('productId',p_payload->>'productId','priceMinor',(p_payload->>'priceMinor')::bigint);
 elsif p_operation='service_day_save' then
   item:=p_payload->'day';
   if (item->>'enabled')::boolean and (select count(*) from shipping.service_days where merchant_id=m and mode=md and enabled and delivery_date>=(now() at time zone 'America/Montevideo')::date and delivery_date<>(item->>'deliveryDate')::date)>=3 then raise sqlstate 'PT409' using message='service_day_limit'; end if;
   select * into d from shipping.service_days where merchant_id=m and mode=md and delivery_date=(item->>'deliveryDate')::date for update;
   audit_type:='service_day'; audit_id:=item->>'deliveryDate';
   if d.delivery_date is not null then before_values:=jsonb_build_object('deliveryDate',d.delivery_date,'departureTime',to_char(d.departure_time,'HH24:MI'),'capacity',d.capacity,'maxDurationSeconds',d.max_duration_seconds,'enabled',d.enabled); end if;
   select * into r from shipping.routes where merchant_id=m and mode=md and delivery_date=(item->>'deliveryDate')::date for update;
   if r.id is not null and d.departure_time is distinct from (item->>'departureTime')::time and exists(select 1 from shipping.shipments where merchant_id=m and mode=md and route_id=r.id and (status='confirmed' or (status='held' and held_until>clock_timestamp()))) then raise sqlstate 'PT409' using message='assigned_departure_immutable'; end if;
   insert into shipping.service_days(merchant_id,mode,delivery_date,enabled,departure_time,capacity,max_duration_seconds) values(m,md,(item->>'deliveryDate')::date,(item->>'enabled')::boolean,(item->>'departureTime')::time,(item->>'capacity')::integer,(item->>'maxDurationSeconds')::integer) on conflict(merchant_id,mode,delivery_date) do update set enabled=excluded.enabled,departure_time=excluded.departure_time,capacity=excluded.capacity,max_duration_seconds=excluded.max_duration_seconds,version=shipping.service_days.version+1 returning * into d;
   if r.id is not null and not exists(select 1 from shipping.shipments where merchant_id=m and mode=md and route_id=r.id and (status='confirmed' or (status='held' and held_until>clock_timestamp()))) then update shipping.routes set departure_at=(d.delivery_date+d.departure_time) at time zone 'America/Montevideo',capacity=d.capacity,max_duration_seconds=d.max_duration_seconds,version=version+1 where merchant_id=m and mode=md and id=r.id; end if;
   result:=item||jsonb_build_object('version',d.version);
 elsif p_operation='promotion_save' then
   item:=p_payload->'promotion'; entity_id:=coalesce(item->>'id',gen_random_uuid()::text);
   audit_type:='promotion'; audit_id:=entity_id;
   select jsonb_build_object('areaId',area_id,'deliveryDate',delivery_date,'priceMinor',price_minor,'active',active) into before_values from shipping.promotions where merchant_id=m and mode=md and id=entity_id;
   insert into shipping.promotions values(entity_id,m,md,item->>'areaId',(item->>'deliveryDate')::date,(item->>'priceMinor')::bigint,(item->>'active')::boolean,1) on conflict(merchant_id,mode,id) do update set area_id=excluded.area_id,delivery_date=excluded.delivery_date,price_minor=excluded.price_minor,active=excluded.active,version=shipping.promotions.version+1 returning version into v;
   result:=item||jsonb_build_object('id',entity_id,'version',v);
 elsif p_operation='external_create' then
   if p_payload ? 'expectedPolicyVersion' and (p_payload->>'expectedPolicyVersion')::integer is distinct from (select max(version) from shipping.rate_policies where merchant_id=m and mode=md) then raise sqlstate 'PT409' using message='policy_changed'; end if;
   item:=p_payload->'shipment';
   select * into d from shipping.service_days where merchant_id=m and mode=md and delivery_date=coalesce(p_payload->'candidateRoute'->>'deliveryDate',item->>'deliveryDate')::date for update;
   if d.delivery_date is null or not d.enabled or d.delivery_date<(now() at time zone 'America/Montevideo')::date then raise sqlstate 'PT409' using message='service_day_unavailable'; end if;
   if coalesce((p_payload->>'expectedDayVersion')::integer,case when md='demo' then 1 end) is distinct from d.version then raise sqlstate 'PT409' using message='service_day_changed'; end if;
   if p_payload->>'routeId' is null then
     insert into shipping.routes(merchant_id,mode,delivery_date,departure_at,capacity,max_duration_seconds) values(m,md,d.delivery_date,(d.delivery_date+d.departure_time) at time zone 'America/Montevideo',d.capacity,d.max_duration_seconds) on conflict(merchant_id,mode,delivery_date) do nothing;
     select * into r from shipping.routes where merchant_id=m and mode=md and delivery_date=d.delivery_date for update;
   else select * into r from shipping.routes where merchant_id=m and mode=md and id=p_payload->>'routeId' for update; end if;
   if r.id is null or r.version is distinct from (p_payload->>'expectedVersion')::integer then raise sqlstate 'PT409' using message='route_changed'; end if;
   if r.delivery_date<>d.delivery_date then raise sqlstate 'PT409' using message='route_changed'; end if;
   if r.departure_at<=clock_timestamp() then raise sqlstate 'PT409' using message='route_departed'; end if;
   if (select count(*) from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id)>=least(r.capacity,d.capacity,10) then raise sqlstate 'PT409' using message='route_full'; end if;
   if coalesce(item->>'externalOrderRef','')='' then raise sqlstate 'PT400' using message='external_reference_required'; end if;
   insert into shipping.shipments(merchant_id,mode,route_id,status,price_minor,external_order_ref,data) values(m,md,r.id,'confirmed',(item->>'priceMinor')::bigint,item->>'externalOrderRef',jsonb_build_object('address',(item->'address')-'formattedAddress'-'geometry','externalOrderRef',item->>'externalOrderRef','deliveryDate',r.delivery_date)) returning * into s;
   candidate:=p_payload->'candidateRoute'->'stops';
   if candidate is not null and exists(select 1 from jsonb_array_elements(candidate) entry where entry->'shipmentId'='null'::jsonb) then
     if jsonb_array_length(candidate)<>(select count(*)+1 from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id) or
        (select count(*) from jsonb_array_elements(candidate) entry where entry->'shipmentId'='null'::jsonb)<>1 or
        exists(select 1 from shipping.route_stops st where st.merchant_id=m and st.mode=md and st.route_id=r.id and not exists(select 1 from jsonb_array_elements(candidate) entry where entry->>'shipmentId'=st.shipment_id)) then raise sqlstate 'PT409' using message='route_changed'; end if;
     update shipping.route_stops set position=position+1000 where merchant_id=m and mode=md and route_id=r.id;
     next_position:=0;
     for stop in select value from jsonb_array_elements(candidate) loop
       next_position:=next_position+1;
       if stop->'shipmentId'='null'::jsonb then insert into shipping.route_stops values(m,md,r.id,s.id,next_position,item->'address'->>'placeId',coalesce(item->>'label','Entrega externa'));
       else update shipping.route_stops set position=next_position where merchant_id=m and mode=md and route_id=r.id and shipment_id=stop->>'shipmentId'; end if;
     end loop;
   else
     select coalesce(max(position),0)+1 into next_position from shipping.route_stops where merchant_id=m and mode=md and route_id=r.id;
     insert into shipping.route_stops values(m,md,r.id,s.id,next_position,item->'address'->>'placeId',coalesce(item->>'label','Entrega externa'));
   end if;
   update shipping.routes set version=version+1 where merchant_id=m and mode=md and id=r.id;
   result:=shipping.shipment_json(s);
   audit_type:='shipment'; audit_id:=s.id;
   insert into shipping.idempotency_keys values(m,md,'external_create',p_payload->>'idempotencyKey',p_payload->>'bodyHash',result,clock_timestamp());
 else raise sqlstate 'PT400' using message='operation_unknown';
 end if;
 if audit_type is not null then
   insert into shipping.audit_events(merchant_id,mode,actor_id,actor,operation,entity_type,entity_id,data)
   values(m,md,actor,case when p_operation='confirm' and p_payload->'serverAuthorized'='true'::jsonb then 'commerce-server' else coalesce(actor::text,'demo-buyer') end,p_operation,audit_type,audit_id,jsonb_build_object('before',coalesce(before_values,'{}'::jsonb),'after',coalesce(after_values,shipping.audit_values(audit_type,result))));
 end if;
 return result;
exception when unique_violation then raise sqlstate 'PT409' using message='shipping_conflict';
 when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow then raise sqlstate 'PT400' using message='shipping_invalid';
end $$;

-- Operational cleanup removes temporary Google quote metadata without touching
-- the immutable price accepted by the customer. Call daily from a trusted job.
create function shipping.purge_quote_metadata() returns integer language plpgsql security definer set search_path='' as $$
declare affected integer; begin
 update shipping.quotes set data=jsonb_build_object('purged',true) where expires_at<now() and data<>'{"purged":true}'::jsonb;
 get diagnostics affected=row_count; return affected;
end $$;
revoke all on all functions in schema shipping from public,anon,authenticated;
revoke all on function public.shipping_snapshot(text,text), public.shipping_mutate(text,jsonb), public.shipping_admin_context(uuid,text) from public,anon,authenticated;
grant execute on function public.shipping_snapshot(text,text), public.shipping_mutate(text,jsonb), public.shipping_admin_context(uuid,text) to service_role;
grant usage on schema shipping to service_role;
grant execute on function shipping.purge_quote_metadata() to service_role;
commit;
