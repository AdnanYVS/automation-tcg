const {
  listCategories,
  getPokemonRootCategoryId,
  getPokemonRootCategoryName,
  deleteCategoryList,
  updateCategory,
  invalidateCategoryCache,
} = require('./categories');
const { listAllProducts, updateProductTaxonomy } = require('./products');

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
    failures: [],
  };

  if (!plan.groups.length && !cleanupPlan.emptyTemporaryCategories.length) {
    return { plan, cleanupPlan, stats };
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
              categoryPath: [plan.rootName, move.categoryName],
            }),
            move.productName,
          );
          stats.productsMoved += 1;
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
    }
    return { plan, cleanupPlan, stats };
  }

  if (!skipCleanup && cleanupPlan.emptyTemporaryCategories.length) {
    console.log(`[consolidate] ${cleanupPlan.emptyTemporaryCategories.length} boş geçici kategori siliniyor...`);
    await deleteCategoriesSafely({
      categoryIds: cleanupPlan.emptyTemporaryCategories.map((category) => category.id),
      label: 'tmp cleanup',
      withRetry,
      delayMs,
      onSuccess: (categoryId) => {
        stats.temporaryDeleted += 1;
        if (stats.temporaryDeleted % 10 === 0) {
          console.log(`[consolidate] tmp cleanup: ${stats.temporaryDeleted}/${cleanupPlan.emptyTemporaryCategories.length}`);
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
  return { plan, cleanupPlan, stats };
}

module.exports = {
  buildDuplicateCategoryConsolidationPlan,
  buildTemporaryCategoryCleanupPlan,
  consolidateDuplicateCategories,
};
