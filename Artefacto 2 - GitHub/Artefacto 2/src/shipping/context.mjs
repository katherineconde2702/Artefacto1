import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const shippingError = (code, status = 400) => Object.assign(new Error(code), {code,status,statusCode:status});
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function secretMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a=createHash('sha256').update(actual).digest(), b=createHash('sha256').update(expected).digest();
  return timingSafeEqual(a,b);
}

// A signed random handle reveals no cart or address. Restarting invalidates all handles,
// including when a stable signing key is configured; no personal Google data is cached on disk.
export function createContextStore({secret=randomBytes(32).toString('base64url'),now=()=>Date.now(),limit=10000}={}) {
  const records=new Map();
  const sign=id=>createHmac('sha256',secret).update(id).digest('base64url');
  function prune() {for(const [id,record]of records)if(Date.parse(record.expiresAt)<=now())records.delete(id);}
  return {
    issue(record) {
      prune();if(records.size>=limit)throw shippingError('shipping_busy',503);
      const id=randomBytes(32).toString('base64url');records.set(id,structuredClone(record));return `${id}.${sign(id)}`;
    },
    read(token) {
      if(typeof token!=='string'||token.length>200)throw shippingError('checkout_unauthorized',401);
      const [id,signature,...extra]=token.split('.');
      if(extra.length||!id||!secretMatches(signature,sign(id)))throw shippingError('checkout_unauthorized',401);
      const record=records.get(id);if(!record)throw shippingError('checkout_unauthorized',401);
      if(Date.parse(record.expiresAt)<=now()){records.delete(id);throw shippingError('checkout_expired',410);}
      return record;
    }
  };
}
