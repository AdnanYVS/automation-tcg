const { graphqlRequest } = require('./client');
const { getStorefrontSalesChannelId } = require('./salesChannel');
const {
  detectGameFromCard,
  getTaxonomyOrThrow,
  isJapaneseCategoryName: isJapaneseCategoryForTaxonomy,
  isMetaCategoryName: isMetaCategoryForTaxonomy,
} = require('./taxonomy');

const LIST_CATEGORIES_QUERY = `
  query ListCategory {
    listCategory {
      id
      name
      parentId
      categoryPath
      salesChannelIds
      salesChannels {
        id
        status
      }
    }
  }
`;

const CREATE_CATEGORY_MUTATION = `
  mutation CreateCategory($input: CreateCategoryInput!) {
    createCategory(input: $input) {
      id
      name
      parentId
    }
  }
`;

const UPDATE_CATEGORY_MUTATION = `
  mutation UpdateCategory($input: UpdateCategoryInput!) {
    updateCategory(input: $input) {
      id
      name
      parentId
      salesChannelIds
      salesChannels {
        id
        status
      }
    }
  }
`;

const DELETE_CATEGORY_LIST_MUTATION = `
  mutation DeleteCategoryList($idList: [String!]!) {
    deleteCategoryList(idList: $idList)
  }
`;

function getPokemonRootCategoryName() {
  return getTaxonomyOrThrow('pokemon').rootCategoryName;
}

async function ensureRootCategory(gameId, { allowCreate = true } = {}) {
  const taxonomy = getTaxonomyOrThrow(gameId);
  return ensureCategoryExists({
    name: taxonomy.rootCategoryName,
    parentId: null,
    allowCreate,
  });
}

async function ensurePokemonRootCategory({ allowCreate = true } = {}) {
  return ensureRootCategory('pokemon', { allowCreate });
}

async function getRootCategoryId(gameId) {
  const taxonomy = getTaxonomyOrThrow(gameId);
  const categories = await listCategories();
  const existing = findCategoryByName(categories, taxonomy.rootCategoryName);
  return existing?.id || null;
}

async function getPokemonRootCategoryId() {
  return getRootCategoryId('pokemon');
}

function isMetaCategoryName(name) {
  return isMetaCategoryForTaxonomy(name);
}

let cachedCategories = null;

function normalizeCategoryName(name) {
  return String(name || '').trim().toLowerCase();
}

function isJapaneseCategoryName(name) {
  const taxonomy = detectGameFromCard({ category: { name } }, { fallbackGame: 'pokemon' });
  return isJapaneseCategoryForTaxonomy(name, taxonomy);
}

function invalidateCategoryCache() {
  cachedCategories = null;
}

async function listCategories({ refresh = false } = {}) {
  if (!refresh && cachedCategories) {
    return cachedCategories;
  }

  const data = await graphqlRequest(LIST_CATEGORIES_QUERY);
  cachedCategories = data.listCategory || [];
  return cachedCategories;
}

function findCategoryByName(categories, name) {
  const target = normalizeCategoryName(name);
  if (!target) return null;

  return categories.find((category) => normalizeCategoryName(category.name) === target) || null;
}

function findCategoryByNameAndParent(categories, name, parentId) {
  const target = normalizeCategoryName(name);
  if (!target) return null;

  const normalizedParentId = parentId || null;
  return categories.find((category) =>
    normalizeCategoryName(category.name) === target
    && (category.parentId || null) === normalizedParentId,
  ) || null;
}

function isCategoryVisibleOnStorefront(category, salesChannelId) {
  return (category.salesChannels || []).some(
    (channel) => channel.id === salesChannelId && channel.status === 'VISIBLE',
  );
}

function buildCategoryPath(category, categoriesById) {
  const path = [];
  let current = category;

  while (current) {
    path.unshift(current.name);
    current = current.parentId ? categoriesById.get(current.parentId) : null;
  }

  return path;
}

