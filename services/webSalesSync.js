const {
  getAllMappings,
  insertInventoryEvent,
  getExistingOrderLineKeys,
  setSyncState,
  getSyncState,
} = require('../db');
const { listAllOrders, isCountableOrder, isCountableLineItem } = require('./ikas/orders');

const SYNC_STATE_KEY = 'web_sales_last_sync_at';

function buildMappingIndex(mappings) {
  const byVariantId = new Map();
  const bySku = new Map();
  const byBarcode = new Map();
  for (const mapping of mappings) {
    if (mapping.ikas_variant_id) byVariantId.set(mapping.ikas_variant_id, mapping);
    if (mapping.sku) bySku.set(mapping.sku, mapping);
    if (mapping.barcode) byBarcode.set(mapping.barcode, mapping);
  }
  return { byVariantId, bySku, byBarcode };
}

function resolveMapping(index, lineItem) {
  const variant = lineItem.variant || {};
  if (variant.id && index.byVariantId.has(variant.id)) {
    return index.byVariantId.get(variant.id);
  }
  // Ürün ikas'ta yeniden oluşturulmuşsa variant ID değişebilir; SKU/barkod ile dene.
  if (variant.sku && index.bySku.has(variant.sku)) {
    return index.bySku.get(variant.sku);
  }
  for (const barcode of variant.barcodeList || []) {
    if (barcode && index.byBarcode.has(barcode)) {
      return index.byBarcode.get(barcode);
    }
  }
  return null;
}

function saleKeyFor(order, lineItem) {
  return `sale_web:${order.id}:${lineItem.id}`;
}

function cancelKeyFor(order, lineItem) {
  return `sale_web_cancel:${order.id}:${lineItem.id}`;
}

/**
 * ikas siparişlerini tarar; web satışlarını inventory_events defterine işler.
 * - Sipariş satırı bazlı tekilleştirme (order_line_key) sayesinde tekrar çalıştırmak güvenlidir.
 * - Daha önce kaydedilmiş bir satış sonradan iptal/iade olursa ters kayıt (sale_web_cancel) düşer.
 * - Stok YAZMAZ; yalnızca kayıt tutar (stok yönetimi ikas'ta).
 */
async function syncWebSales() {
  const startedAt = new Date().toISOString();
  const mappings = getAllMappings();
  const mappingIndex = buildMappingIndex(mappings);
  const existingKeys = getExistingOrderLineKeys('sale_web');

  const { orders } = await listAllOrders();

  const stats = {
    ordersScanned: orders.length,
    lineItemsScanned: 0,
    recorded: 0,
    cancelled: 0,
    skippedExisting: 0,
    unmappedRecorded: 0,
    startedAt,
  };

  for (const order of orders) {
    const orderCountable = isCountableOrder(order);

    for (const lineItem of order.orderLineItems || []) {
      if (!lineItem?.id) continue;
      stats.lineItemsScanned += 1;

      const saleKey = saleKeyFor(order, lineItem);
      const cancelKey = cancelKeyFor(order, lineItem);
      const countable = orderCountable && isCountableLineItem(lineItem);
      const variantId = lineItem.variant?.id || null;
      const mapping = resolveMapping(mappingIndex, lineItem);
      const quantity = Number(lineItem.quantity || 0);
      const locationId = lineItem.stockLocationId || order.stockLocationId || null;
      const unitPrice = Number(lineItem.finalUnitPrice ?? lineItem.finalPrice ?? 0) || null;
      const soldAt = order.orderedAt || order.createdAt || null;
      const variantName = lineItem.variant?.name || 'Bilinmeyen ürün';

      if (countable) {
        if (existingKeys.has(saleKey)) {
          stats.skippedExisting += 1;
          continue;
        }
        if (quantity <= 0) continue;

        insertInventoryEvent({
          mappingId: mapping?.id || null,
          kartfiyatCardId: mapping?.kartfiyat_card_id || null,
          ikasVariantId: variantId,
          stockLocationId: locationId,
          quantity,
          eventType: 'sale_web',
          orderId: order.id,
          orderNumber: order.orderNumber || null,
          note: mapping ? 'Web satışı' : `Web satışı · ${variantName}`,
          orderLineKey: saleKey,
          unitPrice,
          createdAt: soldAt ? new Date(soldAt).toISOString() : null,
        });
        existingKeys.add(saleKey);
        stats.recorded += 1;
        if (!mapping) stats.unmappedRecorded += 1;
        continue;
      }

      // Satış daha önce deftere işlendiyse ve sipariş artık geçersizse ters kayıt düş.
      if (existingKeys.has(saleKey) && !existingKeys.has(cancelKey)) {
        insertInventoryEvent({
          mappingId: mapping?.id || null,
          kartfiyatCardId: mapping?.kartfiyat_card_id || null,
          ikasVariantId: variantId,
          stockLocationId: locationId,
          quantity,
          eventType: 'sale_web_cancel',
          orderId: order.id,
          orderNumber: order.orderNumber || null,
          note: `İptal/iade · sipariş: ${order.status}, satır: ${lineItem.status}`,
          orderLineKey: cancelKey,
          unitPrice,
        });
        existingKeys.add(cancelKey);
        stats.cancelled += 1;
      }
    }
  }

  setSyncState(SYNC_STATE_KEY, startedAt);
  stats.finishedAt = new Date().toISOString();
  return stats;
}

function getLastWebSalesSyncAt() {
  return getSyncState(SYNC_STATE_KEY);
}

module.exports = {
  syncWebSales,
  getLastWebSalesSyncAt,
};
