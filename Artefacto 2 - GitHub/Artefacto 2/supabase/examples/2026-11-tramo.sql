-- Datos ficticios para la tienda de ejemplo MAREA. Importes en centésimos de UYU.
-- Requiere las tres migraciones. Es seguro volver a ejecutar este archivo:
-- conserva los registros existentes y no restablece cambios hechos desde TRAMO.
-- Revisión 2: demanda variable y escalones iniciales de 3, 5 y 15 pedidos.
-- La regla anterior de ejemplo (1/2 pedidos) se actualiza sólo si sigue intacta.
begin;
set local statement_timeout = '45s';
select pg_advisory_xact_lock(hashtextextended('marea:live:admin',0));
do $examples$
declare
 dataset constant text := 'TRAMO-TEST-2026-11';
 areas constant text[] := array['centro','pocitos','malvin','buceo','cordon','carrasco','dept-canelones','dept-maldonado'];
 demand_pattern constant integer[] := array[0,3,0,0,0,5,0,0,0,15,0,0,0,8,0,0,0,0];
 day_value date; period integer; area_index integer; example_index integer; demand integer;
 start_value time; end_value time; window_key text; route_key text; shipment_key text; reference text;
 area_name text; department text; base_amount bigint; minimum_amount bigint; new_rows integer;
 inserted_shipments integer := 0; inserted_windows integer := 0; changed boolean := false;
 current_policy shipping.rate_policies; window_row shipping.delivery_windows; position_value integer; occupied integer;
