const { getAllMappings } = require('../db');
const { getCardById, getPriceChartingUsd } = require('./kartfiyat');
const { listStockLocations, listAllVariantStocks } = require('./ikas');
const { getUsdTryRate } = require('./exchangeRate');
const { calculateFinalPriceTry } = require('./pricing');

const REQUEST_DELAY_MS = Number(process.env.KARTFIYAT_REQUEST_DELAY_MS || 200);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStockIndex(stockRows) {
  const byVariant = new Map();

  for (const row of stockRows) {
    if (!byVariant.has(row.variantId)) {
      byVariant.set(row.variantId, new Map());
    }
    byVariant.get(row.variantId).set(row.stockLocationId, Number(row.stockCount || 0));
  }

  return byVariant;
}

function initLocationTotals(stockLocations) {
  const totals = {};
  for (const location of stockLocations) {
    totals[location.id] = {
      id: location.id,
      name: location.name,
      units: 0,
      valueTry: 0,
    };
  }
  return totals;
}

async function getPortfolioValuation() {
  const mappings = getAllMappings().filter((mapping) => mapping.ikas_variant_id);
  const [usdTryRate, stockLocations, stockRows] = await Promise.all([
    getUsdTryRate(),
    listStockLocations(),
    listAllVariantStocks(),
  ]);
  const multiplier = Number(process.env.FINAL_COST_MULTIPLIER || 1.86);
  const stockByVariant = buildStockIndex(stockRows);
  const locationTotals = initLocationTotals(stockLocations);

  const items = [];
  const skipped = [];
  let totalValueTry = 0;
  let totalUnits = 0;

  for (const mapping of mappings) {
    try {
      const card = await getCardById(mapping.kartfiyat_card_id);
      const usdPrice = getPriceChartingUsd(card);
      const cardName = card.name || mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`;

      if (!usdPrice) {
        skipped.push({
          mappingId: mapping.id,
          cardName,
          kartfiyatCardId: mapping.kartfiyat_card_id,
          reason: 'PriceCharting fiyatı yok',
        });
        continue;
      }

      const unitTryPrice = calculateFinalPriceTry(usdPrice, usdTryRate, multiplier);
      const variantStocks = stockByVariant.get(mapping.ikas_variant_id) || new Map();
      const locations = stockLocations.map((location) => {
        const quantity = Number(variantStocks.get(location.id) || 0);
        const valueTry = quantity * unitTryPrice;
        locationTotals[location.id].units += quantity;
        locationTotals[location.id].valueTry += valueTry;
        return {
          locationId: location.id,
          name: location.name,
          quantity,
          valueTry,
        };
      });

      const totalQuantity = locations.reduce((sum, entry) => sum + entry.quantity, 0);
      const rowValueTry = locations.reduce((sum, entry) => sum + entry.valueTry, 0);
      totalValueTry += rowValueTry;
      totalUnits += totalQuantity;

      items.push({
        mappingId: mapping.id,
        cardName,
        kartfiyatCardId: mapping.kartfiyat_card_id,
        ikasProductId: mapping.ikas_product_id,
        ikasVariantId: mapping.ikas_variant_id,
        usdPrice,
        unitTryPrice,
        totalQuantity,
        totalValueTry: rowValueTry,
        locations,
      });
    } catch (error) {
      skipped.push({
        mappingId: mapping.id,
        cardName: mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`,
        kartfiyatCardId: mapping.kartfiyat_card_id,
        reason: error.message,
      });
    }

    if (REQUEST_DELAY_MS > 0) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  items.sort((left, right) => right.totalValueTry - left.totalValueTry);

  return {
    generatedAt: new Date().toISOString(),
    usdTryRate,
    multiplier,
    summary: {
      productCount: items.length,
      skippedCount: skipped.length,
      totalMappings: mappings.length,
      totalUnits,
      totalValueTry,
      locations: stockLocations.map((location) => locationTotals[location.id]),
    },
    items,
    skipped,
  };
}

module.exports = {
  getPortfolioValuation,
};
