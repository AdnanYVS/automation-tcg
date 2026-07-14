const {
  listCategories,
  getPokemonRootCategoryId,
  getPokemonRootCategoryName,
  deleteCategoryList,
  updateCategory,
  invalidateCategoryCache,
  resolveCategoryForCard,
} = require('./categories');
const { listAllProducts, updateProductTaxonomy } = require('./products');
const { getCardById } = require('../kartfiyat');
const { resolveProductCategories, ensureNavigationTaxonomy } = require('./navigationCategories');
const { normalizePriceLabel } = require('../kartfiyat/cards');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCategoryDepth(category, categoriesById) {
  let depth = 0;
  let current = category;

  while (current?.parentId) {
    depth += 1;
    current = categoriesById.get(current.parentId);
    if (!current) break;
  }

  return depth;
}

function pickCanonicalCategory(categories, rootId, productCountByCategoryId, categoriesById) {
  const ranked = categories.map((category) => ({
    category,
    depth: getCategoryDepth(category, categoriesById),
    isDirectChild: category.parentId === rootId,
    productCount: productCountByCategoryId[category.id] || 0,
  }));

  ranked.sort((left, right) => {
    if (left.isDirectChild !== right.isDirectChild) {
      return Number(right.isDirectChild) - Number(left.isDirectChild);
    }
    if (left.productCount !== right.productCount) {
      return right.productCount - left.productCount;
    }
    return left.depth - right.depth;
  });

  return ranked[0].category;
}

async function buildDuplicateCategoryConsolidationPlan() {
  const rootName = getPokemonRootCategoryName();
  const rootId = await getPokemonRootCategoryId();
  const [categories, products] = await Promise.all([
    listCategories({ refresh: true }),
    listAllProducts(),
  ]);

  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const productCountByCategoryId = {};
  const productsByCategoryId = {};

  for (const product of products) {
    for (const category of (product.categories || [])) {
      productCountByCategoryId[category.id] = (productCountByCategoryId[category.id] || 0) + 1;
      (productsByCategoryId[category.id] = productsByCategoryId[category.id] || []).push(product);
    }
  }

  const categoriesByName = new Map();
  for (const category of categories) {
    if (category.id === rootId) continue;
    if (isTemporaryDuplicateName(category.name)) continue;
    if (!categoriesByName.has(category.name)) {
      categoriesByName.set(category.name, []);
    }
    categoriesByName.get(category.name).push(category);
  }

  const groups = [];
  for (const [name, sameNameCategories] of categoriesByName.entries()) {
    if (sameNameCategories.length < 2) continue;

    const canonical = pickCanonicalCategory(
      sameNameCategories,
      rootId,
      productCountByCategoryId,
      categoriesById,
    );

    const duplicates = sameNameCategories
      .filter((category) => category.id !== canonical.id)
      .sort((left, right) =>
        getCategoryDepth(right, categoriesById) - getCategoryDepth(left, categoriesById),
      );

    const productMoves = [];
    for (const duplicate of duplicates) {
      for (const product of (productsByCategoryId[duplicate.id] || [])) {
        productMoves.push({
          productId: product.id,
          productName: product.name,
          fromCategoryId: duplicate.id,
          toCategoryId: canonical.id,
          categoryName: name,
        });
      }
    }

    groups.push({
      name,
      canonical: {
        id: canonical.id,
        depth: getCategoryDepth(canonical, categoriesById),
        productCount: productCountByCategoryId[canonical.id] || 0,
      },
      duplicates: duplicates.map((category) => ({
        id: category.id,
        depth: getCategoryDepth(category, categoriesById),
        productCount: productCountByCategoryId[category.id] || 0,
      })),
      productMoves,
    });
  }

  groups.sort((left, right) => left.name.localeCompare(right.name, 'tr'));

  const summary = {
    duplicateGroupCount: groups.length,
    duplicateCategoryCount: groups.reduce((total, group) => total + group.duplicates.length, 0),
    productsToMove: groups.reduce((total, group) => total + group.productMoves.length, 0),
    canonicalCategories: groups.length,
  };

  return {
    rootName,
    rootId,
    summary,
    groups,
  };
}

function isTemporaryDuplicateName(name) {
  return String(name || '').startsWith('__TMP_DUP__');
}

