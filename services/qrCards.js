const { getCardById, getCardImageUrl } = require('./kartfiyat');
const {
  findByQrToken,
  findMappingById,
  ensureQrTokenForMapping,
  insertInventoryEvent,
} = require('../db');
const {
  listStockLocations,
  listAllVariantStocks,
  adjustVariantStock,
} = require('./ikas/products');
const { buildQrUrl } = require('./qrToken');

function buildStockSummary(stockRows, mapping, locations) {
  const variantRows = stockRows.filter(
    (row) => row.variantId === mapping.ikas_variant_id,
  );
  const byLocation = locations.map((location) => {
    const match = variantRows.find((row) => row.stockLocationId === location.id);
    return {
      locationId: location.id,
      name: location.name,
      quantity: Number(match?.stockCount || 0),
    };
  });
  const totalQuantity = byLocation.reduce((sum, entry) => sum + entry.quantity, 0);
  return { totalQuantity, byLocation };
}

async function getQrCardPayload(token, { isAdmin = false } = {}) {
  const mapping = findByQrToken(token);
  if (!mapping) {
    return null;
  }

  let card = null;
  try {
    card = await getCardById(mapping.kartfiyat_card_id);
  } catch (error) {
    console.warn(`[qr] KartFiyat detayı alınamadı (${mapping.kartfiyat_card_id}):`, error.message);
  }

  const [locations, stockRows] = await Promise.all([
    listStockLocations(),
    listAllVariantStocks(),
  ]);
  const stock = buildStockSummary(stockRows, mapping, locations);
  const qrToken = mapping.qr_token || ensureQrTokenForMapping(mapping.id);

  return {
    qrToken,
    qrUrl: buildQrUrl(qrToken),
    mappingId: mapping.id,
    kartfiyatCardId: mapping.kartfiyat_card_id,
    cardName: mapping.card_name || card?.name || `Kart #${mapping.kartfiyat_card_id}`,
    priceLabel: mapping.price_label || null,
    sellPriceTry: mapping.last_try_price,
    priceManual: Boolean(mapping.price_manual),
    imageUrl: card ? getCardImageUrl(card) : null,
    setName: card?.category?.name || null,
    sku: mapping.sku || null,
    barcode: mapping.barcode || null,
    inStock: stock.totalQuantity > 0,
    stock,
    isAdmin,
  };
}

async function recordStoreSale(token, {
  stockLocationId,
  sellPriceTry = null,
  note = null,
} = {}) {
  const mapping = findByQrToken(token);
  if (!mapping) {
    throw new Error('QR kodu geçersiz veya kart bulunamadı.');
  }
  if (!mapping.ikas_product_id || !mapping.ikas_variant_id) {
    throw new Error('Bu kart ikas ile eşleşmemiş.');
  }
  if (!stockLocationId) {
    throw new Error('Stok lokasyonu zorunludur.');
  }

  const locations = await listStockLocations();
  const location = locations.find((entry) => entry.id === stockLocationId);
  if (!location) {
    throw new Error('Geçersiz stok lokasyonu.');
  }

  const stockRows = await listAllVariantStocks();
  const stock = buildStockSummary(stockRows, mapping, locations);
  const locationQty = stock.byLocation.find((entry) => entry.locationId === stockLocationId)?.quantity || 0;
  if (locationQty <= 0) {
    throw new Error(`${location.name} lokasyonunda stok yok.`);
  }

  const stockResult = await adjustVariantStock({
    productId: mapping.ikas_product_id,
    variantId: mapping.ikas_variant_id,
    stockLocationId,
    delta: -1,
    sku: mapping.sku || null,
  });

  const parsedPrice = sellPriceTry !== null && sellPriceTry !== undefined && String(sellPriceTry).trim() !== ''
    ? Number(sellPriceTry)
    : null;
  const finalPrice = Number.isFinite(parsedPrice) && parsedPrice > 0
    ? parsedPrice
    : mapping.last_try_price;

  const trimmedNote = note ? String(note).trim() : '';
  insertInventoryEvent({
    mappingId: mapping.id,
    kartfiyatCardId: mapping.kartfiyat_card_id,
    ikasVariantId: stockResult.variantId || mapping.ikas_variant_id,
    stockLocationId,
    quantity: 1,
    eventType: 'sale_store',
    note: trimmedNote || null,
    unitPrice: finalPrice,
  });

  const refreshed = await getQrCardPayload(token, { isAdmin: true });
  return {
    sale: {
      sellPriceTry: finalPrice,
      stockLocationId,
      locationName: location.name,
      previousStock: stockResult.previousStock,
      newStock: stockResult.newStock,
    },
    card: refreshed,
  };
}

function getLabelPayload({ token = null, mappingId = null } = {}) {
  let mapping = null;
  if (token) mapping = findByQrToken(token);
  if (!mapping && mappingId) mapping = findMappingById(mappingId);
  if (!mapping) return null;

  const qrToken = mapping.qr_token || ensureQrTokenForMapping(mapping.id);
  return {
    mappingId: mapping.id,
    qrToken,
    qrUrl: buildQrUrl(qrToken),
    cardName: mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`,
    sellPriceTry: mapping.last_try_price,
    sku: mapping.sku || null,
    priceLabel: mapping.price_label || null,
  };
}

module.exports = {
  getQrCardPayload,
  recordStoreSale,
  getLabelPayload,
  buildQrUrl,
};
