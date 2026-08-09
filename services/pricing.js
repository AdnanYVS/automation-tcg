const { normalizeGameId, detectGameFromCard } = require('./ikas/taxonomy');

const DEFAULT_MULTIPLIERS = {
  pokemon: 1.86,
  onepiece: 1.57,
};

/** Nakit: PC USD × kur × bu çarpan (kart çarpanından düşük). */
const DEFAULT_CASH_MULTIPLIERS = {
  pokemon: 1.5,
  onepiece: 1.2,
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

function getCashMultiplier(gameId = 'pokemon') {
  const game = normalizeGameId(gameId);

  if (game === 'onepiece') {
    return Number(process.env.ONEPIECE_CASH_MULTIPLIER || DEFAULT_CASH_MULTIPLIERS.onepiece);
  }

  return Number(process.env.POKEMON_CASH_MULTIPLIER || DEFAULT_CASH_MULTIPLIERS.pokemon);
}

function getPriceMultiplierForCard(card, { fallbackGame } = {}) {
  const taxonomy = detectGameFromCard(card, { fallbackGame });

  return {
    multiplier: getPriceMultiplier(taxonomy.id),
    cashMultiplier: getCashMultiplier(taxonomy.id),
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
 * Nakit fiyatı = PC USD × kur × nakit çarpanı.
 * USD yoksa kart fiyatından (kartÇarpan / nakitÇarpan) oranı ile tahmin edilir.
 */
function calculateCashPriceTry({
  usdPrice = null,
  usdTryRate = null,
  sellPriceTry = null,
  gameId = 'pokemon',
} = {}) {
  const cashMultiplier = getCashMultiplier(gameId);
  const usd = Number(usdPrice);
  const rate = Number(usdTryRate);

  if (Number.isFinite(usd) && usd > 0 && Number.isFinite(rate) && rate > 0) {
    return calculateFinalPriceTry(usd, rate, cashMultiplier);
  }

  const sell = Number(sellPriceTry);
  const cardMultiplier = getPriceMultiplier(gameId);
  if (Number.isFinite(sell) && sell > 0 && cardMultiplier > 0) {
    return Math.ceil(sell * (cashMultiplier / cardMultiplier));
  }

  return null;
}

module.exports = {
  DEFAULT_MULTIPLIERS,
  DEFAULT_CASH_MULTIPLIERS,
  calculateFinalPriceTry,
  calculateInventoryValueTry,
  calculateCashPriceTry,
  getCashMultiplier,
  getPriceMultiplier,
  getPriceMultiplierForCard,
};
