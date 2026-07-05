require('dotenv').config();

const cron = require('node-cron');
const { getAllMappings } = require('../db');
const { getCardById, getPriceChartingUsd } = require('../services/kartfiyat');
const { updateVariantPrices } = require('../services/ikas');
const { getUsdTryRate } = require('../services/exchangeRate');
const { calculateFinalPriceTry } = require('../services/pricing');

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

async function runPriceUpdate() {
  const mappings = getAllMappings();
  if (!mappings.length) return { updated: 0, skipped: 0, failed: 0 };

  const usdTryRate = await getUsdTryRate();
  const multiplier = Number(process.env.FINAL_COST_MULTIPLIER || 1.86);
  const variantUpdates = [];
  const failed = [];
  let skipped = 0;

  for (const mapping of mappings) {
    if (!mapping.ikas_product_id) {
      skipped += 1;
      continue;
    }
    try {
      const card = await getCardById(mapping.kartfiyat_card_id);
      const usdPrice = getPriceChartingUsd(card);
      if (!usdPrice) {
        skipped += 1;
        continue;
      }
      variantUpdates.push({
        productId: mapping.ikas_product_id,
        variantId: mapping.ikas_variant_id,
        sellPrice: calculateFinalPriceTry(usdPrice, usdTryRate, multiplier),
      });
    } catch (error) {
      failed.push({ mapping, reason: error.message });
    }
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  let updated = 0;
  for (const batch of chunkArray(variantUpdates, BATCH_SIZE)) {
    try {
      await updateVariantPrices(batch);
      updated += batch.length;
    } catch (error) {
      failed.push(...batch.map((item) => ({ item, reason: error.message })));
    }
  }

  return { updated, skipped, failed: failed.length };
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
