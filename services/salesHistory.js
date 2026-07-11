const { getAllMappings } = require('../db');
const { listStockLocations } = require('./ikas');
const { listAllOrders, isCountableOrder, isCountableLineItem } = require('./ikas/orders');

function buildVariantIndex(mappings) {
  const byVariantId = new Map();
  for (const mapping of mappings) {
    if (mapping.ikas_variant_id) {
      byVariantId.set(mapping.ikas_variant_id, mapping);
    }
  }
  return byVariantId;
}

function buildLocationIndex(stockLocations) {
  return new Map(stockLocations.map((location) => [location.id, location.name]));
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function matchesSale(sale, query) {
  if (!query) return true;
  const haystack = [
    sale.cardName,
    sale.variantName,
    sale.kartfiyatCardId,
    sale.barcode,
    sale.orderNumber,
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

async function getSalesHistory({
  locationId = null,
  search = null,
  limit = 200,
} = {}) {
  const mappings = getAllMappings();
  const variantIndex = buildVariantIndex(mappings);
  const [stockLocations, orderResult] = await Promise.all([
    listStockLocations(),
    listAllOrders({ stockLocationId: locationId || null }),
  ]);
  const locationIndex = buildLocationIndex(stockLocations);
  const searchQuery = normalizeSearch(search);

  const sales = [];

  for (const order of orderResult.orders) {
    if (!isCountableOrder(order)) continue;

    for (const lineItem of order.orderLineItems || []) {
      if (!isCountableLineItem(lineItem)) continue;

      const variantId = lineItem.variant?.id;
      const mapping = variantId ? variantIndex.get(variantId) : null;
      const lineLocationId = lineItem.stockLocationId || order.stockLocationId || null;
      const locationName = locationIndex.get(lineLocationId)
        || order.stockLocation?.name
        || 'Bilinmiyor';

      if (locationId && lineLocationId !== locationId) continue;

      const sale = {
        orderId: order.id,
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        orderPaymentStatus: order.orderPaymentStatus,
        soldAt: order.orderedAt || order.createdAt,
        locationId: lineLocationId,
        locationName,
        quantity: Number(lineItem.quantity || 0),
        unitPrice: Number(lineItem.finalUnitPrice ?? lineItem.finalPrice ?? 0),
        totalPrice: Number(lineItem.finalPrice ?? 0),
        lineStatus: lineItem.status,
        variantId,
        variantName: lineItem.variant?.name || null,
        sku: lineItem.variant?.sku || null,
        barcode: lineItem.variant?.barcodeList?.[0] || mapping?.barcode || null,
        kartfiyatCardId: mapping?.kartfiyat_card_id || null,
        cardName: mapping?.card_name || lineItem.variant?.name || 'Bilinmeyen ürün',
        mappingId: mapping?.id || null,
        isMapped: Boolean(mapping),
      };

      if (!matchesSale(sale, searchQuery)) continue;
      sales.push(sale);
    }
  }

  sales.sort((left, right) => new Date(right.soldAt) - new Date(left.soldAt));

  const limitedSales = sales.slice(0, limit);
  const soldUnits = sales.reduce((sum, sale) => sum + sale.quantity, 0);
  const soldRevenue = sales.reduce((sum, sale) => sum + sale.totalPrice, 0);
  const mappedSales = sales.filter((sale) => sale.isMapped);
  const unmappedSales = sales.filter((sale) => !sale.isMapped);

  const byLocation = stockLocations.map((location) => {
    const locationSales = sales.filter((sale) => sale.locationId === location.id);
    return {
      id: location.id,
      name: location.name,
      orders: new Set(locationSales.map((sale) => sale.orderId)).size,
      units: locationSales.reduce((sum, sale) => sum + sale.quantity, 0),
      revenue: locationSales.reduce((sum, sale) => sum + sale.totalPrice, 0),
    };
  });

  const aggregatedByCard = new Map();
  for (const sale of sales) {
    const key = sale.variantId || `${sale.cardName}:${sale.barcode || 'unknown'}`;
    const existing = aggregatedByCard.get(key) || {
      cardName: sale.cardName,
      kartfiyatCardId: sale.kartfiyatCardId,
      barcode: sale.barcode,
      variantId: sale.variantId,
      totalQuantity: 0,
      totalRevenue: 0,
      lastSoldAt: sale.soldAt,
      isMapped: sale.isMapped,
    };
    existing.totalQuantity += sale.quantity;
    existing.totalRevenue += sale.totalPrice;
    if (new Date(sale.soldAt) > new Date(existing.lastSoldAt)) {
      existing.lastSoldAt = sale.soldAt;
    }
    aggregatedByCard.set(key, existing);
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalOrders: new Set(sales.map((sale) => sale.orderId)).size,
      totalLineItems: sales.length,
      soldUnits,
      soldRevenue,
      mappedLineItems: mappedSales.length,
      unmappedLineItems: unmappedSales.length,
      byLocation,
    },
    sales: limitedSales,
    soldCards: Array.from(aggregatedByCard.values())
      .sort((left, right) => right.totalQuantity - left.totalQuantity),
  };
}

module.exports = {
  getSalesHistory,
};
