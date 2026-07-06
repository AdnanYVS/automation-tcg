const { graphqlRequest } = require('./client');

const LIST_CATEGORIES_QUERY = `
  query ListCategory {
    listCategory {
      id
      name
      parentId
      categoryPath
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

  return {
    id: category.id,
    name: category.name,
    isJapanese,
    created,
  };
}

module.exports = {
  listCategories,
  findCategoryByName,
  createCategory,
  ensureCategoryExists,
  resolveCategoryForCard,
  isJapaneseCategoryName,
  invalidateCategoryCache,
};