async function updateCategory(input) {
  const data = await graphqlRequest(UPDATE_CATEGORY_MUTATION, { input });
  invalidateCategoryCache();
  return data.updateCategory;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateCategoryWithRetry(input, { maxAttempts = 5, delayMs = 400 } = {}) {
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      return await updateCategory(input);
    } catch (error) {
      const isRateLimited = /429|rate limit|too many/i.test(error.message);
      attempt += 1;
      if (!isRateLimited || attempt >= maxAttempts) {
        throw error;
      }
      const waitMs = delayMs * attempt;
      console.warn(`[ikas] Rate limit, ${waitMs}ms sonra tekrar denenecek (${input.id})`);
      await sleep(waitMs);
    }
  }

  return null;
}

async function enableCategoryForStorefront(categoryId, { salesChannelId } = {}) {
  const channelId = salesChannelId || await getStorefrontSalesChannelId();
  return updateCategory({
    id: categoryId,
    salesChannels: [{ id: channelId, status: 'VISIBLE' }],
  });
}

async function disableCategoryForStorefront(categoryId, { salesChannelId } = {}) {
  const channelId = salesChannelId || await getStorefrontSalesChannelId();
  return updateCategory({
    id: categoryId,
    salesChannels: [{ id: channelId, status: 'HIDDEN' }],
  });
}

async function ensureCategoryStorefrontVisibility(category) {
  const salesChannelId = await getStorefrontSalesChannelId();
  if (isCategoryVisibleOnStorefront(category, salesChannelId)) {
    return { category, updated: false };
  }

  const updated = await enableCategoryForStorefront(category.id, { salesChannelId });
  console.log(`[ikas] Kategori mağazada görünür yapıldı: ${updated.name}`);
  return { category: updated, updated: true };
}

async function ensureCategoryStorefrontHidden(category) {
  const salesChannelId = await getStorefrontSalesChannelId();
  if (!isCategoryVisibleOnStorefront(category, salesChannelId)) {
    return { category, updated: false };
  }

  const updated = await disableCategoryForStorefront(category.id, { salesChannelId });
  console.log(`[ikas] Kategori mağazada gizlendi: ${updated.name}`);
  return { category: updated, updated: true };
}

function isDuplicateCategoryError(error) {
  return /E11000|duplicate key|merchantId_1_name_1_parentId_1/i.test(String(error?.message || ''));
}

async function createCategory({ name, parentId }) {
  const input = { name: String(name).trim() };
  if (parentId) {
    input.parentId = parentId;
  }

  const data = await graphqlRequest(CREATE_CATEGORY_MUTATION, { input });
  const category = data.createCategory;

  if (!category?.id) {
    throw new Error(`ikas kategorisi oluşturulamadı: ${name}`);
  }

  invalidateCategoryCache();
  console.log(`[ikas] Yeni kategori oluşturuldu: ${category.name} (${category.id})`);

  await enableCategoryForStorefront(category.id);
  return category;
}

async function deleteCategoryList({ categoryIds }) {
  if (!categoryIds?.length) {
    return { deleted: 0 };
  }

  await graphqlRequest(DELETE_CATEGORY_LIST_MUTATION, { idList: categoryIds });
  invalidateCategoryCache();
  return { deleted: categoryIds.length };
}

async function findExistingCategoryAfterConflict(name, parentId) {
  const categories = await listCategories({ refresh: true });
  return findCategoryByNameAndParent(categories, name, parentId)
    || findCategoryByName(categories, name)
    || null;
}

