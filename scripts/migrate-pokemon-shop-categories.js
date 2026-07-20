#!/usr/bin/env node
/**
 * Mevcut Pokemon ürünlerini yeni shop leaf kategorilerine taşır.
 * Ürün silinmez; yalnızca kategori ataması güncellenir (tek leaf).
 *
 * Kullanım:
 *   node scripts/migrate-pokemon-shop-categories.js --dry-run
 *   node scripts/migrate-pokemon-shop-categories.js --apply
 *
 * Ortam:
 *   IKAS_CONSOLIDATE_DELAY_MS=1200  (isteğe bağlı, varsayılan 800)
 */

require('dotenv').config();

const { getAllMappings, findByIkasVariantId } = require('../db');
const { getCardById, normalizePriceLabel } = require('../services/kartfiyat');
const { listAllProducts, updateProductTaxonomy } = require('../services/ikas/products');
const {
  ensurePokemonShopTaxonomy,
  resolvePokemonShopCategories,
  isPokemonProduct,
  LANGUAGE_BRANCHES,
  PRODUCT_TYPE_LEAVES,
} = require('../services/ikas/pokemonShopCategories');
const { getTaxonomyOrThrow, detectGameFromCard } = require('../services/ikas/taxonomy');

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
      console.warn(`[pokemon-shop-migrate] ${label} tekrar denenecek (${attempt}/${maxAttempts}): ${error.message}`);
      await sleep(waitMs);
    }
  }
  return null;
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  const delayMs = Number(process.env.IKAS_CONSOLIDATE_DELAY_MS || 800);
  const brandName = getTaxonomyOrThrow('pokemon').brandName;

  console.log(`[pokemon-shop-migrate] Mod: ${dryRun ? 'DRY-RUN' : 'APPLY'} (delay=${delayMs}ms)`);

  if (!dryRun) {
    await ensurePokemonShopTaxonomy({ allowCreate: true, force: true });
  }

  const [products, mappings] = await Promise.all([
    listAllProducts(),
    Promise.resolve(getAllMappings()),
  ]);

  const mappingsByProductId = new Map();
  for (const mapping of mappings) {
    if (!mapping.ikas_product_id) continue;
    if (!mappingsByProductId.has(mapping.ikas_product_id)) {
      mappingsByProductId.set(mapping.ikas_product_id, []);
    }
    mappingsByProductId.get(mapping.ikas_product_id).push(mapping);
  }

  const pokemonProducts = products.filter(isPokemonProduct);
  console.log(`[pokemon-shop-migrate] Toplam ürün: ${products.length}, Pokemon: ${pokemonProducts.length}`);

  const stats = {
    dryRun,
    checked: pokemonProducts.length,
    updated: 0,
    skipped: 0,
    failed: 0,
    byLanguage: Object.fromEntries(LANGUAGE_BRANCHES.map((name) => [name, 0])),
    byType: Object.fromEntries(PRODUCT_TYPE_LEAVES.map((name) => [name, 0])),
    failures: [],
  };

  for (const product of pokemonProducts) {
    const sku = product.variants?.[0]?.sku || null;
    const variantId = product.variants?.[0]?.id || null;
    let mapping = null;

    if (variantId) {
      mapping = findByIkasVariantId(variantId);
    }
    if (!mapping && product.id) {
      mapping = (mappingsByProductId.get(product.id) || [])[0] || null;
    }

    const kartfiyatCardId = mapping?.kartfiyat_card_id || extractKartfiyatIdFromSku(sku);
    if (!kartfiyatCardId) {
      stats.skipped += 1;
      stats.failures.push({
        type: 'skip',
        productId: product.id,
        productName: product.name,
        reason: 'KartFiyat ID bulunamadı',
      });
      console.warn(`[pokemon-shop-migrate] SKIP ${product.name}: KartFiyat ID yok`);
      continue;
    }

    const priceLabel = resolvePriceLabel(product, mapping);

    try {
      const card = await getCardById(kartfiyatCardId);
      const detected = detectGameFromCard(card);
      if (detected.id !== 'pokemon') {
        stats.skipped += 1;
        stats.failures.push({
          type: 'skip-non-pokemon',
          productId: product.id,
          productName: product.name,
          reason: `Oyun pokemon değil: ${detected.id} (${card.game || card.category?.name || '?'})`,
        });
        console.warn(
          `[pokemon-shop-migrate] SKIP ${product.name}: ${detected.id} (${card.game || card.category?.name})`,
        );
        continue;
      }

      const placement = resolvePokemonShopCategories(card, {
        priceLabel,
        productName: product.name,
      });

      stats.byLanguage[placement.language] = (stats.byLanguage[placement.language] || 0) + 1;
      stats.byType[placement.productType] = (stats.byType[placement.productType] || 0) + 1;

      const targetPath = `${placement.path.join(' > ')} > ${placement.leafName}`;

      if (dryRun) {
        stats.updated += 1;
        console.log(`[pokemon-shop-migrate] DRY-RUN ${product.name} → ${targetPath}`);
        continue;
      }

      await withRetry(
        () => updateProductTaxonomy({
          productId: product.id,
          brandName,
          categories: placement.categories,
        }),
        product.name,
        { delayMs },
      );

      stats.updated += 1;
      console.log(`[pokemon-shop-migrate] OK ${product.name} → ${targetPath}`);
    } catch (error) {
      stats.failed += 1;
      stats.failures.push({
        type: 'fail',
        productId: product.id,
        productName: product.name,
        reason: error.message,
      });
      console.error(`[pokemon-shop-migrate] FAIL ${product.name}: ${error.message}`);
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  console.log('[pokemon-shop-migrate] Sonuç:', {
    dryRun: stats.dryRun,
    checked: stats.checked,
    updated: stats.updated,
    skipped: stats.skipped,
    failed: stats.failed,
    byLanguage: stats.byLanguage,
    byType: stats.byType,
  });

  if (stats.failures.length) {
    console.log('[pokemon-shop-migrate] Skip/Fail detay (ilk 30):', stats.failures.slice(0, 30));
  }

  if (dryRun) {
    console.log('[pokemon-shop-migrate] Uygulamak için: npm run pokemon:shop:migrate -- --apply');
  }

  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[pokemon-shop-migrate] Kritik hata:', error.message);
  process.exit(1);
});