function buildTemporaryCategoryName(categoryId) {
  return `__TMP_DUP__${String(categoryId).slice(0, 8)}`;
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

async function buildTemporaryProductRescuePlan() {
  const [categories, products] = await Promise.all([
    listCategories({ refresh: true }),
    listAllProducts(),
  ]);

  const temporaryIds = new Set(
    categories
      .filter((category) => isTemporaryDuplicateName(category.name))
      .map((category) => category.id),
  );

  const rescueItems = [];

  for (const product of products) {
    const tmpCategories = (product.categories || []).filter((category) => temporaryIds.has(category.id));
    if (!tmpCategories.length) continue;

    const sku = product.variants?.[0]?.sku || null;
    const kartfiyatCardId = extractKartfiyatIdFromSku(sku);
    const priceLabel = extractPriceLabelFromProduct(product);

    rescueItems.push({
      productId: product.id,
      productName: product.name,
      sku,
      kartfiyatCardId,
      priceLabel,
      temporaryCategoryIds: tmpCategories.map((category) => category.id),
      temporaryCategoryNames: tmpCategories.map((category) => category.name),
    });
  }

  return {
    totalProducts: rescueItems.length,
    items: rescueItems,
  };
}

async function rescueTemporaryCategoryProducts({
  dryRun = true,
  delayMs = Number(process.env.IKAS_CONSOLIDATE_DELAY_MS || 800),
  maxAttempts = 5,
} = {}) {
  const rescuePlan = await buildTemporaryProductRescuePlan();
  const stats = {
    dryRun,
    checked: rescuePlan.totalProducts,
    rescued: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  };

  async function withRetry(action, label) {
    let attempt = 0;
    while (attempt < maxAttempts) {
      try {
        return await action();
      } catch (error) {
        attempt += 1;
        const isRetryable = /timeout|network timeout|429|rate limit|too many|ECONNRESET|ETIMEDOUT|503|502|504/i.test(error.message);
        if (!isRetryable || attempt >= maxAttempts) {
          throw error;
        }
        const waitMs = delayMs * attempt * 3;
        console.warn(`[tmp-rescue] ${label} tekrar denenecek (${attempt}/${maxAttempts}): ${error.message}`);
        await sleep(waitMs);
      }
    }
    return null;
  }

  for (const item of rescuePlan.items) {
    if (!item.kartfiyatCardId) {
      stats.skipped += 1;
      stats.failures.push({
        type: 'rescue-skip',
        productId: item.productId,
        productName: item.productName,
        reason: 'SKU içinden KartFiyat ID çıkarılamadı',
      });
      continue;
    }

    try {
      const card = await getCardById(item.kartfiyatCardId);
      const setCategory = await resolveCategoryForCard(card);
      await ensureNavigationTaxonomy(setCategory.game, { allowCreate: true });
      const categoryPlan = resolveProductCategories(card, setCategory, {
        priceLabel: item.priceLabel,
      });

      if (dryRun) {
        stats.rescued += 1;
        console.log(
          `[tmp-rescue] DRY-RUN ${item.productName} → ${categoryPlan.categories.map((entry) => entry.name).join(' + ')}`,
        );
        continue;
      }

      await withRetry(
        () => updateProductTaxonomy({
          productId: item.productId,
          brandName: setCategory.brandName,
          categories: categoryPlan.categories,
        }),
        item.productName,
      );

      stats.rescued += 1;
      console.log(
        `[tmp-rescue] OK ${item.productName} → ${categoryPlan.categories.map((entry) => entry.name).join(' + ')}`,
      );
    } catch (error) {
      stats.failed += 1;
      stats.failures.push({
        type: 'rescue',
        productId: item.productId,
        productName: item.productName,
        reason: error.message,
      });
      console.error(`[tmp-rescue] FAIL ${item.productName}: ${error.message}`);
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  return { rescuePlan, stats };
}

async function buildTemporaryCategoryCleanupPlan() {
  const [categories, products] = await Promise.all([
    listCategories({ refresh: true }),
    listAllProducts(),
  ]);

  const productCountByCategoryId = {};
  for (const product of products) {
    for (const category of (product.categories || [])) {
      productCountByCategoryId[category.id] = (productCountByCategoryId[category.id] || 0) + 1;
    }
  }

  const temporaryCategories = categories.filter((category) => isTemporaryDuplicateName(category.name));
  const emptyTemporaryCategories = temporaryCategories.filter(
    (category) => !(productCountByCategoryId[category.id] || 0),
  );
  const temporaryCategoriesWithProducts = temporaryCategories.filter(
    (category) => (productCountByCategoryId[category.id] || 0) > 0,
  );

  return {
    totalTemporaryCategories: temporaryCategories.length,
    emptyTemporaryCategories: emptyTemporaryCategories.map((category) => ({
      id: category.id,
      name: category.name,
    })),
    temporaryCategoriesWithProducts: temporaryCategoriesWithProducts.map((category) => ({
      id: category.id,
      name: category.name,
      productCount: productCountByCategoryId[category.id] || 0,
    })),
  };
}

async function deleteCategoriesSafely({
  categoryIds,
  label,
  withRetry,
  delayMs,
  onSuccess,
  onFailure,
}) {
  for (const categoryId of categoryIds) {
    try {
      await withRetry(
        () => deleteCategoryList({ categoryIds: [categoryId] }),
        `${label} ${categoryId.slice(0, 8)}`,
      );
      onSuccess(categoryId);
    } catch (error) {
      onFailure(categoryId, error);
    }

    if (delayMs > 0) await sleep(delayMs);
  }
}

async function consolidateDuplicateCategories({
  dryRun = true,
  delayMs = Number(process.env.IKAS_CONSOLIDATE_DELAY_MS || 600),
  maxAttempts = 5,
  cleanupOnly = false,
  skipCleanup = false,
} = {}) {
  const plan = await buildDuplicateCategoryConsolidationPlan();
  const cleanupPlan = await buildTemporaryCategoryCleanupPlan();
  const rescuePlan = await buildTemporaryProductRescuePlan();
  const stats = {
    dryRun,
    duplicateGroups: plan.summary.duplicateGroupCount,
    categoriesRenamed: 0,
    categoriesRenameFailed: 0,
    productsMoved: 0,
    productsFailed: 0,
    categoriesDeleted: 0,
    categoriesFailed: 0,
    temporaryDeleted: 0,
    temporaryDeleteFailed: 0,
    temporaryWithProducts: cleanupPlan.temporaryCategoriesWithProducts.length,
    temporaryRescued: 0,
    temporaryRescueFailed: 0,
    failures: [],
  };

  if (
    !plan.groups.length
    && !cleanupPlan.emptyTemporaryCategories.length
    && !rescuePlan.totalProducts
  ) {
    return { plan, cleanupPlan, rescuePlan, stats };
  }

  async function withRetry(action, label) {
    let attempt = 0;
    while (attempt < maxAttempts) {
      try {
        return await action();
      } catch (error) {
        attempt += 1;
        const isRetryable = /timeout|network timeout|429|rate limit|too many|ECONNRESET|ETIMEDOUT|503|502|504/i.test(error.message);
        if (!isRetryable || attempt >= maxAttempts) {
          throw error;
        }
        const waitMs = delayMs * attempt * 3;
        console.warn(`[consolidate] ${label} tekrar denenecek (${attempt}/${maxAttempts}): ${error.message}`);
        await sleep(waitMs);
      }
    }
    return null;
  }

  const duplicateCategories = cleanupOnly
    ? []
    : plan.groups
      .flatMap((group) => group.duplicates.map((duplicate) => ({
        ...duplicate,
        groupName: group.name,
        temporaryName: buildTemporaryCategoryName(duplicate.id),
      })))
      .sort((left, right) => right.depth - left.depth);

  if (!cleanupOnly) {
    for (const duplicate of duplicateCategories) {
      if (dryRun) {
        stats.categoriesRenamed += 1;
        continue;
      }

      try {
        await withRetry(
          () => updateCategory({ id: duplicate.id, name: duplicate.temporaryName }),
          `${duplicate.groupName} rename`,
        );
        stats.categoriesRenamed += 1;
        console.log(`[consolidate] rename OK: ${duplicate.groupName}`);
      } catch (error) {
        stats.categoriesRenameFailed += 1;
        stats.failures.push({
          type: 'rename',
          categoryId: duplicate.id,
          categoryName: duplicate.groupName,
          reason: error.message,
        });
      }

      if (delayMs > 0) await sleep(delayMs);
    }

    if (!dryRun) {
      invalidateCategoryCache();
    }

    for (const group of plan.groups) {
      for (const move of group.productMoves) {
        if (dryRun) {
          stats.productsMoved += 1;
          continue;
        }

        try {
        await withRetry(
          () => updateProductTaxonomy({
            productId: move.productId,
            categoryName: move.categoryName,
            categoryPath: [plan.rootName],
          }),
          move.productName,
        );
        stats.productsMoved += 1;
        if (stats.productsMoved % 10 === 0) {
          console.log(`[consolidate] ürün taşındı: ${stats.productsMoved}`);
        }
      } catch (error) {
          stats.productsFailed += 1;
          stats.failures.push({
            type: 'product',
            productId: move.productId,
            productName: move.productName,
            categoryName: group.name,
            reason: error.message,
          });
        }

        if (delayMs > 0) await sleep(delayMs);
      }
    }

    if (!dryRun && duplicateCategories.length) {
      await deleteCategoriesSafely({
        categoryIds: duplicateCategories.map((duplicate) => duplicate.id),
        label: 'duplicate delete',
        withRetry,
        delayMs,
        onSuccess: () => {
          stats.categoriesDeleted += 1;
        },
        onFailure: (categoryId, error) => {
          stats.categoriesFailed += 1;
          const duplicate = duplicateCategories.find((entry) => entry.id === categoryId);
          stats.failures.push({
            type: 'category',
            categoryId,
            categoryName: duplicate?.groupName || categoryId,
            reason: error.message,
          });
        },
      });
    }
  }

  if (dryRun) {
    stats.categoriesDeleted = duplicateCategories.length;
    if (!skipCleanup) {
      stats.temporaryDeleted = cleanupPlan.emptyTemporaryCategories.length;
      stats.temporaryRescued = rescuePlan.totalProducts;
    }
    return { plan, cleanupPlan, rescuePlan, stats };
  }

  // Önce TMP üzerinde kalan ürünleri doğru set kategorisine taşı
  if (!skipCleanup && rescuePlan.totalProducts > 0) {
    console.log(`[consolidate] ${rescuePlan.totalProducts} ürün TMP kategorilerinden kurtarılıyor...`);
    const rescueResult = await rescueTemporaryCategoryProducts({
      dryRun: false,
      delayMs,
      maxAttempts,
    });
    stats.temporaryRescued = rescueResult.stats.rescued;
    stats.temporaryRescueFailed = rescueResult.stats.failed + rescueResult.stats.skipped;
    stats.failures.push(...rescueResult.stats.failures);
  }

  const cleanupAfterRescue = await buildTemporaryCategoryCleanupPlan();
  if (!skipCleanup && cleanupAfterRescue.emptyTemporaryCategories.length) {
    console.log(`[consolidate] ${cleanupAfterRescue.emptyTemporaryCategories.length} boş geçici kategori siliniyor...`);
    await deleteCategoriesSafely({
      categoryIds: cleanupAfterRescue.emptyTemporaryCategories.map((category) => category.id),
      label: 'tmp cleanup',
      withRetry,
      delayMs,
      onSuccess: () => {
        stats.temporaryDeleted += 1;
        if (stats.temporaryDeleted % 10 === 0) {
          console.log(`[consolidate] tmp cleanup: ${stats.temporaryDeleted}/${cleanupAfterRescue.emptyTemporaryCategories.length}`);
        }
      },
      onFailure: (categoryId, error) => {
        stats.temporaryDeleteFailed += 1;
        stats.failures.push({
          type: 'tmp-cleanup',
          categoryId,
          categoryName: categoryId,
          reason: error.message,
        });
      },
    });
  }

  invalidateCategoryCache();
  return { plan, cleanupPlan: cleanupAfterRescue, rescuePlan, stats };
}

module.exports = {
  buildDuplicateCategoryConsolidationPlan,
  buildTemporaryCategoryCleanupPlan,
  buildTemporaryProductRescuePlan,
  rescueTemporaryCategoryProducts,
  consolidateDuplicateCategories,
};
