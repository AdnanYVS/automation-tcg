#!/usr/bin/env node
/**
 * Yanlışlıkla Pokemon brand/kategori alanına düşen One Piece / Riftbound ürünlerini onarır.
 *
 * Kullanım:
 *   node scripts/repair-non-pokemon-misbranded.js --dry-run
 *   node scripts/repair-non-pokemon-misbranded.js --apply
 */

require('dotenv').config();

const { getAllMappings, findByIkasVariantId } = require('../db');
const { getCardById, normalizePriceLabel } = require('../services/kartfiyat');
const { listAllProducts, updateProductTaxonomy } = require('../services/ikas/products');
const {
  resolveCategoryForCard,
  ensureCategoryStorefrontVisibility,
  listCategories,
} = require('../services/ikas/categories');
const {
  resolveProductCategories,
  ensureNavigationTaxonomy,
} = require('../services/ikas/navigationCategories');
const {
  detectGameFromCard,
  looksLikeNonPokemonProduct,
} = require('../services/ikas/taxonomy');
const {
  LANGUAGE_BRANCHES,
  PRODUCT_TYPE_LEAVES,
} = require('../services/ikas/pokemonShopCategories');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  return { dryRun: !apply };
}

function extractKartfiyatIdFromSku(sku) {
  const match = String(sku || '').match(/^KF-(\d+)/i);
  return match ? match[1] : null;
}

function extractPriceLabelFromProduct(product) {
  const nameMatch = String(product.name || '').match(
    /\[((?:PSA|BGS|CGC|SGC|ACE|TAG|Grade)\s+[\d.]+)\]/i,
  );
  if (nameMatch) return normalizePriceLabel(nameMatch[1]);
  return null;
}

function isShopOrNavLeafOnly(categoryNames) {
  if (!categoryNames.length) return true;
  return categoryNames.every((name) => (
    LANGUAGE_BRANCHES.includes(name)
    || PRODUCT_TYPE_LEAVES.includes(name)
    || ['KAPALI KUTULAR', 'SINGLE KARTLAR', 'GRADED KARTLAR', 'Diğer Ürünler'].includes(name)
    || /^(İngilizce|Japonca|Çince) Kartlar$/i.test(name)
  ));
}

function shouldInspectPokemonBrandedProduct(product, categoryNames) {
  if (looksLikeNonPokemonProduct({
    name: product.name,
    brand: product?.brand?.name,
    categoryNames,
  })) {
    return true;
  }

  // Shop leaf'e düşmüş sealed ürünler (Riftbound display vb.)
  if (
    isShopOrNavLeafOnly(categoryNames)
    && /\b(booster display|display|riftbound|collection box|elite trainer|etb|booster box|booster pack|mini tin|\btin\b)\b/i.test(product.name || '')
  ) {
    return true;
  }

  return false;
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  const delayMs = Number(process.env.IKAS_CONSOLIDATE_DELAY_MS || 500);

  console.log(`[repair-non-pokemon] Mod: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);

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

  const stats = {
    scanned: products.length,
    candidates: 0,
    repaired: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };

  for (const product of products) {
    const brand = String(product?.brand?.name || '');
    const categoryNames = (product.categories || []).map((entry) => entry.name);

    if (!/^pokemon$/i.test(brand)) continue;
    if (!shouldInspectPokemonBrandedProduct(product, categoryNames)) continue;

    const sku = product.variants?.[0]?.sku || null;
    const variantId = product.variants?.[0]?.id || null;
    let mapping = variantId ? findByIkasVariantId(variantId) : null;
    if (!mapping) mapping = (mappingsByProductId.get(product.id) || [])[0] || null;

    const kartfiyatCardId = mapping?.kartfiyat_card_id || extractKartfiyatIdFromSku(sku);
    if (!kartfiyatCardId) {
      stats.candidates += 1;
      stats.skipped += 1;
      stats.failures.push({
        name: product.name,
        reason: 'KF id yok, manuel kontrol gerekli',
      });
      continue;
    }

    let card;
    try {
      card = await getCardById(kartfiyatCardId);
    } catch (error) {
      stats.failed += 1;
      stats.failures.push({ name: product.name, reason: error.message });
      continue;
    }

    const detected = detectGameFromCard(card);
    if (detected.id === 'pokemon') continue;

    stats.candidates += 1;
    const priceLabel = mapping?.price_label || extractPriceLabelFromProduct(product);

    try {
      if (dryRun) {
        console.log(
          `[repair-non-pokemon] DRY-RUN ${product.name}`
          + ` brand:Pokemon→${detected.brandName}`
          + ` game:${detected.id}`
          + ` set:${card.category?.name || '?'}`,
        );
        stats.repaired += 1;
        continue;
      }

      const setCategory = await resolveCategoryForCard(card);
      let categories;

      if (detected.id === 'onepiece') {
        await ensureNavigationTaxonomy('onepiece', { allowCreate: true });
        categories = resolveProductCategories(card, setCategory, { priceLabel }).categories;
      } else {
        categories = [{
          name: setCategory.name,
          path: setCategory.productCategoryPath?.length
            ? setCategory.productCategoryPath
            : [setCategory.brandName],
        }];
      }

      await updateProductTaxonomy({
        productId: product.id,
        brandName: setCategory.brandName,
        categories,
      });

      const allCats = await listCategories({ refresh: true });
      for (const category of allCats) {
        if (!categories.some((entry) => entry.name === category.name)
          && category.name !== setCategory.brandName) {
          continue;
        }
        if (
          categories.some((entry) => entry.name === category.name)
          || category.name === setCategory.brandName
        ) {
          await ensureCategoryStorefrontVisibility(category);
        }
      }

      stats.repaired += 1;
      console.log(
        `[repair-non-pokemon] FIX ${product.name}`
        + ` brand:Pokemon→${setCategory.brandName}`
        + ` game:${detected.id}`
        + ` cats:${categories.map((entry) => entry.name).join('+')}`,
      );
    } catch (error) {
      stats.failed += 1;
      stats.failures.push({ name: product.name, reason: error.message });
      console.error(`[repair-non-pokemon] FAIL ${product.name}: ${error.message}`);
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  console.log('[repair-non-pokemon] Sonuç:', stats);
  if (stats.failures.length) {
    console.log('[repair-non-pokemon] Detay (ilk 30):', stats.failures.slice(0, 30));
  }
  if (dryRun) {
    console.log('[repair-non-pokemon] Uygulamak için: npm run products:repair-non-pokemon -- --apply');
  }
  if (stats.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[repair-non-pokemon] Kritik hata:', error.message);
  process.exit(1);
});
