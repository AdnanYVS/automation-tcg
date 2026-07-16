const {
  getAutoTrackedMappings,
  findMappingById,
  updateMappingPriceSnapshot,
  updateMappingIkasIds,
  upsertPendingPriceAlert,
  getPriceChangeAlerts,
  getPriceChangeAlertById,
  resolvePriceChangeAlert,
  countPendingPriceAlerts,
  getLatestPriceCheckSummary,
} = require('../db');
const { getCardById, getPriceChartingUsd, buildKartfiyatSku } = require('./kartfiyat');
const { updateVariantPrices } = require('./ikas');
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

async function checkMappingPrice(mapping, { usdTryRate, threshold }) {
  if (mapping.price_manual) {
    return { status: 'skipped', reason: 'Manuel fiyat' };
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

  const result = await updateVariantPrices([{
    mappingId: alert.mapping_id,
    productId: alert.ikas_product_id,
    variantId: alert.ikas_variant_id,
    sellPrice: alert.new_try_price,
    sku: buildKartfiyatSku(alert.kartfiyat_card_id, alert.price_label),
    barcode: alert.barcode || null,
  }]);

  for (const change of result?.idChanges || []) {
    if (!change.mappingId) continue;
    updateMappingIkasIds({
      mappingId: change.mappingId,
      ikasProductId: change.productId,
      ikasVariantId: change.variantId,
    });
  }

  updateMappingPriceSnapshot({
    mappingId: alert.mapping_id,
    usdPrice: alert.new_usd_price,
    tryPrice: alert.new_try_price,
    checkedAt: new Date().toISOString(),
  });

  const resolved = resolvePriceChangeAlert(alertId, 'approved');
  return resolved;
}

async function rejectPriceChange(alertId) {
  const alert = getPriceChangeAlertById(alertId);
  if (!alert) throw new Error('Fiyat değişikliği kaydı bulunamadı.');
  if (alert.status !== 'pending') throw new Error('Bu kayıt zaten işlenmiş.');

  const resolved = resolvePriceChangeAlert(alertId, 'rejected');
  return resolved;
}

async function approveAllPendingPriceChanges() {
  const pending = getPriceChangeAlerts({ status: 'pending' });
  const results = { approved: 0, failed: [] };

  for (const alert of pending) {
    try {
      await approvePriceChange(alert.id);
      results.approved += 1;
    } catch (error) {
      results.failed.push({ id: alert.id, cardName: alert.card_name, reason: error.message });
    }
  }

  return results;
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
  getPriceDashboardData,
  calculateChangePercent,
  exceedsThreshold,
  THRESHOLD_PERCENT,
};
