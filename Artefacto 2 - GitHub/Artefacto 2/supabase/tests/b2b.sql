-- Isolated database only; fixtures always roll back. Apply all migrations first.
begin;
do $$
declare m text:='b2b-'||gen_random_uuid()::text; actor uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid();
 d date:=(clock_timestamp() at time zone 'America/Montevideo')::date+1;
 scope jsonb; rule jsonb; win jsonb; state jsonb; accepted jsonb; payload jsonb; version integer; c text; q text;
begin
 insert into auth.users(id) values(actor),(stranger);
 insert into shipping.merchants(id,name) values(m,'Independent commerce');
 insert into shipping.admin_members(merchant_id,user_id,role) values(m,actor,'admin');
 insert into shipping.rate_policies(merchant_id,mode,version,data) values(m,'demo',1,'{"minimumMinor":14900,"fuelPriceMinorPerLiter":9045,"fuelLitersPer100Km":3,"laborMinorPerHour":25000,"serviceMinutes":5,"marginBps":1500,"roundingMinor":100,"quoteMinutes":5,"holdMinutes":15}');
 scope:=jsonb_build_object('merchantId',m,'mode','demo','actorId',actor);
 rule:='{"areaId":"*","enabled":true,"tiers":[{"minOrders":1,"type":"fixed","value":5000},{"minOrders":2,"type":"percent","value":4000}]}';
 begin perform public.shipping_mutate('discount_rule_save',scope||jsonb_build_object('actorId',stranger,'rule',rule));raise exception 'foreign member accepted';exception when sqlstate 'PT403' then null;end;
 perform public.shipping_mutate('discount_rule_save',scope||jsonb_build_object('rule',rule));
 win:=jsonb_build_object('id','am','deliveryDate',d,'startTime','10:00','endTime','13:00','capacity',1,'enabled',true);
 perform public.shipping_mutate('delivery_window_save',scope||jsonb_build_object('window',win));
 begin perform public.shipping_mutate('delivery_window_save',scope||jsonb_build_object('window',win||'{"id":"overlap","startTime":"12:00","endTime":"14:00"}'));raise exception 'overlap accepted';exception when sqlstate 'PT409' then null;end;
 perform public.shipping_mutate('delivery_window_save',scope||jsonb_build_object('window',win||'{"id":"pm","startTime":"14:00","endTime":"18:00","capacity":12}'));
 state:=public.shipping_snapshot(m,'demo');
 if state->>'b2bVersion'<>'1' or jsonb_array_length(state->'windows')<>2 or jsonb_array_length(state->'discountRules')<>1 then raise exception 'B2B snapshot missing';end if;
 version:=(state->'policy'->>'version')::integer;
 for i in 1..2 loop
  c:='checkout-'||i;q:='quote-'||i;
  perform public.shipping_mutate('checkout_create',scope||jsonb_build_object('id',c,'cart','[{}]'::jsonb,'subtotalMinor',1000,'currency','UYU','expiresAt',clock_timestamp()+interval '1 hour'));
  perform public.shipping_mutate('quote_create',scope||jsonb_build_object('id',q,'checkoutId',c,'routeVersion',0,'dayVersion',1,'policyVersion',version,'windowId','am','windowStart','10:00','windowEnd','13:00','deliveryDate',d,'priceMinor',24900,'normalPriceMinor',24900,'safetyFloorMinor',14900,'currency','UYU','expiresAt',clock_timestamp()+interval '5 minutes','address','{"provider":"zones","areaId":"centro","placeId":"zone:centro"}'::jsonb));
 end loop;
 payload:=(scope-'actorId')||'{"checkoutId":"checkout-1","quoteId":"quote-1","expectedVersion":0,"idempotencyKey":"one","bodyHash":"one"}';
 accepted:=public.shipping_mutate('reserve',payload);
 if accepted->>'windowId'<>'am' or accepted->>'windowStart'<>'10:00' then raise exception 'accepted window missing';end if;
 begin perform public.shipping_mutate('reserve',(scope-'actorId')||'{"checkoutId":"checkout-2","quoteId":"quote-2","expectedVersion":0,"idempotencyKey":"two","bodyHash":"two"}');raise exception 'oversold last place';exception when sqlstate 'PT409' then null;end;
 begin perform public.shipping_mutate('delivery_window_save',scope||jsonb_build_object('window',win||'{"startTime":"09:00"}'));raise exception 'assigned time changed';exception when sqlstate 'PT409' then null;end;
 perform public.shipping_mutate('discount_rule_save',scope||jsonb_build_object('rule',rule||'{"enabled":false}'));
 if public.shipping_mutate('reserve',payload)<>accepted then raise exception 'accepted price replay changed';end if;
 perform public.shipping_mutate('delivery_window_save',scope||jsonb_build_object('window',win||'{"enabled":false}'));
 perform public.shipping_mutate('demo_confirm',(scope-'actorId')||jsonb_build_object('shipmentId',accepted->>'id','checkoutId','checkout-1'));
 state:=public.shipping_snapshot(m,'demo');
 if state->'routes'->0->>'windowId'<>'am' or state->'routes'->0->'stops'->0->>'status'<>'confirmed' then raise exception 'confirmed occupancy missing';end if;
 -- Withdrawn offers must invalidate unaccepted quotes, not accepted responses.
 perform public.shipping_mutate('promotion_save',scope||jsonb_build_object('promotion',jsonb_build_object('id','withdrawn','areaId','centro','deliveryDate',d,'priceMinor',14900,'active',true)));
 version:=(public.shipping_snapshot(m,'demo')->'policy'->>'version')::integer;
 perform public.shipping_mutate('checkout_create',scope||jsonb_build_object('id','offer-c','cart','[{}]'::jsonb,'subtotalMinor',1000,'currency','UYU','expiresAt',clock_timestamp()+interval '1 hour'));
 perform public.shipping_mutate('quote_create',scope||jsonb_build_object('id','offer-q','checkoutId','offer-c','routeVersion',0,'dayVersion',1,'policyVersion',version,'windowId','pm','deliveryDate',d,'priceMinor',14900,'currency','UYU','expiresAt',clock_timestamp()+interval '5 minutes','address','{"provider":"zones","areaId":"centro","placeId":"zone:centro"}'::jsonb));
 perform public.shipping_mutate('promotion_save',scope||jsonb_build_object('promotion',jsonb_build_object('id','withdrawn','areaId','centro','deliveryDate',d,'priceMinor',14900,'active',false)));
 begin perform public.shipping_mutate('reserve',(scope-'actorId')||'{"checkoutId":"offer-c","quoteId":"offer-q","expectedVersion":0,"idempotencyKey":"withdrawn","bodyHash":"withdrawn"}');raise exception 'withdrawn offer quote accepted';exception when sqlstate 'PT409' then null;end;
 if public.shipping_mutate('reserve',payload)<>accepted then raise exception 'offer edit changed accepted replay';end if;
 if not (select relrowsecurity from pg_class where oid='shipping.discount_rules'::regclass) or not (select relrowsecurity from pg_class where oid='shipping.delivery_windows'::regclass) then raise exception 'RLS missing';end if;
 if has_function_privilege('service_role','public.shipping_mutate_v2(text,jsonb)','EXECUTE') or has_function_privilege('anon','public.shipping_mutate(text,jsonb)','EXECUTE') then raise exception 'RPC bypass';end if;
end $$;
rollback;
