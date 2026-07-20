#!/usr/bin/env node
/**
 * Tüm ikas kategorilerini mağaza satış kanalında görünür yapar.
 * Ürünler kategoriye atanmış olsa bile, kategori satış kanalında
 * etkin değilse vitrinde ürünler görünmez.
 *
 * Kullanım:
 *   node scripts/sync-ikas-categories.js [--skip-parents] [--assign-products] [--dry-run]
 */

require('dotenv').config();

const { getAllMappings } = require('../db');
const { getCardById } = require('../services/kartfiyat');
const {
  listCategories,
  syncAllCategoriesToStorefront,
  resolveCategoryForCard,
  buildCategoryPath,
} = require('../services/ikas/categories');
const { listAllProducts, updateProductCategories } = require('../services/ikas/products');

function parseArgs(argv) {
  const args = {
    dryRun: false,
    skipParents: false,
    assignProducts: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--skip-parents') args.skipParents = true;
    else if (argv[i] === '--assign-products') args.assignProducts = true;
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractKartfiyatCardId(product) {
  const variant = product.variants?.[0];
  const sku = String(variant?.sku || '').trim();
  if (/^KF-/i.test(sku)) return sku.replace(/^KF-/i, '');

  return null;
}

async function assignProductsToCategories({ dryRun = false } = {}) {
  const delayMs = Number(process.env.IKAS_CATEGORY_ASSIGN_DELAY_MS || 150);
  const mappings = getAllMappings();
  const mappingByProductId = new Map(
    mappings
      .filter((row) => row.ikas_product_id)
      .map((row) => [row.ikas_product_id, row]),
  );

  const products = await listAllProducts();
  const categories = await listCategories({ refresh: true });
  const categoriesById = new Map(categories.map((entry) => [entry.id, entry]));

  const stats = {
    total: products.length,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (let index = 0; index < products.length; index += 1) {
    const product = products[index];
    const label = `${index + 1}/${products.length} ${product.name}`;

    const mapping = mappingByProductId.get(product.id);
    const kartfiyatCardId = mapping?.kartfiyat_card_id || extractKartfiyatCardId(product);

    if (!kartfiyatCardId) {
      stats.failed += 1;
      console.warn(`[sync-categories] Ürün atlanamadı ${label}: KartFiyat ID yok`);
      continue;
    }

    try {
      const card = await getCardById(String(kartfiyatCardId));
      const category = await resolveCategoryForCard(card);
      const currentCategoryId = product.categories?.[0]?.id || null;

      if (currentCategoryId === category.id) {
        stats.skipped += 1;
        continue;
      }

      const categoryRecord = categoriesById.get(category.id);
      const categoryPath = categoryRecord
        ? buildCategoryPath(categoryRecord, categoriesById)
        : category.path;

      if (dryRun) {
        stats.updated += 1;
        console.log(`[sync-categories] DRY-RUN ${label} → ${category.name}`);
        continue;
      }

      await updateProductCategories({
        productId: product.id,
        categoryName: category.name,
        categoryPath,
      });
      stats.updated += 1;
      console.log(`[sync-categories] Ürün güncellendi ${label} → ${category.name}`);
    } catch (error) {
      stats.failed += 1;
      console.error(`[sync-categories] Ürün güncellenemedi ${label}: ${error.message}`);
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  return stats;
}

async function main() {
  const { dryRun, skipParents, assignProducts } = parseArgs(process.argv);

  console.log('[sync-categories] Kategori senkronizasyonu başlıyor...');

  if (dryRun) {
    const categories = await listCategories({ refresh: true });
    const hidden = categories.filter(
      (category) => !(category.salesChannels || []).some((channel) => channel.status === 'VISIBLE'),
    );
    console.log(`[sync-categories] DRY-RUN: ${hidden.length}/${categories.length} kategori mağazada görünür değil`);
    if (assignProducts) {
      const productStats = await assignProductsToCategories({ dryRun: true });
      console.log('[sync-categories] DRY-RUN ürün ataması:', productStats);
    }
    return;
  }

  const categoryStats = await syncAllCategoriesToStorefront({
    assignParentIds: !skipParents,
    delayMs: Number(process.env.IKAS_CATEGORY_SYNC_DELAY_MS || 500),
  });
  console.log('[sync-categories] Kategori sonucu:', categoryStats);

  if (assignProducts) {
    const productStats = await assignProductsToCategories();
    console.log('[sync-categories] Ürün atama sonucu:', productStats);
  }

  if (categoryStats.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[sync-categories] Kritik hata:', error.message);
  process.exit(1);
});
