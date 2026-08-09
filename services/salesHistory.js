const { getAllMappings, getInventoryEvents } = require('../db');
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
    sale.note,
    sale.sourceLabel,
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function buildStoreSales({ locationId, locationIndex, limit }) {
  const events = getInventoryEvents({
    eventType: 'sale_store',
    stockLocationId: locationId || null,
    limit: Math.max(limit, 500),
  });

  return events.map((event) => {
    const unitPrice = Number(event.unit_price);
    const hasUnitPrice = Number.isFinite(unitPrice) && unitPrice > 0;
    return {
      source: 'store',
      sourceLabel: 'Mağaza (QR)',
      orderId: null,
      orderNumber: null,
      orderStatus: null,
      orderPaymentStatus: null,
      soldAt: event.created_at,
      locationId: event.stock_location_id || null,
      locationName: locationIndex.get(event.stock_location_id) || event.stock_location_id || 'Bilinmiyor',
      quantity: Number(event.quantity || 0),
      unitPrice: hasUnitPrice ? unitPrice : null,
      totalPrice: hasUnitPrice ? unitPrice * Number(event.quantity || 0) : null,
      lineStatus: null,
      variantId: event.ikas_variant_id || null,
      variantName: null,
      sku: null,
      barcode: event.barcode || null,
      kartfiyatCardId: event.kartfiyat_card_id || null,
      cardName: event.card_name || (event.kartfiyat_card_id ? `Kart #${event.kartfiyat_card_id}` : 'Bilinmeyen ürün'),
      mappingId: event.mapping_id || null,
      isMapped: Boolean(event.mapping_id),
      note: event.note || null,
      eventId: event.id,
    };
  });
}

async function buildWebSales({ locationId, locationIndex, variantIndex }) {
  const orderResult = await listAllOrders({ stockLocationId: locationId || null });
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

      sales.push({
        source: 'web',
        sourceLabel: 'ikas online',
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
        note: 'ikas online',
        eventId: null,
      });
    }
  }

  return sales;
}

async function getSalesHistory({
  locationId = null,
  search = null,
  limit = 200,
} = {}) {
  const mappings = getAllMappings();
  const variantIndex = buildVariantIndex(mappings);
  const stockLocations = await listStockLocations();
  const locationIndex = buildLocationIndex(stockLocations);
  const searchQuery = normalizeSearch(search);

  const [webSales, storeSales] = await Promise.all([
    buildWebSales({ locationId, locationIndex, variantIndex }),
    Promise.resolve(buildStoreSales({ locationId, locationIndex, limit })),
  ]);

  const sales = [...webSales, ...storeSales]
    .filter((sale) => matchesSale(sale, searchQuery))
    .sort((left, right) => new Date(right.soldAt) - new Date(left.soldAt));

  const limitedSales = sales.slice(0, limit);
  const soldUnits = sales.reduce((sum, sale) => sum + sale.quantity, 0);
  const soldRevenue = sales.reduce((sum, sale) => sum + Number(sale.totalPrice || 0), 0);
  const mappedSales = sales.filter((sale) => sale.isMapped);
  const unmappedSales = sales.filter((sale) => !sale.isMapped);
  const storeCount = sales.filter((sale) => sale.source === 'store').length;
  const webCount = sales.filter((sale) => sale.source === 'web').length;

  const byLocation = stockLocations.map((location) => {
    const locationSales = sales.filter((sale) => sale.locationId === location.id);
    return {
      id: location.id,
      name: location.name,
      orders: new Set(locationSales.map((sale) => sale.orderId || `store-${sale.eventId}`)).size,
      units: locationSales.reduce((sum, sale) => sum + sale.quantity, 0),
      revenue: locationSales.reduce((sum, sale) => sum + Number(sale.totalPrice || 0), 0),
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
    existing.totalRevenue += Number(sale.totalPrice || 0);
    if (new Date(sale.soldAt) > new Date(existing.lastSoldAt)) {
      existing.lastSoldAt = sale.soldAt;
    }
    aggregatedByCard.set(key, existing);
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalOrders: new Set(sales.map((sale) => sale.orderId || `store-${sale.eventId}`)).size,
      totalLineItems: sales.length,
      soldUnits,
      soldRevenue,
      mappedLineItems: mappedSales.length,
      unmappedLineItems: unmappedSales.length,
      storeSales: storeCount,
      webSales: webCount,
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