async function ensureCategoryExists({ name, parentId, allowCreate = false }) {
  const categories = await listCategories();
  const exactMatch = findCategoryByNameAndParent(categories, name, parentId);
  if (exactMatch) {
    return { category: exactMatch, created: false };
  }

  // Yanlışlıkla kökte (parentId=null) kalan kategori varsa doğru parent altına taşı.
  // Farklı oyun kökü altındakilere dokunma (Pokemon vs One Piece).
  if (parentId) {
    const orphan = findCategoryByNameAndParent(categories, name, null);
    if (orphan) {
      try {
        const updated = await updateCategory({
          id: orphan.id,
          parentId,
        });
        console.log(`[ikas] Kök kategorisi taşındı: ${name} → parent ${parentId}`);
        return { category: updated || { ...orphan, parentId }, created: false };
      } catch (error) {
        if (isDuplicateCategoryError(error)) {
          const existing = await findExistingCategoryAfterConflict(name, parentId);
          if (existing) return { category: existing, created: false };
        }
        console.warn(`[ikas] Kök kategori taşınamadı (${name}):`, error.message);
      }
    }
  } else {
    const existing = findCategoryByName(categories, name);
    if (existing) {
      return { category: existing, created: false };
    }
  }

  if (!allowCreate) {
    return { category: null, created: false };
  }

  try {
    const category = await createCategory({ name, parentId });
    return { category, created: true };
  } catch (error) {
    if (!isDuplicateCategoryError(error)) {
      throw error;
    }

    const existing = await findExistingCategoryAfterConflict(name, parentId);
    if (existing) {
      console.warn(`[ikas] Duplicate kategori yakalandı, mevcut kullanılıyor: ${name}`);
      return { category: existing, created: false };
    }

    throw error;
  }
}

async function resolveCategoryForCard(card) {
  const categoryName = card?.category?.name;
  if (!categoryName) {
    throw new Error('KartFiyat kartında kategori bilgisi bulunamadı.');
  }

  if (isMetaCategoryName(categoryName)) {
    throw new Error(`Kart geçerli bir set kategorisinde değil: ${categoryName}`);
  }

  const taxonomy = detectGameFromCard(card);
  const isJapanese = isJapaneseCategoryForTaxonomy(categoryName, taxonomy);
  const rootCategory = await ensureRootCategory(taxonomy.id, { allowCreate: true });
  const parentId = rootCategory.category?.id
    || (isJapanese
      ? (process.env.IKAS_CATEGORY_PARENT_JAPANESE || null)
      : (process.env.IKAS_CATEGORY_PARENT_NORMAL || null));

  const { category, created } = await ensureCategoryExists({
    name: categoryName,
    parentId,
    allowCreate: true,
  });

  if (!category) {
    throw new Error(`ikas'ta "${categoryName}" kategorisi oluşturulamadı.`);
  }

  const categories = await listCategories({ refresh: true });
  const categoriesById = new Map(categories.map((entry) => [entry.id, entry]));
  const path = buildCategoryPath(categoriesById.get(category.id) || category, categoriesById);

  return {
    id: category.id,
    name: category.name,
    parentId: category.parentId || parentId || null,
    path,
    productCategoryPath: [taxonomy.rootCategoryName],
    brandName: taxonomy.brandName,
    game: taxonomy.id,
    kartfiyatGame: taxonomy.kartfiyatGame,
    isJapanese,
    created,
  };
}

async function syncAllCategoriesToStorefront({ assignParentIds = true, delayMs = 400 } = {}) {
  const salesChannelId = await getStorefrontSalesChannelId();
  const categories = await listCategories({ refresh: true });
  const categoriesById = new Map(categories.map((entry) => [entry.id, entry]));

  const stats = {
    total: categories.length,
    visibilityUpdated: 0,
    parentUpdated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const category of categories) {
    try {
      const input = {};
      let shouldUpdate = false;

      if (!isCategoryVisibleOnStorefront(category, salesChannelId)) {
        input.salesChannels = [{ id: salesChannelId, status: 'VISIBLE' }];
        shouldUpdate = true;
      }

      if (assignParentIds && !category.parentId) {
        const isJapanese = isJapaneseCategoryName(category.name);
        const parentId = isJapanese
          ? (process.env.IKAS_CATEGORY_PARENT_JAPANESE || null)
          : (process.env.IKAS_CATEGORY_PARENT_NORMAL || null);

        if (parentId && parentId !== category.id) {
          input.parentId = parentId;
          shouldUpdate = true;
        }
      }

      if (!shouldUpdate) {
        stats.skipped += 1;
        continue;
      }

      const updated = await updateCategoryWithRetry({ id: category.id, ...input }, { delayMs });
      categoriesById.set(updated.id, { ...category, ...updated });

      if (input.salesChannels) stats.visibilityUpdated += 1;
      if (input.parentId) stats.parentUpdated += 1;

      if (delayMs > 0) await sleep(delayMs);
    } catch (error) {
      stats.failed += 1;
      console.error(`[ikas] Kategori senkronizasyonu başarısız (${category.name}):`, error.message);
    }
  }

  invalidateCategoryCache();
  return stats;
}

