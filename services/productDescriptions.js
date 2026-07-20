const { getAllMappings } = require('../db');
const { getCardById, buildCardSeriesDescription } = require('./kartfiyat');
const { getProductById, updateProductDescription } = require('./ikas/products');

const REQUEST_DELAY_MS = Number(process.env.KARTFIYAT_REQUEST_DELAY_MS || 200);
const IKAS_REQUEST_DELAY_MS = Number(process.env.IKAS_PRODUCT_DESCRIPTION_DELAY_MS || 150);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncProductSeriesDescriptionForMapping(mapping, {
  dryRun = false,
  skipIfUnchanged = true,
} = {}) {
  if (!mapping?.ikas_product_id) {
    return { status: 'skipped', reason: 'ikas_product_id yok' };
  }

  const card = await getCardById(mapping.kartfiyat_card_id);
  const description = buildCardSeriesDescription(card);
  if (!description) {
    return { status: 'skipped', reason: 'Seri bilgisi bulunamadı' };
  }

  if (skipIfUnchanged) {
    const product = await getProductById(mapping.ikas_product_id);
    if (!product) {
      return { status: 'skipped', reason: 'ikas ürünü bulunamadı' };
    }
    if (String(product.description || '').trim() === description) {
      return { status: 'unchanged', description };
    }
  }

  if (!dryRun) {
    await updateProductDescription({
      productId: mapping.ikas_product_id,
      description,
    });
  }

  return {
    status: dryRun ? 'would_update' : 'updated',
    description,
    productId: mapping.ikas_product_id,
    kartfiyatCardId: mapping.kartfiyat_card_id,
  };
}

async function syncAllProductSeriesDescriptions({
  dryRun = false,
  skipIfUnchanged = true,
  kartfiyatDelayMs = REQUEST_DELAY_MS,
  ikasDelayMs = IKAS_REQUEST_DELAY_MS,
} = {}) {
  const mappings = getAllMappings().filter((mapping) => mapping.ikas_product_id);
  const seenProductIds = new Set();
  const stats = {
    total: mappings.length,
    uniqueProducts: 0,
    updated: 0,
    wouldUpdate: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };
  const failures = [];

  for (const mapping of mappings) {
    if (seenProductIds.has(mapping.ikas_product_id)) {
      stats.skipped += 1;
      continue;
    }
    seenProductIds.add(mapping.ikas_product_id);
    stats.uniqueProducts += 1;

    try {
      const result = await syncProductSeriesDescriptionForMapping(mapping, {
        dryRun,
        skipIfUnchanged,
      });

      if (result.status === 'updated') {
        stats.updated += 1;
        console.log(
          `[productDescriptions] Güncellendi: product=${mapping.ikas_product_id}`
          + ` card=${mapping.kartfiyat_card_id} → "${result.description}"`,
        );
      } else if (result.status === 'would_update') {
        stats.wouldUpdate += 1;
        console.log(
          `[productDescriptions] Güncellenecek: product=${mapping.ikas_product_id}`
          + ` card=${mapping.kartfiyat_card_id} → "${result.description}"`,
        );
      } else if (result.status === 'unchanged') {
        stats.unchanged += 1;
      } else {
        stats.skipped += 1;
      }

      if (kartfiyatDelayMs > 0) await sleep(kartfiyatDelayMs);
      if (!dryRun && result.status === 'updated' && ikasDelayMs > 0) {
        await sleep(ikasDelayMs);
      }
    } catch (error) {
      stats.failed += 1;
      failures.push({
        mappingId: mapping.id,
        productId: mapping.ikas_product_id,
        kartfiyatCardId: mapping.kartfiyat_card_id,
        reason: error.message,
      });
      console.error(
        `[productDescriptions] Hata: mapping=${mapping.id} product=${mapping.ikas_product_id}:`,
        error.message,
      );
    }
  }

  return { ...stats, failures };
}

module.exports = {
  syncProductSeriesDescriptionForMapping,
  syncAllProductSeriesDescriptions,
};
