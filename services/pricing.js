const { normalizeGameId, detectGameFromCard } = require('./ikas/taxonomy');

const DEFAULT_MULTIPLIERS = {
  pokemon: 1.86,
  onepiece: 1.57,
};

function getPriceMultiplier(gameId = 'pokemon') {
  const game = normalizeGameId(gameId);

  if (game === 'onepiece') {
    return Number(process.env.ONEPIECE_COST_MULTIPLIER || DEFAULT_MULTIPLIERS.onepiece);
  }

  return Number(
    process.env.POKEMON_COST_MULTIPLIER
    || process.env.FINAL_COST_MULTIPLIER
    || DEFAULT_MULTIPLIERS.pokemon,
  );
}

function getPriceMultiplierForCard(card, { fallbackGame } = {}) {
  const taxonomy = detectGameFromCard(card, { fallbackGame });

  return {
    multiplier: getPriceMultiplier(taxonomy.id),
    gameId: taxonomy.id,
    gameLabel: taxonomy.brandName,
  };
}

function calculateFinalPriceTry(usdPrice, usdTryRate, multiplier = 1.86) {
  const rawPrice = Number(usdPrice) * Number(usdTryRate) * Number(multiplier);
  return Math.ceil(rawPrice);
}

/** Envanter değeri: satış çarpanı yok, yalnızca PC USD × kur. */
function calculateInventoryValueTry(usdPrice, usdTryRate) {
  const rawPrice = Number(usdPrice) * Number(usdTryRate);
  return Math.ceil(rawPrice);
}

/**
 * Nakit fiyatı = kart (satış) fiyatı × CASH_PRICE_RATIO.
 * Oran tanımlı değilse null döner (UI "—" gösterir).
 */
function getCashPriceRatio() {
  const raw = process.env.CASH_PRICE_RATIO;
  if (raw == null || String(raw).trim() === '') return null;
  const ratio = Number(raw);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return ratio;
}

function calculateCashPriceTry(sellPriceTry, ratio = getCashPriceRatio()) {
  const sell = Number(sellPriceTry);
  if (!Number.isFinite(sell) || sell <= 0 || ratio == null) return null;
  return Math.ceil(sell * Number(ratio));
}

module.exports = {
  DEFAULT_MULTIPLIERS,
  calculateFinalPriceTry,
  calculateInventoryValueTry,
  calculateCashPriceTry,
  getCashPriceRatio,
  getPriceMultiplier,
  getPriceMultiplierForCard,
};
