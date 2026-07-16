require('dotenv').config();

const cron = require('node-cron');
const { getAutoTrackedMappings, updateMappingIkasIds } = require('../db');
const { getCardById, getPriceChartingUsd, buildKartfiyatSku } = require('../services/kartfiyat');
const { updateVariantPrices } = require('../services/ikas');
const { getUsdTryRate } = require('../services/exchangeRate');
const { calculateFinalPriceTry, getPriceMultiplierForCard } = require('../services/pricing');

const CRON_SCHEDULE = process.env.PRICE_UPDATE_CRON || '0 3 * * *';
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Europe/Istanbul';
const BATCH_SIZE = Number(process.env.IKAS_PRICE_BATCH_SIZE || 50);
const REQUEST_DELAY_MS = Number(process.env.KARTFIYAT_REQUEST_DELAY_MS || 200);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function applyIdChanges(idChanges) {
  if (!idChanges?.length) return 0;

  let fixed = 0;
  for (const change of idChanges) {
    if (!change.mappingId) continue;
    updateMappingIkasIds({
      mappingId: change.mappingId,
      ikasProductId: change.productId,
      ikasVariantId: change.variantId,
    });
    fixed += 1;
  }
  return fixed;
}

async function runPriceUpdate() {
  const mappings = getAutoTrackedMappings();
  if (!mappings.length) return { updated: 0, skipped: 0, failed: 0, idFixed: 0 };

  const usdTryRate = await getUsdTryRate();
  const variantUpdates = [];
  const failed = [];
  let skipped = 0;

  for (const mapping of mappings) {
    if (!mapping.ikas_product_id && !mapping.barcode && !mapping.kartfiyat_card_id) {
      skipped += 1;
      continue;
    }
    try {
      const card = await getCardById(mapping.kartfiyat_card_id);
      const { multiplier } = getPriceMultiplierForCard(card);
      const usdPrice = getPriceChartingUsd(card, { label: mapping.price_label });
      if (!usdPrice) {
        skipped += 1;
        continue;
      }
      variantUpdates.push({
        mappingId: mapping.id,
        productId: mapping.ikas_product_id,
        variantId: mapping.ikas_variant_id,
        sellPrice: calculateFinalPriceTry(usdPrice, usdTryRate, multiplier),
        sku: buildKartfiyatSku(mapping.kartfiyat_card_id, mapping.price_label),
        barcode: mapping.barcode || null,
      });
    } catch (error) {
      failed.push({ mapping, reason: error.message });
    }
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  let updated = 0;
  let idFixed = 0;
  for (const batch of chunkArray(variantUpdates, BATCH_SIZE)) {
    try {
      const result = await updateVariantPrices(batch);
      const batchUpdated = result?.updated ?? batch.length;
      updated += batchUpdated;
      idFixed += applyIdChanges(result?.idChanges);

      if (result?.failures?.length) {
        failed.push(...result.failures.map((entry) => ({
          item: entry,
          reason: entry.reason,
        })));
      }
    } catch (error) {
      failed.push(...batch.map((item) => ({ item, reason: error.message })));
    }
  }

  return { updated, skipped, failed: failed.length, idFixed };
}

function startPriceUpdaterCron() {
  if (String(process.env.RATE_PRICE_SYNC_ENABLED).toLowerCase() === 'false') return null;
  return cron.schedule(CRON_SCHEDULE, () => runPriceUpdate().catch(console.error), { timezone: CRON_TIMEZONE });
}

if (require.main === module) {
  if (process.argv.includes('--run-once')) {
    runPriceUpdate().then(console.log).catch((e) => { console.error(e); process.exit(1); });
  } else {
    startPriceUpdaterCron();
  }
}

module.exports = { runPriceUpdate, startPriceUpdaterCron };
