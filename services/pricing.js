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

module.exports = {
  DEFAULT_MULTIPLIERS,
  calculateFinalPriceTry,
  getPriceMultiplier,
  getPriceMultiplierForCard,
};
