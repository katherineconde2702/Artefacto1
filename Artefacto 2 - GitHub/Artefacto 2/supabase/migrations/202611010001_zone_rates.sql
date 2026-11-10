-- Additive private zone pricing. No commercial or demo tariffs are installed.
-- Catalog mirrors public/store/uy-geography.js (IDE Uruguay, 62 barrios +18
-- interior departments, 2026-11-01). The original shipping migration is intact.
begin;

create or replace function shipping.zone_catalog()
returns table(id text,name text,department_id text,kind text,department_name text)
language sql immutable set search_path='' as $$ values
 ('aguada','Aguada','montevideo','neighborhood','Montevideo'),
 ('aires-puros','Aires Puros','montevideo','neighborhood','Montevideo'),
 ('dept-artigas','Artigas','artigas','department','Artigas'),
 ('atahualpa','Atahualpa','montevideo','neighborhood','Montevideo'),
 ('banados-de-carrasco','Bañados de Carrasco','montevideo','neighborhood','Montevideo'),
 ('barrio-sur','Barrio Sur','montevideo','neighborhood','Montevideo'),
 ('belvedere','Belvedere','montevideo','neighborhood','Montevideo'),
 ('brazo-oriental','Brazo Oriental','montevideo','neighborhood','Montevideo'),
 ('buceo','Buceo','montevideo','neighborhood','Montevideo'),
 ('dept-canelones','Canelones','canelones','department','Canelones'),
 ('capurro-bella-vista','Capurro Bella Vista','montevideo','neighborhood','Montevideo'),
 ('carrasco','Carrasco','montevideo','neighborhood','Montevideo'),
 ('carrasco-norte','Carrasco Norte','montevideo','neighborhood','Montevideo'),
 ('casabo-pajas-blancas','Casabó Pajas Blancas','montevideo','neighborhood','Montevideo'),
 ('casavalle','Casavalle','montevideo','neighborhood','Montevideo'),
 ('castro-castellanos','Castro Castellanos','montevideo','neighborhood','Montevideo'),
 ('centro','Centro','montevideo','neighborhood','Montevideo'),
 ('cerrito','Cerrito','montevideo','neighborhood','Montevideo'),
 ('cerro','Cerro','montevideo','neighborhood','Montevideo'),
 ('dept-cerro-largo','Cerro Largo','cerro-largo','department','Cerro Largo'),
 ('ciudad-vieja','Ciudad Vieja','montevideo','neighborhood','Montevideo'),
 ('colon-centro-y-noroeste','Colón Centro y Noroeste','montevideo','neighborhood','Montevideo'),
 ('colon-sureste-abayuba','Colón Sureste Abayubá','montevideo','neighborhood','Montevideo'),
 ('dept-colonia','Colonia','colonia','department','Colonia'),
 ('conciliacion','Conciliación','montevideo','neighborhood','Montevideo'),
 ('cordon','Cordón','montevideo','neighborhood','Montevideo'),
 ('dept-durazno','Durazno','durazno','department','Durazno'),
 ('figurita','Figurita','montevideo','neighborhood','Montevideo'),
 ('flor-de-maronas','Flor de Maroñas','montevideo','neighborhood','Montevideo'),
 ('dept-flores','Flores','flores','department','Flores'),
 ('dept-florida','Florida','florida','department','Florida'),
 ('ituzaingo','Ituzaingó','montevideo','neighborhood','Montevideo'),
 ('jacinto-vera','Jacinto Vera','montevideo','neighborhood','Montevideo'),
 ('jardines-del-hipodromo','Jardines del Hipódromo','montevideo','neighborhood','Montevideo'),
 ('la-blanqueada','La Blanqueada','montevideo','neighborhood','Montevideo'),
 ('la-comercial','La Comercial','montevideo','neighborhood','Montevideo'),
 ('la-paloma-tomkinson','La Paloma Tomkinson','montevideo','neighborhood','Montevideo'),
 ('la-teja','La Teja','montevideo','neighborhood','Montevideo'),
 ('larranaga','Larrañaga','montevideo','neighborhood','Montevideo'),
 ('las-acacias','Las Acacias','montevideo','neighborhood','Montevideo'),
 ('las-canteras','Las Canteras','montevideo','neighborhood','Montevideo'),
 ('dept-lavalleja','Lavalleja','lavalleja','department','Lavalleja'),
 ('lezica-melilla','Lezica Melilla','montevideo','neighborhood','Montevideo'),
 ('dept-maldonado','Maldonado','maldonado','department','Maldonado'),
 ('malvin','Malvín','montevideo','neighborhood','Montevideo'),
 ('malvin-norte','Malvín Norte','montevideo','neighborhood','Montevideo'),
 ('manga','Manga','montevideo','neighborhood','Montevideo'),
 ('manga-toledo-chico','Manga Toledo Chico','montevideo','neighborhood','Montevideo'),
 ('maronas-parque-guarani','Maroñas Parque Guaraní','montevideo','neighborhood','Montevideo'),
 ('mercado-modelo-y-bolivar','Mercado Modelo y Bolívar','montevideo','neighborhood','Montevideo'),
 ('nuevo-paris','Nuevo París','montevideo','neighborhood','Montevideo'),
 ('palermo','Palermo','montevideo','neighborhood','Montevideo'),
 ('parque-rodo','Parque Rodó','montevideo','neighborhood','Montevideo'),
 ('paso-de-la-arena','Paso de la Arena','montevideo','neighborhood','Montevideo'),
 ('paso-de-las-duranas','Paso de las Duranas','montevideo','neighborhood','Montevideo'),
 ('dept-paysandu','Paysandú','paysandu','department','Paysandú'),
 ('penarol-lavalleja','Peñarol Lavalleja','montevideo','neighborhood','Montevideo'),
 ('piedras-blancas','Piedras Blancas','montevideo','neighborhood','Montevideo'),
 ('pocitos','Pocitos','montevideo','neighborhood','Montevideo'),
 ('pque-batlle-villa-dolores','Pque Batlle Villa Dolores','montevideo','neighborhood','Montevideo'),
 ('prado-nueva-savona','Prado Nueva Savona','montevideo','neighborhood','Montevideo'),
 ('punta-carretas','Punta Carretas','montevideo','neighborhood','Montevideo'),
 ('punta-gorda','Punta Gorda','montevideo','neighborhood','Montevideo'),
 ('punta-rieles-bella-italia','Punta Rieles Bella Italia','montevideo','neighborhood','Montevideo'),
 ('reducto','Reducto','montevideo','neighborhood','Montevideo'),
 ('dept-rio-negro','Río Negro','rio-negro','department','Río Negro'),
 ('dept-rivera','Rivera','rivera','department','Rivera'),
 ('dept-rocha','Rocha','rocha','department','Rocha'),
 ('dept-salto','Salto','salto','department','Salto'),
 ('dept-san-jose','San José','san-jose','department','San José'),
 ('sayago','Sayago','montevideo','neighborhood','Montevideo'),
 ('dept-soriano','Soriano','soriano','department','Soriano'),
 ('dept-tacuarembo','Tacuarembó','tacuarembo','department','Tacuarembó'),
 ('dept-treinta-y-tres','Treinta y Tres','treinta-y-tres','department','Treinta y Tres'),
 ('tres-cruces','Tres Cruces','montevideo','neighborhood','Montevideo'),
 ('tres-ombues-pblo-victoria','Tres Ombúes Pblo Victoria','montevideo','neighborhood','Montevideo'),
 ('union','Unión','montevideo','neighborhood','Montevideo'),
 ('villa-espanola','Villa Española','montevideo','neighborhood','Montevideo'),
 ('villa-garcia-manga-rural','Villa García Manga Rural','montevideo','neighborhood','Montevideo'),
 ('villa-munoz-retiro','Villa Muñoz Retiro','montevideo','neighborhood','Montevideo');
