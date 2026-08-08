const { getAllMappings } = require('../db');
const { listStockLocations, listAllVariantStocks, getCachedProductCatalog } = require('./ikas');
const { buildQrUrl } = require('./qrToken');

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

function buildCatalogIndex(catalog) {
  const byVariantId = new Map();

  for (const product of catalog) {
    for (const variant of product.variants || []) {
      if (!variant?.id) continue;
      byVariantId.set(variant.id, { product, variant });
    }
  }

  return byVariantId;
}

function parseKartfiyatCardIdFromSku(sku) {
  const match = String(sku || '').match(/^KF-(\d+)/i);
  return match ? match[1] : null;
}

function extractPriceLabelFromProductName(name) {
  const nameMatch = String(name || '').match(
    /\[((?:PSA|BGS|CGC|SGC|ACE|TAG|Grade)\s+[\d.]+)\]/i,
  );
  return nameMatch ? nameMatch[1] : null;
}

function isAutomationProductSku(sku) {
  return /^KF-/i.test(String(sku || ''));
}

function buildLocationQuantities(stockLocations, variantStocks) {
  return stockLocations.map((location) => ({
    locationId: location.id,
    name: location.name,
    quantity: Number(variantStocks.get(location.id) || 0),
  }));
}

function buildInventoryItem({
  mapping = null,
  product = null,
  variant = null,
  stockLocations,
  stockByVariant,
}) {
  const variantId = mapping?.ikas_variant_id || variant?.id;
  const variantStocks = stockByVariant.get(variantId) || new Map();
  const locations = buildLocationQuantities(stockLocations, variantStocks);
  const totalQuantity = locations.reduce((sum, entry) => sum + entry.quantity, 0);
  const sku = mapping?.sku || variant?.sku || null;
  const kartfiyatCardId = mapping?.kartfiyat_card_id || parseKartfiyatCardIdFromSku(sku);

  return {
    mappingId: mapping?.id || null,
    hasMapping: Boolean(mapping),
    cardName: mapping?.card_name || product?.name || (sku ? `Ürün ${sku}` : `Varyant ${variantId}`),
    kartfiyatCardId,
    ikasProductId: mapping?.ikas_product_id || product?.id || null,
    ikasVariantId: variantId,
    barcode: mapping?.barcode || variant?.barcodeList?.[0] || null,
    sku,
    qrToken: mapping?.qr_token || null,
    qrUrl: mapping?.qr_token ? buildQrUrl(mapping.qr_token) : null,
    priceManual: mapping ? Boolean(mapping.price_manual) : false,
    unitTryPrice: mapping?.last_try_price ?? null,
    totalQuantity,
    locations,
    importedAt: mapping?.created_at || null,
  };
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
    item.ikasProductId,
    item.ikasVariantId,
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function collectVariantIds({ mappings, catalogByVariantId, stockByVariant }) {
  const variantIds = new Set();

  for (const mapping of mappings) {
    if (mapping.ikas_variant_id) {
      variantIds.add(mapping.ikas_variant_id);
    }
  }

  for (const [variantId, { variant }] of catalogByVariantId) {
    if (isAutomationProductSku(variant.sku)) {
      variantIds.add(variantId);
    }
  }

  // Stok kaydı olan ama katalog/mapping dışı kalan varyantlar (nadir)
  for (const variantId of stockByVariant.keys()) {
    variantIds.add(variantId);
  }

  return variantIds;
}

async function getWarehouseInventory({
  locationId = null,
  search = null,
  inStockOnly = false,
} = {}) {
  // ikas'tan silinmiş ürünleri panelde gösterme
  const mappings = getAllMappings().filter(
    (mapping) => mapping.ikas_variant_id && !mapping.ikas_missing,
  );
  const mappingByVariantId = new Map(
    mappings.map((mapping) => [mapping.ikas_variant_id, mapping]),
  );
  const mappingByKartfiyatId = new Map();
  for (const mapping of mappings) {
    if (!mapping.kartfiyat_card_id) continue;
    const key = `${mapping.kartfiyat_card_id}::${mapping.price_label || ''}`;
    if (!mappingByKartfiyatId.has(key)) {
      mappingByKartfiyatId.set(key, mapping);
    }
  }

  const [stockLocations, stockRows, catalog] = await Promise.all([
    listStockLocations(),
    listAllVariantStocks(),
    getCachedProductCatalog(),
  ]);
  const stockByVariant = buildStockIndex(stockRows);
  const catalogByVariantId = buildCatalogIndex(catalog);
  const variantIds = collectVariantIds({ mappings, catalogByVariantId, stockByVariant });
  const searchQuery = normalizeSearch(search);

  const items = [];

  for (const variantId of variantIds) {
    const catalogEntry = catalogByVariantId.get(variantId) || null;
    let mapping = mappingByVariantId.get(variantId) || null;

    if (!mapping && catalogEntry) {
      const parsed = parseKartfiyatCardIdFromSku(catalogEntry.variant?.sku);
      const priceLabel = extractPriceLabelFromProductName(catalogEntry.product?.name);
      if (parsed) {
        mapping = mappingByKartfiyatId.get(`${parsed}::${priceLabel || ''}`)
          || mappingByKartfiyatId.get(`${parsed}::`);
      }
    }

    // Yalnızca stok satırı olan, KF-SKU'suz ve mapping'siz ürünleri gösterme
    if (!mapping && !catalogEntry) continue;
    // Yerel mapping var ama ikas kataloğunda yoksa (silinmiş ürün) gösterme
    if (mapping && !catalogEntry) continue;
    if (!mapping && catalogEntry && !isAutomationProductSku(catalogEntry.variant.sku)) continue;

    const item = buildInventoryItem({
      mapping,
      product: catalogEntry?.product || null,
      variant: catalogEntry?.variant || { id: variantId },
      stockLocations,
      stockByVariant,
    });

    const locationQuantity = locationId
      ? Number(item.locations.find((entry) => entry.locationId === locationId)?.quantity || 0)
      : item.totalQuantity;

    if (inStockOnly && locationQuantity <= 0) continue;
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

  const mappedProducts = items.filter((item) => item.hasMapping).length;
  const unmappedProducts = items.length - mappedProducts;

  return {
    generatedAt: new Date().toISOString(),
    locations: stockLocations,
    summary: {
      totalMappings: mappings.length,
      mappedProducts,
      unmappedProducts,
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