begin
 if not exists(select 1 from shipping.merchants where id='marea') then raise exception 'Falta el comercio marea';end if;
 select * into current_policy from shipping.rate_policies where merchant_id='marea' and mode='live' order by version desc limit 1;
 if current_policy.version is null then raise exception 'Falta la configuración de precios del comercio';end if;
 minimum_amount := (current_policy.data->>'minimumMinor')::bigint;
 insert into shipping.discount_rules(merchant_id,mode,area_id,enabled,tiers)
 values('marea','live','*',true,'[{"minOrders":3,"type":"fixed","value":3000},{"minOrders":5,"type":"fixed","value":6000},{"minOrders":15,"type":"fixed","value":10000}]')
 on conflict do nothing;
 get diagnostics new_rows = row_count; changed := new_rows>0;
 update shipping.discount_rules set tiers='[{"minOrders":3,"type":"fixed","value":3000},{"minOrders":5,"type":"fixed","value":6000},{"minOrders":15,"type":"fixed","value":10000}]',version=version+1
 where merchant_id='marea' and mode='live' and area_id='*' and enabled
  and tiers='[{"minOrders":1,"type":"fixed","value":5000},{"minOrders":2,"type":"fixed","value":10000}]'::jsonb;
 get diagnostics new_rows = row_count; changed := changed or new_rows>0;

 for day_value in select generate_series(date '2026-11-01',date '2026-11-30',interval '1 day')::date loop
  insert into shipping.service_days(merchant_id,mode,delivery_date,enabled)
  values('marea','live',day_value,true) on conflict do nothing;
  -- Mantener las salidas anteriores que ya tienen entregas asignadas.
  if exists(select 1 from shipping.routes r join shipping.route_stops st
   on st.merchant_id=r.merchant_id and st.mode=r.mode and st.route_id=r.id
   where r.merchant_id='marea' and r.mode='live' and r.delivery_date=day_value and r.window_id is null) then continue;end if;
  for period in 0..1 loop
   start_value := case when period=0 then time '10:00' else time '14:00' end;
   end_value := case when period=0 then time '13:00' else time '18:00' end;
   window_key := 'tramo-nov26-'||to_char(day_value,'YYYYMMDD')||case when period=0 then '-am' else '-pm' end;
   route_key := 'route-'||window_key;
   if exists(select 1 from shipping.delivery_windows w where w.merchant_id='marea' and w.mode='live'
    and w.delivery_date=day_value and w.id<>window_key and w.enabled and start_value<w.end_time and end_value>w.start_time) then
    raise notice 'Se conserva la franja existente que se superpone al ejemplo %.',window_key;
    continue;
   end if;
   insert into shipping.delivery_windows(merchant_id,mode,id,delivery_date,start_time,end_time,capacity,enabled)
   values('marea','live',window_key,day_value,start_value,end_value,40,(day_value+start_value) at time zone 'America/Montevideo'>clock_timestamp())
   on conflict do nothing;
   get diagnostics new_rows = row_count;
   inserted_windows := inserted_windows+new_rows; changed := changed or new_rows>0;
   select * into window_row from shipping.delivery_windows where merchant_id='marea' and mode='live' and id=window_key;
   if window_row.delivery_date<>day_value or window_row.start_time<>start_value or window_row.end_time<>end_value then
    raise notice 'La franja de ejemplo % fue modificada. Se conserva su configuración y se omite este ejemplo.',window_key;
    continue;
   end if;
   if not window_row.enabled and day_value>=(now() at time zone 'America/Montevideo')::date then continue;end if;
   insert into shipping.routes(id,merchant_id,mode,delivery_date,departure_at,capacity,max_duration_seconds,window_id)
   values(route_key,'marea','live',day_value,(day_value+start_value) at time zone 'America/Montevideo',window_row.capacity,14400,window_key)
   on conflict do nothing;
   select id into route_key from shipping.routes where merchant_id='marea' and mode='live' and window_id=window_key;
   for area_index in 1..array_length(areas,1) loop
    select n.name,coalesce(n.data->>'departmentId',case when n.id like 'dept-%' then substr(n.id,6) else 'montevideo' end),r.price_minor
    into area_name,department,base_amount from shipping.neighborhoods n join shipping.zone_rates r
     on r.merchant_id=n.merchant_id and r.area_id=n.id and r.mode='live' and r.enabled
    where n.merchant_id='marea' and n.id=areas[area_index];
    if area_name is null then raise exception 'Falta habilitar una tarifa para %',areas[area_index];end if;
    demand := demand_pattern[1+((extract(day from day_value)::integer*2+period+area_index-1)%array_length(demand_pattern,1))];
    if demand=0 then continue;end if;
    for example_index in 1..demand loop
     shipment_key := window_key||'-'||areas[area_index]||'-'||example_index;
     reference := dataset||':'||to_char(day_value,'YYYYMMDD')||':'||period||':'||areas[area_index]||':'||example_index;
     -- No duplicar ni reactivar pedidos de ejemplo que fueron cancelados.
     if exists(select 1 from shipping.shipments where merchant_id='marea' and mode='live' and id=shipment_key) then continue;end if;
     select count(*) into occupied from shipping.route_stops where merchant_id='marea' and mode='live' and route_id=route_key;
     if occupied>=least(window_row.capacity,(select capacity from shipping.routes where merchant_id='marea' and mode='live' and id=route_key)) then continue;end if;
     insert into shipping.shipments(id,merchant_id,mode,route_id,external_order_ref,status,price_minor,data,created_at)
     values(shipment_key,'marea','live',route_key,reference,
      case when day_value<(now() at time zone 'America/Montevideo')::date then 'completed' else 'confirmed' end,
      greatest(base_amount,minimum_amount),
      jsonb_build_object('exampleSet',dataset,'example',true,'exampleRevision',2,'externalOrderRef',reference,'deliveryDate',day_value,
       'windowId',window_key,'windowStart',to_char(start_value,'HH24:MI'),'windowEnd',to_char(end_value,'HH24:MI'),
       'address',jsonb_build_object('areaId',areas[area_index],'departmentId',department,'placeId','zone:'||areas[area_index],
        'provider','zones','confirmed',true,'inputAddress',area_name||', Uruguay','label',area_name||' · Ejemplo')),
      timestamptz '2026-10-31 15:00:00+00') on conflict do nothing;
     get diagnostics new_rows = row_count;
     if new_rows>0 then
      select coalesce(max(position),0)+1 into position_value from shipping.route_stops where merchant_id='marea' and mode='live' and route_id=route_key;
      insert into shipping.route_stops(merchant_id,mode,route_id,shipment_id,position,place_id,label)
      values('marea','live',route_key,shipment_key,position_value,'zone:'||areas[area_index],'Pedido ficticio · Noviembre 2026');
      update shipping.routes set version=version+1 where merchant_id='marea' and mode='live' and id=route_key;
      inserted_shipments := inserted_shipments+1; changed := true;
     end if;
    end loop;
   end loop;
  end loop;
 end loop;
 if changed then
  insert into shipping.rate_policies(merchant_id,mode,version,data)
  values('marea','live',current_policy.version+1,current_policy.data);
 end if;
 raise notice 'TRAMO: % franjas y % pedidos ficticios nuevos. Las zonas, precios y pedidos anteriores se conservaron.',inserted_windows,inserted_shipments;
end $examples$;
commit;
select 'TRAMO-TEST-2026-11' as conjunto,
 (select count(*) from shipping.service_days where merchant_id='marea' and mode='live' and delivery_date between '2026-11-01' and '2026-11-30') as dias_de_noviembre,
 (select count(*) from shipping.delivery_windows where merchant_id='marea' and mode='live' and id like 'tramo-nov26-%') as franjas,
 (select count(*) from shipping.shipments where merchant_id='marea' and mode='live' and data->>'exampleSet'='TRAMO-TEST-2026-11') as pedidos_ficticios;
