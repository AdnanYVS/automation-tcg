#!/usr/bin/env node
/**
 * Mevcut ürünleri yeni navigasyon kategori ağacına taşır.
 *
 * Kullanım:
 *   node scripts/migrate-to-navigation-categories.js --dry-run
 *   node scripts/migrate-to-navigation-categories.js --apply
 *
 * Ortam:
 *   IKAS_CONSOLIDATE_DELAY_MS=800
 */

require('dotenv').config();

const { getAllMappings } = require('../db');
const { getCardById, normalizePriceLabel } = require('../services/kartfiyat');
const { listAllProducts, updateProductTaxonomy } = require('../services/ikas/products');
const {
  ensureNavigationTaxonomy,
  resolveProductCategories,
} = require('../services/ikas/navigationCategories');
const { getSupportedGames, detectGameFromCard } = require('../services/ikas/taxonomy');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run') || !apply;
  return { dryRun, apply };
}

function extractKartfiyatIdFromSku(sku) {
  const match = String(sku || '').match(/^KF-(\d+)/i);
  return match ? match[1] : null;
}

function extractPriceLabelFromProduct(product) {
  const nameMatch = String(product.name || '').match(
    /\[((?:PSA|BGS|CGC|SGC|ACE|TAG|Grade)\s+[\d.]+)\]/i,
  );
  if (nameMatch) {
    return normalizePriceLabel(nameMatch[1]);
  }
  return null;
}

function resolvePriceLabel(product, mapping) {
  if (mapping?.price_label) {
    return normalizePriceLabel(mapping.price_label);
  }
  return extractPriceLabelFromProduct(product);
}

function detectGameFromProduct(product) {
  const brand = String(product?.brand?.name || '');
  if (/^one\s*piece$/i.test(brand)) return 'onepiece';
  if (/^pokemon$/i.test(brand)) return 'pokemon';

  const categoryNames = (product?.categories || []).map((entry) => String(entry?.name || ''));
  if (categoryNames.some((name) => /^one piece\b/i.test(name))) return 'onepiece';
  if (categoryNames.some((name) => /^pokemon\b/i.test(name))) return 'pokemon';
  return null;
}

async function withRetry(action, label, { delayMs, maxAttempts = 5 } = {}) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await action();
    } catch (error) {
      attempt += 1;
      const isRetryable = /timeout|network timeout|429|rate limit|too many|ECONNRESET|ETIMEDOUT|503|502|504/i.test(
        error.message,
      );
      if (!isRetryable || attempt >= maxAttempts) {
        throw error;
      }
      const waitMs = delayMs * attempt * 3;
      console.warn(`[navigation-migrate] ${label} tekrar denenecek (${attempt}/${maxAttempts}): ${error.message}`);
      await sleep(waitMs);
    }
  }
  return null;
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  const delayMs = Number(process.env.IKAS_CONSOLIDATE_DELAY_MS || 800);
  const supportedGameIds = new Set(getSupportedGames().map((game) => game.id));

  console.log(`[navigation-migrate] Mod: ${dryRun ? 'DRY-RUN' : 'APPLY'} (delay=${delayMs}ms)`);

  if (!dryRun) {
    for (const game of getSupportedGames()) {
      await ensureNavigationTaxonomy(game.id, { allowCreate: true, force: true });
    }
  }

  const [products, mappings] = await Promise.all([
    listAllProducts(),
    Promise.resolve(getAllMappings()),
  ]);

  const mappingsByProductId = new Map();
  for (const mapping of mappings) {
    if (!mapping.ikas_product_id) continue;
    if (!mappingsByProductId.has(mapping.ikas_product_id)) {
      mappingsByProductId.set(mapping.ikas_product_id, mapping);
    }
  }

  const stats = {
    total: products.length,
    eligible: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    samples: [],
  };

  for (const product of products) {
    const gameId = detectGameFromProduct(product);
    if (!gameId || !supportedGameIds.has(gameId)) {
      stats.skipped += 1;
      continue;
    }

    const mapping = mappingsByProductId.get(product.id);
    const sku = product.variants?.[0]?.sku || mapping?.sku;
    const kartfiyatCardId = mapping?.kartfiyat_card_id || extractKartfiyatIdFromSku(sku);
    if (!kartfiyatCardId) {
      stats.skipped += 1;
      continue;
    }

    stats.eligible += 1;

    try {
      const card = await getCardById(String(kartfiyatCardId));
      const detectedGame = detectGameFromCard(card);
      if (detectedGame.id !== gameId) {
        stats.skipped += 1;
        continue;
      }

      const priceLabel = resolvePriceLabel(product, mapping);
      const plan = resolveProductCategories(card, null, {
        priceLabel,
        productName: product.name,
      });

      if (stats.samples.length < 8) {
        stats.samples.push({
          productId: product.id,
          name: product.name,
          kind: plan.kind,
          categories: plan.categories.map((entry) => [...(entry.path || []), entry.name].filter(Boolean).join(' > ')),
        });
      }

      if (dryRun) {
        stats.migrated += 1;
        continue;
      }

      await withRetry(
        () => updateProductTaxonomy({
          productId: product.id,
          brandName: plan.brandName,
          categories: plan.categories,
          tags: plan.tags,
        }),
        product.name,
        { delayMs },
      );
      stats.migrated += 1;
      if (delayMs > 0) await sleep(delayMs);
    } catch (error) {
      stats.failed += 1;
      console.error(`[navigation-migrate] Başarısız (${product.name}): ${error.message}`);
    }
  }

  console.log('[navigation-migrate] Özet:', stats);
}

main().catch((error) => {
  console.error('[navigation-migrate] Kritik hata:', error.message);
  process.exit(1);
});
