const { getAllMappings } = require('../db');
const { getCardById, getPriceChartingUsd } = require('./kartfiyat');
const { listStockLocations, listAllVariantStocks } = require('./ikas');
const { getUsdTryRate } = require('./exchangeRate');
const { calculateInventoryValueTry } = require('./pricing');

const REQUEST_DELAY_MS = Number(
  process.env.PORTFOLIO_KARTFIYAT_DELAY_MS
  || process.env.KARTFIYAT_REQUEST_DELAY_MS
  || 50,
);

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

function accumulateLocations({
  stockLocations,
  variantStocks,
  unitTryPrice,
  locationTotals,
}) {
  return stockLocations.map((location) => {
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
}

async function resolveUsdPrice(mapping) {
  // 1) Canlı PriceCharting
  try {
    const card = await getCardById(mapping.kartfiyat_card_id);
    const liveUsd = getPriceChartingUsd(card, { label: mapping.price_label });
    if (liveUsd) {
      return {
        usdPrice: liveUsd,
        cardName: card.name || mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`,
        source: 'live',
      };
    }
  } catch (error) {
    // Snapshot'a düş
    return {
      usdPrice: Number(mapping.last_usd_price) > 0 ? Number(mapping.last_usd_price) : null,
      cardName: mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`,
      source: Number(mapping.last_usd_price) > 0 ? 'snapshot' : null,
      error: error.message,
    };
  }

  // 2) Son bilinen PC snapshot (satış çarpanı uygulanmamış USD)
  if (Number(mapping.last_usd_price) > 0) {
    return {
      usdPrice: Number(mapping.last_usd_price),
      cardName: mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`,
      source: 'snapshot',
    };
  }

  return {
    usdPrice: null,
    cardName: mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`,
    source: null,
  };
}

async function getPortfolioValuation() {
  const allMappings = getAllMappings();
  const mappings = allMappings.filter((mapping) => mapping.ikas_variant_id);
  const [usdTryRate, stockLocations, stockRows] = await Promise.all([
    getUsdTryRate(),
    listStockLocations(),
    listAllVariantStocks(),
  ]);
  const stockByVariant = buildStockIndex(stockRows);
  const locationTotals = initLocationTotals(stockLocations);

  const items = [];
  const skipped = [];
  const skipReasons = {};
  let totalValueTry = 0;
  let totalUnits = 0;
  let totalValueUsd = 0;
  let liveCount = 0;
  let snapshotCount = 0;
  let manualSkippedCount = 0;

  function skip(entry) {
    skipped.push(entry);
    const key = entry.reason || 'bilinmeyen';
    skipReasons[key] = (skipReasons[key] || 0) + 1;
  }

  for (const mapping of mappings) {
    try {
      if (mapping.price_manual) {
        manualSkippedCount += 1;
        skip({
          mappingId: mapping.id,
          cardName: mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`,
          kartfiyatCardId: mapping.kartfiyat_card_id,
          reason: 'Manuel fiyat (envanter dışı)',
        });
        continue;
      }

      const resolved = await resolveUsdPrice(mapping);
      if (!resolved.usdPrice) {
        skip({
          mappingId: mapping.id,
          cardName: resolved.cardName,
          kartfiyatCardId: mapping.kartfiyat_card_id,
          reason: resolved.error
            ? `Kartfiyat hatası / PC yok (${resolved.error})`
            : 'PriceCharting fiyatı yok',
        });
        if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
        continue;
      }

      const unitTryPrice = calculateInventoryValueTry(resolved.usdPrice, usdTryRate);
      const variantStocks = stockByVariant.get(mapping.ikas_variant_id) || new Map();
      const locations = accumulateLocations({
        stockLocations,
        variantStocks,
        unitTryPrice,
        locationTotals,
      });

      const totalQuantity = locations.reduce((sum, entry) => sum + entry.quantity, 0);
      const rowValueTry = locations.reduce((sum, entry) => sum + entry.valueTry, 0);
      totalValueTry += rowValueTry;
      totalUnits += totalQuantity;
      totalValueUsd += resolved.usdPrice * totalQuantity;

      if (resolved.source === 'live') liveCount += 1;
      else snapshotCount += 1;

      items.push({
        mappingId: mapping.id,
        cardName: resolved.cardName,
        kartfiyatCardId: mapping.kartfiyat_card_id,
        ikasProductId: mapping.ikas_product_id,
        ikasVariantId: mapping.ikas_variant_id,
        usdPrice: resolved.usdPrice,
        unitTryPrice,
        priceManual: false,
        priceSource: resolved.source,
        totalQuantity,
        totalValueTry: rowValueTry,
        totalValueUsd: resolved.usdPrice * totalQuantity,
        locations,
      });
    } catch (error) {
      skip({
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
    valuationMode: 'pricecharting',
    summary: {
      productCount: items.length,
      skippedCount: skipped.length,
      totalMappings: mappings.length,
      allMappingsCount: allMappings.length,
      withoutVariantCount: allMappings.length - mappings.length,
      liveCount,
      snapshotCount,
      manualSkippedCount,
      totalUnits,
      totalValueTry,
      totalValueUsd,
      skipReasons,
      locations: stockLocations.map((location) => locationTotals[location.id]),
    },
    items,
    skipped,
  };
}

module.exports = {
  getPortfolioValuation,
};
