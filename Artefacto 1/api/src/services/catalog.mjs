const adultWomenSizeBands = () => [
  { maxBmi: 20.5, size: 'S' },
  { maxBmi: 23.4, size: 'M' },
  { maxBmi: 26.6, size: 'L' },
  { maxBmi: Infinity, size: 'XL' }
];

const products = new Map([
  ['soft-knit-sweater', {
    id: 'soft-knit-sweater',
    name: 'Soft Knit Sweater',
    audience: 'adult-women', articleType: 'clothing', category: 'tops', targetFit: 'oversized',
    price: 69, currency: 'USD', color: 'Arena',
    description: 'Tejido suave de trama aireada, hombro caído y silueta relajada.',
    eyebrow: 'New in · Tejidos responsables', rating: 4.9, reviewCount: 24,
    sizes: ['S', 'M', 'L', 'XL'], defaultSize: 'M', garmentPhotoType: 'flat-lay',
    garmentAsset: 'sweater-m.png',
    garmentAssetsBySize: { S: 'sweater-s.png', M: 'sweater-m.png', L: 'sweater-l.png', XL: 'sweater-xl.png' },
    garmentMeasurementsCm: {
      S: { chestCircumference: 100, bodyLength: 58, sleeveLength: 54 },
      M: { chestCircumference: 108, bodyLength: 60, sleeveLength: 55 },
      L: { chestCircumference: 116, bodyLength: 62, sleeveLength: 56 },
      XL: { chestCircumference: 124, bodyLength: 64, sleeveLength: 57 }
    },
    productImage: '/assets/sweater-m.png', lookImage: '/assets/garment-set.png', editorialImage: '/assets/editorial-fit-model-v2.png',
    sizeBands: adultWomenSizeBands()
  }],
  ['relaxed-linen-blazer', {
    id: 'relaxed-linen-blazer', name: 'Relaxed Linen Blazer',
    audience: 'adult-women', articleType: 'clothing', category: 'outerwear', targetFit: 'relaxed',
    price: 119, currency: 'USD', color: 'Camel',
    description: 'Blazer de lino liviano con hombro suave, solapa clásica y estructura relajada.',
    eyebrow: 'Sastrería liviana · Lino', rating: 4.8, reviewCount: 31,
    sizes: ['S', 'M', 'L', 'XL'], defaultSize: 'M', garmentPhotoType: 'flat-lay', garmentAsset: 'blazer-camel.png',
    garmentMeasurementsCm: {
      S: { chestCircumference: 98, bodyLength: 69, sleeveLength: 59 }, M: { chestCircumference: 104, bodyLength: 70, sleeveLength: 60 },
      L: { chestCircumference: 110, bodyLength: 71, sleeveLength: 61 }, XL: { chestCircumference: 118, bodyLength: 72, sleeveLength: 62 }
    },
    productImage: '/assets/blazer-camel.png', lookImage: '/assets/blazer-camel.png', editorialImage: '/assets/blazer-camel.png',
    sizeBands: adultWomenSizeBands()
  }],
  ['fluid-silk-blouse', {
    id: 'fluid-silk-blouse', name: 'Fluid Silk Blouse',
    audience: 'adult-women', articleType: 'clothing', category: 'tops', targetFit: 'regular',
    price: 89, currency: 'USD', color: 'Marfil',
    description: 'Blusa de seda de caída fluida, cuello limpio y puños suavemente fruncidos.',
    eyebrow: 'Esenciales · Seda responsable', rating: 4.7, reviewCount: 18,
    sizes: ['S', 'M', 'L', 'XL'], defaultSize: 'M', garmentPhotoType: 'flat-lay', garmentAsset: 'blouse-ivory.png',
    garmentMeasurementsCm: {
      S: { chestCircumference: 92, bodyLength: 63, sleeveLength: 59 }, M: { chestCircumference: 98, bodyLength: 64, sleeveLength: 60 },
      L: { chestCircumference: 104, bodyLength: 65, sleeveLength: 61 }, XL: { chestCircumference: 112, bodyLength: 66, sleeveLength: 62 }
    },
    productImage: '/assets/blouse-ivory.png', lookImage: '/assets/blouse-ivory.png', editorialImage: '/assets/blouse-ivory.png',
    sizeBands: adultWomenSizeBands()
  }],
  ['ribbed-midi-dress', {
    id: 'ribbed-midi-dress', name: 'Ribbed Midi Dress',
    audience: 'adult-women', articleType: 'clothing', category: 'dresses', targetFit: 'slim',
    price: 94, currency: 'USD', color: 'Cacao',
    description: 'Vestido midi de punto canalé con línea depurada y ajuste flexible al cuerpo.',
    eyebrow: 'Edición textura · Punto canalé', rating: 4.9, reviewCount: 42,
    sizes: ['S', 'M', 'L', 'XL'], defaultSize: 'M', garmentPhotoType: 'flat-lay', garmentAsset: 'dress-cocoa.png',
    garmentMeasurementsCm: {
      S: { bustCircumference: 78, waistCircumference: 68, bodyLength: 119 }, M: { bustCircumference: 84, waistCircumference: 74, bodyLength: 120 },
      L: { bustCircumference: 90, waistCircumference: 80, bodyLength: 121 }, XL: { bustCircumference: 98, waistCircumference: 88, bodyLength: 122 }
    },
    productImage: '/assets/dress-cocoa.png', lookImage: '/assets/dress-cocoa.png', editorialImage: '/assets/dress-cocoa.png',
    sizeBands: adultWomenSizeBands()
  }],
  ['wide-leg-trousers', {
    id: 'wide-leg-trousers', name: 'Wide Leg Trousers',
    audience: 'adult-women', articleType: 'clothing', category: 'bottoms', targetFit: 'wide-leg',
    price: 79, currency: 'USD', color: 'Avena',
    description: 'Pantalón sastrero de tiro alto, pinzas delanteras y pierna amplia de caída fluida.',
    eyebrow: 'Sastrería · Mezcla de lino', rating: 4.8, reviewCount: 27,
    sizes: ['S', 'M', 'L', 'XL'], defaultSize: 'M', garmentPhotoType: 'flat-lay', garmentAsset: 'trousers-oat.png',
    garmentMeasurementsCm: {
      S: { waistCircumference: 68, hipCircumference: 96, inseamLength: 78 }, M: { waistCircumference: 74, hipCircumference: 102, inseamLength: 79 },
      L: { waistCircumference: 80, hipCircumference: 108, inseamLength: 80 }, XL: { waistCircumference: 88, hipCircumference: 116, inseamLength: 80 }
    },
    productImage: '/assets/trousers-oat.png', lookImage: '/assets/trousers-oat.png', editorialImage: '/assets/trousers-oat.png',
    sizeBands: adultWomenSizeBands()
  }],
  ['soft-crop-cardigan', {
    id: 'soft-crop-cardigan', name: 'Soft Crop Cardigan',
    audience: 'adult-women', articleType: 'clothing', category: 'tops', targetFit: 'fitted',
    price: 64, currency: 'USD', color: 'Salvia',
    description: 'Cardigan corto de punto fino, botones al tono y terminaciones acanaladas.',
    eyebrow: 'New in · Punto suave', rating: 4.6, reviewCount: 16,
    sizes: ['S', 'M', 'L', 'XL'], defaultSize: 'M', garmentPhotoType: 'flat-lay', garmentAsset: 'cardigan-sage.png',
    garmentMeasurementsCm: {
      S: { chestCircumference: 84, bodyLength: 45, sleeveLength: 57 }, M: { chestCircumference: 90, bodyLength: 46, sleeveLength: 58 },
      L: { chestCircumference: 96, bodyLength: 47, sleeveLength: 59 }, XL: { chestCircumference: 104, bodyLength: 48, sleeveLength: 60 }
    },
    productImage: '/assets/cardigan-sage.png', lookImage: '/assets/cardigan-sage.png', editorialImage: '/assets/cardigan-sage.png',
    sizeBands: adultWomenSizeBands()
  }]
]);

export function getProduct(productId) {
  return products.get(productId) || null;
}

export function listProducts() {
  return [...products.values()];
}

export function toPublicProduct(product) {
  if (!product) return null;
  const { garmentAsset, garmentAssetsBySize, sizeBands, ...publicFields } = product;
  return publicFields;
}
