function numberInRange(value, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function recommendClothing(product, input) {
  const heightCm = numberInRange(input.heightCm, 135, 220);
  const weightKg = numberInRange(input.weightKg, 35, 180);
  if (!heightCm || !weightKg) {
    throw new Error('Ingresá una altura y un peso válidos para una mujer adulta.');
  }
  const bmi = weightKg / ((heightCm / 100) ** 2);
  const band = product.sizeBands.find((candidate) => bmi < candidate.maxBmi) || product.sizeBands.at(-1);
  return {
    size: band.size,
    confidence: 'estimated',
    fit: product.targetFit,
    metrics: { heightCm, weightKg, bmi: Number(bmi.toFixed(1)) },
    explanation: `Este talle conserva el calce ${product.targetFit} diseñado para esta prenda.`
  };
}

function recommendShoes(product, input) {
  const footCm = numberInRange(input.footCm, 20, 30);
  if (!footCm) throw new Error('Ingresá el largo del pie en centímetros.');
  const size = footCm < 23 ? '36' : footCm < 23.7 ? '37' : footCm < 24.4 ? '38' : footCm < 25.1 ? '39' : footCm < 25.8 ? '40' : '41';
  return {
    size,
    confidence: 'estimated',
    fit: product.targetFit,
    metrics: { footCm },
    explanation: 'Referencia inicial; debe calibrarse con la horma de cada marca.'
  };
}

export function recommendSize(product, input) {
  if (product.audience !== 'adult-women') throw new Error('Este prototipo solo admite el público configurado para el producto.');
  return product.articleType === 'shoes' ? recommendShoes(product, input) : recommendClothing(product, input);
}
