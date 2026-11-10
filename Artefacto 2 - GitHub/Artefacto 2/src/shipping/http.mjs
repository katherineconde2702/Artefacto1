import { createShippingService } from './service.mjs';

const prefix='/api/v1/shipping';
export function createShippingModule(options={}) {
  const service=createShippingService(options),clients=new Map();
  const env=options.env||{};
  const positive=(value,fallback)=>/^\d+$/.test(value||'')&&Number(value)>0?Math.min(Number(value),1000000):fallback;
  const limit=positive(env.SHIPPING_RATE_LIMIT_MAX,60),windowMs=positive(env.SHIPPING_RATE_LIMIT_WINDOW_MS,60000);
  function consume(req,res) {
    const now=Date.now(),key=req.socket.remoteAddress||'unknown';
    for(const [id,record]of clients)if(record.resetAt<=now)clients.delete(id);
    let record=clients.get(key);if(!record){record={count:0,resetAt:now+windowMs};clients.set(key,record);}
    res.setHeader('RateLimit-Limit',String(limit));res.setHeader('RateLimit-Remaining',String(Math.max(0,limit-record.count-1)));
    if(record.count++>=limit){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((record.resetAt-now)/1000))));return false;}return true;
  }
  return {
    publicPrices:()=>service.prices(),authOrigin:service.authOrigin,allowedOrigins:service.allowedOrigins,
    async handle({req,res,url,requestId,readJson,sendJson,sendError}) {
      if(url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))return false;
      const path=url.pathname.slice(prefix.length)||'/',method=req.method;
      try {
        if(!consume(req,res)) {
          if(!req.complete) {
            res.setHeader('Connection','close');
            res.once('finish',()=>{if(!req.complete)req.destroy();});
          }
          sendError(res,429,requestId,'shipping_rate_limited','Se alcanzó el límite temporal de consultas de envíos.');return true;
        }
        let body={};if(['POST','PUT','PATCH'].includes(method))body=await readJson(req);
        if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error(),{status:400,code:'shipping_invalid_request'});
        let result,status=200;
        if(path==='/portal-config'&&method==='GET')result=await service.portalConfig(req);
        else if(path==='/config'&&method==='GET')result=await service.config(req,url.searchParams.get('merchantId')||'marea');
        else if(path==='/admin/demo-session'&&method==='POST'){result=await service.demoSession(req,body);status=201;}
        else if(path==='/checkouts'&&method==='POST'){result=await service.checkout(req,body);status=201;}
        else if(path==='/store/checkouts'&&method==='POST'){result=await service.storefrontCheckout(req,body);status=201;}
        else if(path==='/addresses/resolve'&&method==='POST')result=await service.address(body);
        else if(path==='/quotes'&&method==='POST')result=await service.quote(body);
        else if(path==='/reservations'&&method==='POST'){result=await service.reserve(req,body);status=201;}
        else if(/^\/reservations\/[^/]+\/demo-confirm$/.test(path)&&method==='POST')result=await service.demoConfirm(body,path.split('/')[2]);
        else if(/^\/shipments\/[^/]+\/confirm$/.test(path)&&method==='POST')result=await service.confirm(req,body,path.split('/')[2]);
        else if(path.startsWith('/admin/')||/^\/shipments\/[^/]+\/cancel$/.test(path)) {
          result=await service.admin(req,body,path,method,url.searchParams);if(method==='POST'&&!path.endsWith('/cancel')&&!path.endsWith('/confirm'))status=201;
        } else {sendError(res,404,requestId,'shipping_route_not_found','Ruta de envíos no encontrada.');return true;}
        sendJson(res,status,result);return true;
      }catch(error) {
        const candidate=error?.status||error?.statusCode,status=[400,401,403,404,408,409,410,413,415,422,429,503,504].includes(candidate)?candidate:503;
        const code=typeof error?.code==='string'&&/^[a-zA-Z0-9_]{1,80}$/.test(error.code)?error.code:'shipping_unavailable';
        const message=({400:'Revisá los datos enviados.',401:'Se requiere una sesión o credencial válida.',403:'No tenés permiso para esta operación.',404:'No se encontró el recurso de envíos.',408:'La solicitud demoró más de lo permitido.',409:'Cambió la disponibilidad. Consultá nuevamente o revisá la clave de reintento.',410:'La cotización o reserva venció. Consultá nuevamente.',413:'La solicitud supera el máximo permitido.',415:'El servicio requiere application/json.',422:'No pudimos verificar el destino. Revisá la dirección y cobertura.',429:'Se alcanzó el límite temporal de consultas.',503:'Envíos no disponible. Revisá la configuración del comercio e intentá nuevamente.',504:'El proveedor demoró más de lo permitido.'})[status];
        sendError(res,status,requestId,code,message);return true;
      }
    }
  };
}
