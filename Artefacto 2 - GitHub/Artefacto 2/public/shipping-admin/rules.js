// Shared business rules: the admin simulator and the server use integer UYU centésimos.
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const only=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const invalid=message=>{throw Error(message);};
export function selectDeliveryOptions(options){
  const chronological=(a,b)=>String(a.deliveryDate||'').localeCompare(String(b.deliveryDate||''))||String(a.windowStart||'').localeCompare(String(b.windowStart||''));
  const ordered=[...options].sort(chronological);
  if(ordered.length<=5)return ordered;
  const cheapest=ordered.reduce((best,row)=>row.priceMinor<best.priceMinor?row:best),selected=new Set([ordered[0],cheapest]);
  const prices=new Set([...selected].map(row=>row.priceMinor));
  for(const row of ordered){if(selected.size===5)break;if(!prices.has(row.priceMinor)){selected.add(row);prices.add(row.priceMinor);}}
  for(const row of ordered){if(selected.size===5)break;selected.add(row);}
  return [...selected].sort(chronological);
}
export function validateDiscountRule(rule){
  if(!only(rule,['areaId','enabled','tiers','version'])||typeof rule.areaId!=='string'||!/^([a-z0-9_-]{1,80}|\*)$/.test(rule.areaId)||typeof rule.enabled!=='boolean'||!Array.isArray(rule.tiers)||rule.tiers.length>20||(rule.enabled&&!rule.tiers.length))invalid('Configurá entre 1 y 20 escalones para una regla activa.');
  const seen=new Set();
  const tiers=rule.tiers.map(tier=>{
    if(!only(tier,['minOrders','type','value'])||!integer(tier.minOrders,1,1000)||seen.has(tier.minOrders)||!['fixed','percent'].includes(tier.type)||!integer(tier.value,1,tier.type==='percent'?10000:1000000000))invalid('Revisá los umbrales únicos y descuentos positivos; el porcentaje no puede superar 100%.');
    seen.add(tier.minOrders);return {...tier};
  }).sort((a,b)=>a.minOrders-b.minOrders);
  return {areaId:rule.areaId,enabled:rule.enabled,tiers};
}
export function chooseDiscountRule(rules=[],areaId){
  const candidates=rules.filter(rule=>rule.areaId===areaId||rule.areaId==='*');
  if(candidates.filter(rule=>rule.areaId===areaId).length>1||candidates.filter(rule=>rule.areaId==='*').length>1)invalid('Reglas de descuento duplicadas.');
  const selected=candidates.find(rule=>rule.areaId===areaId)||candidates.find(rule=>rule.areaId==='*');
  return selected?validateDiscountRule(selected):null;
}
export function calculateZonePrice({baseMinor,minimumMinor,confirmedCount=0,rule=null,promotion=null}){
  if(!integer(baseMinor,1,1000000000)||!integer(minimumMinor,1,1000000000)||!integer(confirmedCount,0,1000))invalid('Importes o cantidad de pedidos inválidos.');
  const normalPriceMinor=Math.max(baseMinor,minimumMinor);
  const selected=rule?validateDiscountRule(rule):null;
  const tier=selected?.enabled?selected.tiers.filter(row=>row.minOrders<=confirmedCount).at(-1):null;
  const discountMinor=tier?(tier.type==='fixed'?tier.value:Math.floor(normalPriceMinor*tier.value/10000)):0;
  const automaticPriceMinor=Math.max(minimumMinor,normalPriceMinor-discountMinor);
  let priceMinor=automaticPriceMinor,source=priceMinor<normalPriceMinor?'grouping':'base';
  if(integer(promotion?.priceMinor,minimumMinor,1000000000)&&promotion.priceMinor<priceMinor){priceMinor=promotion.priceMinor;source='promotion';}
  return {priceMinor,normalPriceMinor,safetyFloorMinor:minimumMinor,source,confirmedCount,ruleAreaId:selected?.areaId??null,tier:tier?{...tier}:null,discountMinor:normalPriceMinor-priceMinor,automaticPriceMinor,minimumApplied:Boolean(tier&&normalPriceMinor-discountMinor<minimumMinor),...(source==='promotion'?{promotionId:promotion.id,promotionVersion:promotion.version}:{})};
}
export function validateDeliveryWindow(window){
  if(!only(window,['id','deliveryDate','startTime','endTime','capacity','enabled','version'])||typeof window.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(window.id)||typeof window.deliveryDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(window.deliveryDate)||!Number.isFinite(Date.parse(window.deliveryDate+'T12:00:00Z'))||new Date(window.deliveryDate+'T12:00:00Z').toISOString().slice(0,10)!==window.deliveryDate||![window.startTime,window.endTime].every(time=>typeof time==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(time))||window.endTime<=window.startTime||!integer(window.capacity,1,1000)||typeof window.enabled!=='boolean')invalid('Revisá la fecha, el horario inicial/final y el cupo (1 a 1000).');
  return Object.fromEntries(['id','deliveryDate','startTime','endTime','capacity','enabled'].map(key=>[key,window[key]]));
}
