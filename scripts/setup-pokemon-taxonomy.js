#!/usr/bin/env node
/**
 * Pokemon ana kategorisi ve markasını oluşturur,
 * tüm alt kategorileri ve ürünleri buna bağlar.
 *
 * Kullanım:
 *   node scripts/setup-pokemon-taxonomy.js [--dry-run] [--categories-only] [--products-only]
 */

require('dotenv').config();

const { DEFAULT_BRAND_NAME, ensureBrandExists } = require('../services/ikas/brands');
const {
  assignAllCategoriesUnderPokemonRoot,
  listCategories,
  buildCategoryPath,
  getPokemonRootCategoryName,
} = require('../services/ikas/categories');
const { listAllProducts, updateProductTaxonomy } = require('../services/ikas/products');

function parseArgs(argv) {
  const args = {
    dryRun: false,
    categoriesOnly: false,
    productsOnly: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--categories-only') args.categoriesOnly = true;
    else if (argv[i] === '--products-only') args.productsOnly = true;
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assignBrandsAndProductCategories({ dryRun = false, delayMs = 400 } = {}) {
  const brandName = DEFAULT_BRAND_NAME;
  const rootName = getPokemonRootCategoryName();
  const categories = await listCategories({ refresh: true });
  const categoriesById = new Map(categories.map((entry) => [entry.id, entry]));
  const products = await listAllProducts();

  const stats = {
    totalProducts: products.length,
    brandUpdated: 0,
    categoryUpdated: 0,
    skipped: 0,
    failed: 0,
  };

  if (!dryRun) {
    await ensureBrandExists({ name: brandName, allowCreate: true });
  }

  for (let index = 0; index < products.length; index += 1) {
    const product = products[index];
    const category = product.categories?.[0];
    const categoryName = category?.name;
    const currentBrand = product.brand?.name;
    const label = `${index + 1}/${products.length} ${product.name}`;

    if (!categoryName) {
      stats.skipped += 1;
      console.warn(`[pokemon-taxonomy] SKIP ${label}: kategori yok`);
      continue;
    }

    const categoryRecord = categoriesById.get(category.id);
    const categoryPath = categoryRecord
      ? buildCategoryPath(categoryRecord, categoriesById)
      : [rootName, categoryName];

    const needsBrand = normalize(currentBrand) !== normalize(brandName);
    const needsCategoryPath = !categoryPathIncludes(categoryPath, rootName, categoryName);

    if (!needsBrand && !needsCategoryPath) {
      stats.skipped += 1;
      continue;
    }

    if (dryRun) {
      if (needsBrand) stats.brandUpdated += 1;
      if (needsCategoryPath) stats.categoryUpdated += 1;
      console.log(`[pokemon-taxonomy] DRY-RUN ${label} → marka:${brandName}, path:${categoryPath.join(' > ')}`);
      continue;
    }

    try {
      await updateProductTaxonomy({
        productId: product.id,
        brandName: needsBrand ? brandName : null,
        categoryName: needsCategoryPath ? categoryName : null,
        categoryPath: needsCategoryPath ? categoryPath : [],
      });

      if (needsBrand) stats.brandUpdated += 1;
      if (needsCategoryPath) stats.categoryUpdated += 1;
      console.log(`[pokemon-taxonomy] OK ${label}`);
    } catch (error) {
      stats.failed += 1;
      console.error(`[pokemon-taxonomy] FAIL ${label}:`, error.message);
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  return stats;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function categoryPathIncludes(path, rootName, categoryName) {
  if (!Array.isArray(path) || path.length < 2) return false;
  return normalize(path[0]) === normalize(rootName)
    && normalize(path[path.length - 1]) === normalize(categoryName);
}

async function main() {
  const { dryRun, categoriesOnly, productsOnly } = parseArgs(process.argv);
  const delayMs = Number(process.env.IKAS_TAXONOMY_DELAY_MS || 500);

  console.log(`[pokemon-taxonomy] Başlıyor${dryRun ? ' (dry-run)' : ''}...`);

  const results = {};

  if (!productsOnly) {
    if (dryRun) {
      const categories = await listCategories({ refresh: true });
      const rootName = getPokemonRootCategoryName();
      const toMove = categories.filter((category) =>
        normalize(category.name) !== normalize(rootName) && !category.parentId,
      );
      results.categories = {
        dryRun: true,
        rootCategoryName: rootName,
        wouldMove: toMove.length,
        total: categories.length,
      };
      console.log('[pokemon-taxonomy] DRY-RUN kategori:', results.categories);
    } else {
      results.categories = await assignAllCategoriesUnderPokemonRoot({ delayMs });
      console.log('[pokemon-taxonomy] Kategori sonucu:', results.categories);
    }
  }

  if (!categoriesOnly) {
    results.products = await assignBrandsAndProductCategories({ dryRun, delayMs });
    console.log('[pokemon-taxonomy] Ürün sonucu:', results.products);
  }

  const failed = (results.categories?.failed || 0) + (results.products?.failed || 0);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[pokemon-taxonomy] Kritik hata:', error.message);
  process.exit(1);
});
