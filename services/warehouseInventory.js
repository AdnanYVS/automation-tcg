const { getAllMappings } = require('../db');
const { listStockLocations, listAllVariantStocks } = require('./ikas');

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

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function matchesSearch(item, query) {
  if (!query) return true;
  const haystack = [
    item.cardName,
    item.kartfiyatCardId,
    item.barcode,
    item.sku,
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

async function getWarehouseInventory({
  locationId = null,
  search = null,
  inStockOnly = false,
} = {}) {
  const mappings = getAllMappings().filter((mapping) => mapping.ikas_variant_id);
  const [stockLocations, stockRows] = await Promise.all([
    listStockLocations(),
    listAllVariantStocks(),
  ]);
  const stockByVariant = buildStockIndex(stockRows);
  const searchQuery = normalizeSearch(search);

  const items = [];

  for (const mapping of mappings) {
    const variantStocks = stockByVariant.get(mapping.ikas_variant_id) || new Map();
    const locations = stockLocations.map((location) => ({
      locationId: location.id,
      name: location.name,
      quantity: Number(variantStocks.get(location.id) || 0),
    }));

    const totalQuantity = locations.reduce((sum, entry) => sum + entry.quantity, 0);
    const locationQuantity = locationId
      ? Number(locations.find((entry) => entry.locationId === locationId)?.quantity || 0)
      : totalQuantity;

    if (inStockOnly && locationQuantity <= 0) continue;

    const item = {
      mappingId: mapping.id,
      cardName: mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`,
      kartfiyatCardId: mapping.kartfiyat_card_id,
      ikasProductId: mapping.ikas_product_id,
      ikasVariantId: mapping.ikas_variant_id,
      barcode: mapping.barcode,
      sku: null,
      priceManual: Boolean(mapping.price_manual),
      unitTryPrice: mapping.last_try_price,
      totalQuantity,
      locations,
      importedAt: mapping.created_at,
    };

    if (!matchesSearch(item, searchQuery)) continue;
    items.push(item);
  }

  items.sort((left, right) => {
    if (right.totalQuantity !== left.totalQuantity) {
      return right.totalQuantity - left.totalQuantity;
    }
    return left.cardName.localeCompare(right.cardName, 'tr');
  });

  const locationTotals = stockLocations.map((location) => {
    const units = items.reduce((sum, item) => {
      const qty = item.locations.find((entry) => entry.locationId === location.id)?.quantity || 0;
      return sum + qty;
    }, 0);
    const productCount = items.filter((item) =>
      (item.locations.find((entry) => entry.locationId === location.id)?.quantity || 0) > 0,
    ).length;

    return {
      id: location.id,
      name: location.name,
      units,
      productCount,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    locations: stockLocations,
    summary: {
      totalMappings: mappings.length,
      listedProducts: items.length,
      totalUnits: items.reduce((sum, item) => sum + item.totalQuantity, 0),
      inStockProducts: items.filter((item) => item.totalQuantity > 0).length,
      outOfStockProducts: items.filter((item) => item.totalQuantity <= 0).length,
      locationTotals,
    },
    items,
  };
}

module.exports = {
  getWarehouseInventory,
};
