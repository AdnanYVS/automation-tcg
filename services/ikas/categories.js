const { graphqlRequest } = require('./client');
const { getStorefrontSalesChannelId } = require('./salesChannel');

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

const META_CATEGORY_PATTERN = /setler$/i;

function isMetaCategoryName(name) {
  const value = String(name || '').trim();
  return META_CATEGORY_PATTERN.test(value) && !/^pokemon/i.test(value);
}

let cachedCategories = null;

function normalizeCategoryName(name) {
  return String(name || '').trim().toLowerCase();
}

function isJapaneseCategoryName(name) {
  return /pokemon japanese/i.test(String(name || ''));
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

async function ensureCategoryStorefrontVisibility(category) {
  const salesChannelId = await getStorefrontSalesChannelId();
  if (isCategoryVisibleOnStorefront(category, salesChannelId)) {
    return { category, updated: false };
  }

  const updated = await enableCategoryForStorefront(category.id, { salesChannelId });
  console.log(`[ikas] Kategori mağazada görünür yapıldı: ${updated.name}`);
  return { category: updated, updated: true };
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

async function ensureCategoryExists({ name, parentId, allowCreate = false }) {
  const categories = await listCategories();
  const existing = findCategoryByName(categories, name);
  if (existing) {
    return { category: existing, created: false };
  }

  if (!allowCreate) {
    return { category: null, created: false };
  }

  const category = await createCategory({ name, parentId });
  return { category, created: true };
}

async function resolveCategoryForCard(card) {
  const categoryName = card?.category?.name;
  if (!categoryName) {
    throw new Error('KartFiyat kartında kategori bilgisi bulunamadı.');
  }

  if (isMetaCategoryName(categoryName)) {
    throw new Error(`Kart geçerli bir set kategorisinde değil: ${categoryName}`);
  }

  const isJapanese = isJapaneseCategoryName(categoryName);
  const parentId = isJapanese
    ? (process.env.IKAS_CATEGORY_PARENT_JAPANESE || null)
    : (process.env.IKAS_CATEGORY_PARENT_NORMAL || null);

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

module.exports = {
  listCategories,
  findCategoryByName,
  createCategory,
  updateCategory,
  enableCategoryForStorefront,
  ensureCategoryStorefrontVisibility,
  ensureCategoryExists,
  resolveCategoryForCard,
  buildCategoryPath,
  syncAllCategoriesToStorefront,
  isJapaneseCategoryName,
  invalidateCategoryCache,
};
