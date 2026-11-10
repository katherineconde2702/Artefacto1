import {tariffShapes} from './tariff-shapes.js';
import {formatUYU} from '../store/money.js';
import {escapeHTML as esc} from '../widget/shipping-widget.js';

const palette=['#e1f1ec','#b8ddd2','#7bb6a6','#398d7b','#156757'];
const money=value=>Number.isSafeInteger(value)&&value>0;
const price=value=>formatUYU(value).replace(/,00$/,'');
export function getTariffRegions(state,scope='montevideo'){
 const areaById=new Map(state.areas.map(area=>[area.id,area])),rateById=new Map(state.zoneRates.map(rate=>[rate.areaId,rate]));
 const minimum=money(state.policy?.minimumMinor)?state.policy.minimumMinor:0;
 const regions=tariffShapes[scope==='uruguay'?'uruguay':'montevideo'].map(shape=>{
  if(shape.id==='montevideo'){
   const prices=state.areas.filter(area=>area.departmentId==='montevideo').map(area=>rateById.get(area.id)).filter(rate=>rate?.enabled&&money(rate.priceMinor)).map(rate=>Math.max(rate.priceMinor,minimum));
   return {...shape,name:'Montevideo',group:true,status:'group',fill:'#edf3ef',priceMinor:null,priceText:prices.length?(Math.min(...prices)===Math.max(...prices)?price(prices[0]):`${price(Math.min(...prices))}–${price(Math.max(...prices))}`):'Sin tarifas',hint:'Ver tarifas por barrio'};
  }
  const rate=rateById.get(shape.id),configuredMinor=money(rate?.priceMinor)?rate.priceMinor:null,priceMinor=configuredMinor===null?null:Math.max(configuredMinor,minimum);
  const status=configuredMinor===null?'missing':rate.enabled?'active':'disabled';
  return {...shape,name:areaById.get(shape.id)?.name||shape.id,group:false,status,configuredMinor,priceMinor,priceText:priceMinor===null?'Sin tarifa':price(priceMinor),hint:status==='active'?'Habilitada':status==='disabled'?'Deshabilitada':'Sin configurar'};
 });
 const active=regions.filter(region=>region.status==='active').map(region=>region.priceMinor),low=Math.min(...active),high=Math.max(...active);
 return regions.map(region=>({...region,fill:region.group?region.fill:region.status!=='active'?'#e4e8ec':palette[low===high?2:Math.min(4,Math.floor((region.priceMinor-low)/(high-low)*5))]}));
}
function mapLabels(regions,selected,zoom,view,labelScale){
 const labels=[],occupied=[],font=12*labelScale/zoom;
 const ordered=[...regions].sort((a,b)=>(b.id===selected)-(a.id===selected)||b.area-a.area);
 for(const region of ordered){
  const [x,y]=region.label;if(x<view[0]||y<view[1]||x>view[0]+view[2]||y>view[1]+view[3])continue;
  const name=region.name.length>20?region.name.slice(0,18)+'…':region.name;
  const width=Math.max(name.length*font*.55,region.priceText.length*font*.55)+10/zoom,height=35*labelScale/zoom;
  const box=[x-width/2,y-height/2,x+width/2,y+height/2];
  if(region.id!==selected&&occupied.some(other=>box[0]<other[2]&&box[2]>other[0]&&box[1]<other[3]&&box[3]>other[1]))continue;
  occupied.push(box);
  labels.push(`<g class="map-label" transform="translate(${x} ${y})" style="font-size:${font}px;--label-stroke:${4/zoom}px"><text y="${-4/zoom}">${esc(name)}</text><text class="map-price" y="${12/zoom}">${esc(region.priceText)}</text></g>`);
 }
 return labels.join('');
}
export function renderTariffMap(state,{scope='montevideo',selected='',zoom=1,labelScale=1}={}){
 scope=scope==='uruguay'?'uruguay':'montevideo';zoom=Math.max(1,Math.min(4,Number(zoom)||1));
 const regions=getTariffRegions(state,scope),current=regions.find(region=>region.id===selected);
 const width=760/zoom,height=620/zoom,center=current?.label||[380,310];
 const view=[Math.max(0,Math.min(760-width,center[0]-width/2)),Math.max(0,Math.min(620-height,center[1]-height/2)),width,height];
 const active=regions.filter(region=>region.status==='active'),prices=active.map(region=>region.priceMinor);
 const low=prices.length?price(Math.min(...prices)):'—',high=prices.length?price(Math.max(...prices)):'—';
 const summary=current?`<strong>${esc(current.name)}</strong><b>${esc(current.priceText)}</b><span>${esc(current.hint)}${!current.group&&current.configuredMinor<current.priceMinor?' · Se aplica el mínimo de envío':''}</span>`:'<strong>Elegí una zona</strong><span>Seleccioná en el mapa o en el desplegable para editar su tarifa.</span>';
 return `<div class="map-toolbar"><div class="map-tabs" role="group" aria-label="Mapa de cobertura"><button type="button" data-map-scope="uruguay" aria-pressed="${scope==='uruguay'}">Uruguay</button><button type="button" data-map-scope="montevideo" aria-pressed="${scope==='montevideo'}">Montevideo</button></div><label>${scope==='uruguay'?'Departamento':'Barrio de Montevideo'}<select id="map-area"><option value="">Elegí ${scope==='uruguay'?'un departamento':'un barrio'}</option>${[...regions].sort((a,b)=>a.name.localeCompare(b.name,'es')).map(region=>`<option value="${esc(region.id)}" ${region.id===selected?'selected':''}>${esc(region.name)} · ${esc(region.priceText)}${region.status==='disabled'?' · Deshabilitada':''}</option>`).join('')}</select></label></div>
 <div class="tariff-canvas"><div class="map-zoom" aria-label="Acercamiento del mapa"><button type="button" data-map-zoom="in" aria-label="Acercar mapa" ${zoom===4?'disabled':''}>+</button><button type="button" data-map-zoom="out" aria-label="Alejar mapa" ${zoom===1?'disabled':''}>−</button><button type="button" data-map-zoom="reset" aria-label="Restablecer mapa">↺</button></div>
 <svg viewBox="${view.join(' ')}" role="group" aria-label="${scope==='uruguay'?'Departamentos de Uruguay':'Barrios de Montevideo'} y sus tarifas de envío"><defs><pattern id="tariff-unset" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#f4f5f7"/><path d="M0 8L8 0" stroke="#d4dae1" stroke-width="1"/></pattern></defs>${regions.map(region=>`<g role="button" tabindex="0" data-map-zone="${esc(region.id)}" aria-label="${esc(region.name+' · '+region.priceText+' · '+region.hint)}" aria-pressed="${region.id===selected}"><title>${esc(region.name+' · '+region.priceText+' · '+region.hint)}</title><path class="map-region ${region.id===selected?'selected':''}" d="${region.d}" fill="${region.status==='missing'?'url(#tariff-unset)':region.fill}"/></g>`).join('')}${mapLabels(regions,selected,zoom,view,labelScale)}</svg>
 <div class="map-selected" aria-live="polite">${summary}</div></div>
 <div class="map-legend"><div><span>Menor tarifa</span><span class="heat-scale">${palette.map(color=>`<i style="background:${color}"></i>`).join('')}</span><span>Mayor tarifa</span></div><div class="map-range"><b>${low}</b><b>${high}</b></div><p><span class="legend-disabled"></span>Deshabilitada <span class="legend-unset"></span>Sin tarifa</p></div>
 <p class="map-help">Tarifas base vigentes en UYU. Los descuentos dependen de la fecha y franja elegidas. ${scope==='uruguay'?'Montevideo se configura por barrio.':''}</p><p class="map-source">Cartografía: <a href="https://visualizador.ide.uy/geonetwork/srv/api/records/68120ce6-7115-42e1-a763-30c39a12eff4" target="_blank" rel="noopener noreferrer">IDE Uruguay / AGESIC</a> · <a href="https://sit.mvot.gub.uy/arcgis/rest/services/07_EXTERNO/LIMITES_ADMINISTRATIVOS/MapServer/3" target="_blank" rel="noopener noreferrer">IGM / MVOT</a></p>`;
}