$$;

-- Backfill existing merchants and initialize future merchants, including a
-- fresh reset whose seed creates marea only after migrations have completed.
create or replace function shipping.sync_zone_catalog(p_merchant_id text) returns void
language sql security definer set search_path='' as $$
 insert into shipping.neighborhoods(merchant_id,id,name,data)
 select p_merchant_id,z.id,z.name,jsonb_build_object('country','UY','city',z.department_name,'departmentId',z.department_id,'departmentName',z.department_name,'kind',z.kind)
 from shipping.zone_catalog() z
 on conflict(merchant_id,id) do update set name=excluded.name,data=shipping.neighborhoods.data||excluded.data;
$$;
create or replace function shipping.seed_merchant_zone_catalog() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform shipping.sync_zone_catalog(new.id); return new; end $$;
drop trigger if exists shipping_seed_zone_catalog on shipping.merchants;
create trigger shipping_seed_zone_catalog after insert on shipping.merchants for each row execute function shipping.seed_merchant_zone_catalog();
do $$ declare merchant record; begin
 for merchant in select id from shipping.merchants loop perform shipping.sync_zone_catalog(merchant.id); end loop;
end $$;

create table if not exists shipping.zone_rates (
 merchant_id text not null references shipping.merchants(id),
 mode text not null check(mode in ('demo','live')),
 area_id text not null,
 price_minor bigint not null check(price_minor>0 and price_minor<=1000000000),
 enabled boolean not null default false,
 version integer not null default 1 check(version>0),
 primary key(merchant_id,mode,area_id),
 foreign key(merchant_id,area_id) references shipping.neighborhoods(merchant_id,id)
);
alter table shipping.zone_rates enable row level security;
revoke all on table shipping.zone_rates from public,anon,authenticated,service_role;

