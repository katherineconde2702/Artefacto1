export function formatUYU(minor) {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('Importe UYU inválido.');
  return `UYU ${new Intl.NumberFormat('es-UY', {minimumFractionDigits:2,maximumFractionDigits:2}).format(minor / 100)}`;
}
export function parseUYU(value) {
  const text = String(value).trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) throw new Error('Ingresá pesos UYU con hasta dos decimales, sin separador de miles.');
  const [whole, fraction = ''] = text.replace(',', '.').split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) throw new Error('Importe fuera de rango.');
  return minor;
}
export function formatProductPrice(product) {
  if (product.currency !== 'UYU') throw new Error('La prenda debe tener precio UYU.');
  return formatUYU(parseUYU(product.price));
}
