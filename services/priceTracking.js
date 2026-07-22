const {
  getAutoTrackedMappings,
  updateMappingPriceSnapshot,
  updateMappingIkasIds,
  markMappingIkasMissing,
  rejectPendingAlertsForMapping,
  upsertPendingPriceAlert,
  getPriceChangeAlerts,
  getPriceChangeAlertById,
  resolvePriceChangeAlert,
  countPendingPriceAlerts,
  getLatestPriceCheckSummary,
} = require('../db');
const { getCardById, getPriceChartingUsd, buildKartfiyatSku } = require('./kartfiyat');
const { updateVariantPrices, listAllProducts, findProductBySkuOrBarcode } = require('./ikas');
const { getUsdTryRate } = require('./exchangeRate');
const { calculateFinalPriceTry, getPriceMultiplierForCard } = require('./pricing');

const REQUEST_DELAY_MS = Number(process.env.KARTFIYAT_REQUEST_DELAY_MS || 200);
const THRESHOLD_PERCENT = Number(process.env.PRICE_CHANGE_THRESHOLD_PERCENT || 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateChangePercent(oldPrice, newPrice) {
  if (!oldPrice || oldPrice <= 0) return 0;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

function exceedsThreshold(changePercent, threshold = THRESHOLD_PERCENT) {
  return Math.abs(changePercent) >= threshold;
}

function isMissingProductError(error) {
  const message = error?.message || String(error || '');
  return /ikas ürünü bulunamadı|INVALID_PRODUCT_ID/i.test(message);
}

function markMissingAndRejectAlerts(mappingId, reason) {
  markMappingIkasMissing(mappingId, true);
  const rejected = rejectPendingAlertsForMapping(mappingId);
  console.warn(
    `[price] Mapping ${mappingId} ikas'ta yok olarak işaretlendi`
    + (reason ? ` (${reason})` : '')
    + (rejected ? `, ${rejected} pending alert reddedildi` : ''),
  );
  return rejected;
}

async function checkMappingPrice(mapping, { usdTryRate, threshold }) {
  if (mapping.price_manual) {
    return { status: 'skipped', reason: 'Manuel fiyat' };
  }

  if (mapping.ikas_missing) {
    return { status: 'skipped', reason: 'ikas ürünü yok' };
  }

  if (!mapping.ikas_product_id) {
    return { status: 'skipped', reason: 'ikas_product_id yok' };
  }

  const card = await getCardById(mapping.kartfiyat_card_id);
  const { multiplier } = getPriceMultiplierForCard(card);
  const usdPrice = getPriceChartingUsd(card, { label: mapping.price_label });
  if (!usdPrice) {
    return { status: 'skipped', reason: 'PriceCharting fiyatı yok' };
  }

  const tryPrice = calculateFinalPriceTry(usdPrice, usdTryRate, multiplier);
  const cardName = card.name || mapping.card_name || `Kart #${mapping.kartfiyat_card_id}`;
  const checkedAt = new Date().toISOString();

  if (mapping.last_try_price === null || mapping.last_try_price === undefined) {
    updateMappingPriceSnapshot({
      mappingId: mapping.id,
      cardName,
      usdPrice,
      tryPrice,
      checkedAt,
    });
    return { status: 'baseline', cardName, tryPrice };
  }

  const changePercent = calculateChangePercent(mapping.last_try_price, tryPrice);

  if (exceedsThreshold(changePercent, threshold)) {
    const alert = upsertPendingPriceAlert({
      mappingId: mapping.id,
      kartfiyatCardId: mapping.kartfiyat_card_id,
      cardName,
      oldUsdPrice: mapping.last_usd_price ?? usdPrice,
      newUsdPrice: usdPrice,
      oldTryPrice: mapping.last_try_price,
      newTryPrice: tryPrice,
      changePercent,
      usdTryRate,
    });

    updateMappingPriceSnapshot({
      mappingId: mapping.id,
      cardName,
      usdPrice: mapping.last_usd_price ?? usdPrice,
      tryPrice: mapping.last_try_price,
      checkedAt,
    });

    return {
      status: 'alert',
      alertId: alert.id,
      cardName,
      changePercent,
      oldTryPrice: mapping.last_try_price,
      newTryPrice: tryPrice,
      updated: alert.updated,
    };
  }

  updateMappingPriceSnapshot({
    mappingId: mapping.id,
    cardName,
    usdPrice,
    tryPrice,
    checkedAt,
  });

  return { status: 'unchanged', cardName, changePercent, tryPrice };
}

async function runPriceCheck() {
  const mappings = getAutoTrackedMappings();
  if (!mappings.length) {
    return {
      checked: 0,
      alerts: 0,
      baselines: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      thresholdPercent: THRESHOLD_PERCENT,
    };
  }

  const usdTryRate = await getUsdTryRate();
  const summary = {
    checked: 0,
    alerts: 0,
    baselines: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    thresholdPercent: THRESHOLD_PERCENT,
    checkedAt: new Date().toISOString(),
  };

  for (const mapping of mappings) {
    try {
      const result = await checkMappingPrice(mapping, { usdTryRate, threshold: THRESHOLD_PERCENT });
      summary.checked += 1;

      if (result.status === 'alert') summary.alerts += 1;
      else if (result.status === 'baseline') summary.baselines += 1;
      else if (result.status === 'unchanged') summary.unchanged += 1;
      else if (result.status === 'skipped') summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`[priceCheck] mapping ${mapping.id} hatası:`, error.message);
    }

    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  console.log('[priceCheck] Tamamlandı:', summary);
  return summary;
}

async function approvePriceChange(alertId) {
  const alert = getPriceChangeAlertById(alertId);
  if (!alert) throw new Error('Fiyat değişikliği kaydı bulunamadı.');
  if (alert.status !== 'pending') throw new Error('Bu kayıt zaten işlenmiş.');

  const fallbackSku = buildKartfiyatSku(alert.kartfiyat_card_id, alert.price_label);
  const sku = alert.sku || fallbackSku;

  try {
    const result = await updateVariantPrices([{
      mappingId: alert.mapping_id,
      productId: alert.ikas_product_id,
      variantId: alert.ikas_variant_id,
      sellPrice: alert.new_try_price,
      sku,
      skuCandidates: [alert.sku, fallbackSku].filter(Boolean),
      barcode: alert.barcode || null,
    }]);

    for (const change of result?.idChanges || []) {
      if (!change.mappingId) continue;
      updateMappingIkasIds({
        mappingId: change.mappingId,
        ikasProductId: change.productId,
        ikasVariantId: change.variantId,
        sku: change.sku || null,
        clearMissing: true,
      });
    }

    updateMappingPriceSnapshot({
      mappingId: alert.mapping_id,
      usdPrice: alert.new_usd_price,
      tryPrice: alert.new_try_price,
      checkedAt: new Date().toISOString(),
    });

    return resolvePriceChangeAlert(alertId, 'approved');
  } catch (error) {
    if (isMissingProductError(error) && alert.mapping_id) {
      markMissingAndRejectAlerts(
        alert.mapping_id,
        error.message,
      );
      throw new Error(
        `ikas'ta ürün yok — mapping takip dışı bırakıldı ve alert reddedildi. `
        + `Yeniden import edin. (${error.message})`,
      );
    }
    throw error;
  }
}

async function rejectPriceChange(alertId) {
  const alert = getPriceChangeAlertById(alertId);
  if (!alert) throw new Error('Fiyat değişikliği kaydı bulunamadı.');
  if (alert.status !== 'pending') throw new Error('Bu kayıt zaten işlenmiş.');

  const resolved = resolvePriceChangeAlert(alertId, 'rejected');
  return resolved;
}

async function approveAllPendingPriceChanges(filter = 'all') {
  return bulkResolvePendingPriceChanges({ action: 'approve', filter });
}

async function rejectAllPendingPriceChanges(filter = 'all') {
  return bulkResolvePendingPriceChanges({ action: 'reject', filter });
}

function matchesPriceFilter(alert, filter = 'all') {
  const change = Number(alert.change_percent);
  if (filter === 'rising') return Number.isFinite(change) && change > 0;
  if (filter === 'falling') return Number.isFinite(change) && change < 0;
  return true;
}

async function bulkResolvePendingPriceChanges({ action = 'approve', filter = 'all' } = {}) {
  if (!['approve', 'reject'].includes(action)) {
    throw new Error('Geçersiz toplu işlem.');
  }
  if (!['all', 'rising', 'falling'].includes(filter)) {
    throw new Error('Geçersiz filtre. all, rising veya falling olmalı.');
  }

  const pending = getPriceChangeAlerts({ status: 'pending' })
    .filter((alert) => matchesPriceFilter(alert, filter));

  const results = {
    action,
    filter,
    matched: pending.length,
    approved: 0,
    rejected: 0,
    missing: 0,
    failed: [],
  };

  for (const alert of pending) {
    try {
      if (action === 'approve') {
        await approvePriceChange(alert.id);
        results.approved += 1;
      } else {
        await rejectPriceChange(alert.id);
        results.rejected += 1;
      }
    } catch (error) {
      if (action === 'approve' && isMissingProductError(error)) {
        results.missing += 1;
        results.rejected += 1;
      } else {
        results.failed.push({ id: alert.id, cardName: alert.card_name, reason: error.message });
      }
    }
  }

  return results;
}

/**
 * ikas kataloğunda bulunamayan mapping'leri işaretler, pending alert'lerini reddeder.
 */
async function pruneMissingIkasMappings({ apply = false } = {}) {
  const { getAllMappings, findByIkasVariantId } = require('../db');
  const mappings = getAllMappings().filter((m) => !m.ikas_missing && m.ikas_product_id);
  console.log(`[prune-missing] ${mappings.length} mapping kontrol edilecek (apply=${apply})`);

  const catalog = await listAllProducts();
  if (!catalog.length) {
    throw new Error('ikas kataloğu boş geldi; prune iptal (yanlış işaretlemeyi önlemek için).');
  }

  const byId = new Set(catalog.map((p) => p.id));
  const stats = {
    checked: 0,
    missing: 0,
    alive: 0,
    remapped: 0,
    remapSkipped: 0,
    alertsRejected: 0,
    catalogSize: catalog.length,
  };

  for (const mapping of mappings) {
    stats.checked += 1;
    let found = byId.has(mapping.ikas_product_id);
    let resolved = null;

    if (!found) {
      const fallbackSku = buildKartfiyatSku(mapping.kartfiyat_card_id, mapping.price_label);
      resolved = await findProductBySkuOrBarcode({
        sku: mapping.sku || fallbackSku,
        barcode: mapping.barcode || null,
        products: catalog,
        catalogOnly: true,
      });
      found = Boolean(resolved?.product?.id);

      if (found && apply) {
        try {
          const conflict = findByIkasVariantId(resolved.variant.id);
          if (conflict && conflict.id !== mapping.id) {
            stats.remapSkipped += 1;
            console.warn(
              `[prune-missing] Remap atlandı (variant başka mapping'de):`
              + ` mapping=${mapping.id} → variant=${resolved.variant.id} owner=${conflict.id}`,
            );
          } else {
            updateMappingIkasIds({
              mappingId: mapping.id,
              ikasProductId: resolved.product.id,
              ikasVariantId: resolved.variant.id,
              sku: resolved.variant.sku || null,
              clearMissing: true,
            });
            stats.remapped += 1;
          }
        } catch (error) {
          stats.remapSkipped += 1;
          console.warn(
            `[prune-missing] Remap hatası mapping=${mapping.id}: ${error.message}`,
          );
        }
      }
    }

    if (found) {
      stats.alive += 1;
      continue;
    }

    stats.missing += 1;
    console.warn(
      `[prune-missing] YOK mapping=${mapping.id} card=${mapping.kartfiyat_card_id}`
      + ` product=${mapping.ikas_product_id} sku=${mapping.sku || '?'} barcode=${mapping.barcode || '?'}`,
    );

    if (apply) {
      markMappingIkasMissing(mapping.id, true);
      stats.alertsRejected += rejectPendingAlertsForMapping(mapping.id);
    }
  }

  console.log('[prune-missing] Tamamlandı:', stats);
  return stats;
}

function getPriceDashboardData() {
  return {
    pendingCount: countPendingPriceAlerts(),
    summary: getLatestPriceCheckSummary(),
    thresholdPercent: THRESHOLD_PERCENT,
    alerts: getPriceChangeAlerts(),
  };
}

module.exports = {
  runPriceCheck,
  approvePriceChange,
  rejectPriceChange,
  approveAllPendingPriceChanges,
  rejectAllPendingPriceChanges,
  bulkResolvePendingPriceChanges,
  pruneMissingIkasMappings,
  getPriceDashboardData,
  calculateChangePercent,
  exceedsThreshold,
  THRESHOLD_PERCENT,
};
