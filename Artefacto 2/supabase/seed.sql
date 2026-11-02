-- Safe personal-project fixtures: no Auth users, credentials or personal data.
begin;
insert into shipping.merchants(id,name,origin_place_id,data) values('marea','Marea',null,'{}') on conflict(id) do nothing;
insert into shipping.rate_policies(merchant_id,mode,version,data)
select 'marea',md,1,'{"minimumMinor":14900,"fuelPriceMinorPerLiter":9045,"fuelLitersPer100Km":3,"laborMinorPerHour":25000,"serviceMinutes":5,"marginBps":1500,"roundingMinor":100,"quoteMinutes":5,"holdMinutes":15}'::jsonb from unnest(array['demo','live']) md
on conflict do nothing;
insert into shipping.product_prices(merchant_id,mode,product_id,price_minor)
select 'marea',md,product,price from unnest(array['demo','live']) md cross join (values('soft-knit-sweater',279000),('relaxed-linen-blazer',479000),('fluid-silk-blouse',359000),('ribbed-midi-dress',379000),('wide-leg-trousers',319000),('soft-crop-cardigan',259000)) as prices(product,price)
on conflict do nothing;
insert into shipping.neighborhoods(merchant_id,id,name,data) values
('marea','centro','Centro','{"country":"UY","city":"Montevideo"}'),
('marea','pocitos','Pocitos','{"country":"UY","city":"Montevideo"}'),
('marea','malvin','Malvín','{"country":"UY","city":"Montevideo"}') on conflict do nothing;
insert into shipping.service_days(merchant_id,mode,delivery_date)
select 'marea','demo',(now() at time zone 'America/Montevideo')::date+offset_days from generate_series(1,3) offset_days on conflict do nothing;
-- Live stays unconfigured: set a verified Google origin and enable service days
-- as an authenticated merchant administrator before accepting live shipments.
commit;
