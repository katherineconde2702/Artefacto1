// Public catalog only: no addresses, prices or customer data. See docs/SHIPPING_GEOGRAPHY.md.
const slug = name => name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const spanishOrder = (a,b) => a.name.localeCompare(b.name,'es');

export const departments = [
  'Artigas','Canelones','Cerro Largo','Colonia','Durazno','Flores','Florida','Lavalleja','Maldonado',
  'Montevideo','Paysandú','Río Negro','Rivera','Rocha','Salto','San José','Soriano','Tacuarembó','Treinta y Tres'
].map(name => ({id:slug(name),name})).sort(spanishOrder);

// One entry for each feature in IDE's barrios_montevideo, including grouped official areas.
const montevideoNeighborhoods = [
  'Manga Toledo Chico','Colón Sureste Abayubá','Villa García Manga Rural','Bañados de Carrasco',
  'Manga','Peñarol Lavalleja','Punta Rieles Bella Italia','Casavalle','Piedras Blancas','Sayago',
  'Jardines del Hipódromo','Casabó Pajas Blancas','Las Acacias','La Paloma Tomkinson','Belvedere',
  'Paso de las Duranas','Ituzaingó','Flor de Maroñas','Aires Puros','Castro Castellanos',
  'Tres Ombúes Pblo Victoria','Cerrito','Prado Nueva Savona','Villa Española','Maroñas Parque Guaraní',
  'Brazo Oriental','Las Canteras','La Teja','Mercado Modelo y Bolívar','Atahualpa','Capurro Bella Vista',
  'Unión','Carrasco Norte','Jacinto Vera','Larrañaga','Figurita','Malvín Norte','Carrasco','Reducto',
  'Cerro','Punta Gorda','Villa Muñoz Retiro','La Comercial','Buceo','Malvín','Aguada','La Blanqueada',
  'Tres Cruces','Pque Batlle Villa Dolores','Cordón','Centro','Ciudad Vieja','Pocitos','Palermo',
  'Parque Rodó','Barrio Sur','Punta Carretas','Colón Centro y Noroeste','Conciliación','Nuevo París',
  'Lezica Melilla','Paso de la Arena'
];

export const zones = [
  ...montevideoNeighborhoods.map(name => ({id:slug(name),name,departmentId:'montevideo',kind:'neighborhood'})),
  ...departments.filter(department => department.id !== 'montevideo').map(department => ({
    id:`dept-${department.id}`,name:department.name,departmentId:department.id,kind:'department'
  }))
].sort(spanishOrder);

export const geographySources = [
  {id:'uy-departments',name:'GUB.UY — Gobiernos Departamentales',url:'https://www.gub.uy/gobiernos-departamentales',retrievedAt:'2026-11-01'},
  {id:'montevideo-neighborhoods',name:'IDE Uruguay — Barrios Montevideo',
    url:'https://visualizador.ide.uy/geonetwork/srv/api/records/68120ce6-7115-42e1-a763-30c39a12eff4',
    serviceUrl:'https://mapas.ide.uy/geoserver-vectorial/ws_capa_base/wfs',dataset:'ws_capa_base:barrios_montevideo',
    sourceVersion:1,sourceDate:'2024-10-28',featureCount:62,retrievedAt:'2026-11-01'}
];