-- The RPC also validates JSON types. This trigger defends private SQL writes
-- and shares the same lock order as settings, reservations and external orders.
-- A later minimum increase is allowed; quote calculation clamps older tariffs.
create or replace function shipping.guard_zone_rate() returns trigger
language plpgsql security definer set search_path='' as $$
declare minimum_minor numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.merchant_id||':'||new.mode||':admin',0));
 select (data->>'minimumMinor')::numeric into minimum_minor from shipping.rate_policies
 where merchant_id=new.merchant_id and mode=new.mode order by version desc limit 1;
 if minimum_minor is null or minimum_minor<=0 or new.price_minor is null or new.price_minor<minimum_minor or new.price_minor>1000000000 or
    not exists(select 1 from shipping.zone_catalog() z where z.id=new.area_id) then raise sqlstate 'PT400' using message='zone_rate_invalid'; end if;
 return new;
end $$;
drop trigger if exists shipping_zone_rate_guard on shipping.zone_rates;
create trigger shipping_zone_rate_guard before insert or update on shipping.zone_rates for each row execute function shipping.guard_zone_rate();

-- Renaming is one-time: replaying this migration must never wrap a wrapper.
do $$ begin
 if to_regprocedure('public.shipping_snapshot_v1(text,text)') is null then
   alter function public.shipping_snapshot(text,text) rename to shipping_snapshot_v1;
 end if;
 if to_regprocedure('public.shipping_mutate_v1(text,jsonb)') is null then
   alter function public.shipping_mutate(text,jsonb) rename to shipping_mutate_v1;
 end if;
end $$;