async function assignAllCategoriesUnderPokemonRoot({ delayMs = 500 } = {}) {
  const rootName = getPokemonRootCategoryName();
  const salesChannelId = await getStorefrontSalesChannelId();
  const { category: rootCategory, created } = await ensurePokemonRootCategory({ allowCreate: true });

  if (!rootCategory?.id) {
    throw new Error(`"${rootName}" ana kategorisi oluşturulamadı.`);
  }

  if (!isCategoryVisibleOnStorefront(rootCategory, salesChannelId)) {
    await enableCategoryForStorefront(rootCategory.id, { salesChannelId });
  }

  const categories = await listCategories({ refresh: true });
  const stats = {
    rootCategoryId: rootCategory.id,
    rootCategoryName: rootCategory.name,
    rootCreated: created,
    total: categories.length,
    parentUpdated: 0,
    skipped: 0,
    duplicateSkipped: 0,
    failed: 0,
  };

  const childrenUnderRoot = categories.filter((category) => category.parentId === rootCategory.id);
  const childNamesUnderRoot = new Set(
    childrenUnderRoot.map((category) => normalizeCategoryName(category.name)),
  );

  for (const category of categories) {
    if (category.id === rootCategory.id) {
      stats.skipped += 1;
      continue;
    }

    if (category.parentId === rootCategory.id) {
      stats.skipped += 1;
      continue;
    }

    if (childNamesUnderRoot.has(normalizeCategoryName(category.name))) {
      stats.duplicateSkipped += 1;
      console.warn(`[ikas] Kategori zaten Pokemon altında var, atlandı: ${category.name}`);
      continue;
    }

    try {
      await updateCategoryWithRetry({
        id: category.id,
        parentId: rootCategory.id,
      }, { delayMs });
      stats.parentUpdated += 1;
      childNamesUnderRoot.add(normalizeCategoryName(category.name));
      if (delayMs > 0) await sleep(delayMs);
    } catch (error) {
      const isDuplicate = /duplicate key|E11000/i.test(error.message);
      if (isDuplicate) {
        stats.duplicateSkipped += 1;
        console.warn(`[ikas] Yinelenen kategori atlandı: ${category.name}`);
        continue;
      }

      stats.failed += 1;
      console.error(`[ikas] Kategori taşınamadı (${category.name}):`, error.message);
    }
  }

  invalidateCategoryCache();
  return stats;
}

module.exports = {
  listCategories,
  findCategoryByName,
  findCategoryByNameAndParent,
  createCategory,
  updateCategory,
  deleteCategoryList,
  enableCategoryForStorefront,
  disableCategoryForStorefront,
  ensureCategoryStorefrontVisibility,
  ensureCategoryStorefrontHidden,
  ensureCategoryExists,
  ensureRootCategory,
  ensurePokemonRootCategory,
  getRootCategoryId,
  getPokemonRootCategoryId,
  getPokemonRootCategoryName,
  resolveCategoryForCard,
  buildCategoryPath,
  isCategoryVisibleOnStorefront,
  syncAllCategoriesToStorefront,
  assignAllCategoriesUnderPokemonRoot,
  isJapaneseCategoryName,
  invalidateCategoryCache,
};