create or replace function public.shipping_snapshot(p_merchant_id text,p_mode text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; catalog_areas jsonb; rates jsonb;
begin
 if p_mode is null or p_mode not in ('demo','live') then raise sqlstate 'PT400' using message='mode_invalid'; end if;
 if not exists(select 1 from shipping.merchants where id=p_merchant_id) then raise sqlstate 'PT404' using message='merchant_not_found'; end if;
 -- Read policy, rates and expiry-adjusted routes under the established lock
 -- order (admin, then routes), so a snapshot does not mix tariff versions.
 perform pg_advisory_xact_lock(hashtextextended(p_merchant_id||':'||p_mode||':admin',0));
 result:=public.shipping_snapshot_v1(p_merchant_id,p_mode);
 select coalesce(jsonb_agg(n.data||jsonb_build_object('id',z.id,'name',z.name,'country','UY','city',z.department_name,'departmentId',z.department_id,'departmentName',z.department_name,'kind',z.kind) order by z.name,z.id),'[]'::jsonb)
 into catalog_areas from shipping.zone_catalog() z join shipping.neighborhoods n on n.merchant_id=p_merchant_id and n.id=z.id;
 select coalesce(jsonb_agg(jsonb_build_object('areaId',area_id,'priceMinor',price_minor,'enabled',enabled,'version',version) order by area_id),'[]'::jsonb)
 into rates from shipping.zone_rates where merchant_id=p_merchant_id and mode=p_mode;
 return result||jsonb_build_object('areas',catalog_areas,'zoneRates',rates);
end $$;

create or replace function public.shipping_mutate(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 m text:=p_payload->>'merchantId'; md text:=p_payload->>'mode'; actor uuid;
 amount numeric; current_policy shipping.rate_policies; saved shipping.zone_rates;
 before_values jsonb:='{}'::jsonb; result jsonb;
begin
 if p_operation is distinct from 'zone_rate_save' then return public.shipping_mutate_v1(p_operation,p_payload); end if;
 if md is null or md not in ('demo','live') then raise sqlstate 'PT400' using message='mode_invalid'; end if;
 if not exists(select 1 from shipping.merchants where id=m) then raise sqlstate 'PT404' using message='merchant_not_found'; end if;
 begin actor:=(p_payload->>'actorId')::uuid; exception when invalid_text_representation then actor:=null; end;
 if actor is null or public.shipping_admin_context(actor,m) is null then raise sqlstate 'PT403' using message='admin_forbidden'; end if;
 perform pg_advisory_xact_lock(hashtextextended(m||':'||md||':admin',0));
 if jsonb_typeof(p_payload->'areaId') is distinct from 'string' or jsonb_typeof(p_payload->'priceMinor') is distinct from 'number' or
    jsonb_typeof(p_payload->'enabled') is distinct from 'boolean' then raise sqlstate 'PT400' using message='zone_rate_invalid'; end if;
 amount:=(p_payload->>'priceMinor')::numeric;
 if amount<>trunc(amount) or amount<=0 or amount>1000000000 then raise sqlstate 'PT400' using message='zone_rate_invalid'; end if;
 select * into current_policy from shipping.rate_policies where merchant_id=m and mode=md order by version desc limit 1;
 if current_policy.version is null or amount<(current_policy.data->>'minimumMinor')::numeric or
    not exists(select 1 from shipping.neighborhoods n join shipping.zone_catalog() z on z.id=n.id where n.merchant_id=m and n.id=p_payload->>'areaId') then raise sqlstate 'PT400' using message='zone_rate_invalid'; end if;
 select jsonb_build_object('priceMinor',price_minor,'enabled',enabled) into before_values from shipping.zone_rates where merchant_id=m and mode=md and area_id=p_payload->>'areaId';
 insert into shipping.zone_rates(merchant_id,mode,area_id,price_minor,enabled)
 values(m,md,p_payload->>'areaId',amount::bigint,(p_payload->>'enabled')::boolean)
 on conflict(merchant_id,mode,area_id) do update set price_minor=excluded.price_minor,enabled=excluded.enabled,version=shipping.zone_rates.version+1
 returning * into saved;
 -- Never edit a historic policy row: quotes compare their accepted version
 -- with this new global version; original replay checks still run first.
 insert into shipping.rate_policies(merchant_id,mode,version,data) values(m,md,current_policy.version+1,current_policy.data);
 result:=jsonb_build_object('areaId',saved.area_id,'priceMinor',saved.price_minor,'enabled',saved.enabled,'version',saved.version);
 insert into shipping.audit_events(merchant_id,mode,actor_id,actor,operation,entity_type,entity_id,data)
 values(m,md,actor,actor::text,p_operation,'zone_rate',saved.area_id,jsonb_build_object('before',coalesce(before_values,'{}'::jsonb),'after',jsonb_build_object('priceMinor',saved.price_minor,'enabled',saved.enabled)));
 return result;
end $$;

-- Original RPC privileges survive a rename; remove them explicitly so callers
-- cannot bypass the new snapshot and validation boundary. Only definer owners
-- call v1. Public RPC entry points retain the original service-role contract.
revoke all on function public.shipping_snapshot_v1(text,text),public.shipping_mutate_v1(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.shipping_snapshot(text,text),public.shipping_mutate(text,jsonb) from public,anon,authenticated;
revoke all on function shipping.zone_catalog(),shipping.sync_zone_catalog(text),shipping.seed_merchant_zone_catalog(),shipping.guard_zone_rate() from public,anon,authenticated,service_role;
grant execute on function public.shipping_snapshot(text,text),public.shipping_mutate(text,jsonb) to service_role;
commit;
