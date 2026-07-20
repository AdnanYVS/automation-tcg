const { isGradedPriceLabel, normalizePriceLabel } = require('../kartfiyat/cards');
const { getTaxonomyOrThrow, looksLikeNonPokemonProduct } = require('./taxonomy');
const {
  ensureRootCategory,
  ensureCategoryExists,
  listCategories,
  invalidateCategoryCache,
  ensureCategoryStorefrontVisibility,
  ensureCategoryStorefrontHidden,
  isCategoryVisibleOnStorefront,
  buildCategoryPath,
} = require('./categories');
const { getStorefrontSalesChannelId } = require('./salesChannel');

const LANGUAGE_BRANCHES = ['İngilizce', 'Japonca', 'Çince'];

const PRODUCT_TYPE_LEAVES = [
  'Booster Box',
  'Elite Trainer Box',
  'Single Pack',
  'Tinler',
  'Kutular',
  'Single Cards',
  'Graded Cards',
  'Bulk',
];

const TYPE_RULES = [
  { type: 'Elite Trainer Box', pattern: /\b(elite trainer box|etb)\b/i },
  { type: 'Booster Box', pattern: /\bbooster box\b/i },
  { type: 'Single Pack', pattern: /\b(booster pack|sleeved booster|booster paket|single pack)\b/i },
  { type: 'Tinler', pattern: /\b(tin box|mini tin|poke ball tin|\btin\b|tinler)\b/i },
  {
    type: 'Kutular',
    pattern: /\b(collection box|premium collection|special collection|ultra premium collection|booster bundle|bundle|gift box|build box|deck box|premium box|display|blister|prerelease|collection)\b/i,
  },
];

const SEALED_FALLBACK_PATTERN = /\b(box|bundle|deck|gift|display|blister|prerelease|trainer box|premium)\b/i;

let shopTaxonomyReady = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectLanguageBranch(card, { productName } = {}) {
  const text = `${card?.category?.name || ''} ${productName || card?.name || ''}`;

  if (/\bchinese\b|\bcince\b|\bçince\b|\bsimplified\b/i.test(text)) {
    return 'Çince';
  }
  if (/\bjapanese\b|\bjaponca\b/i.test(text)) {
    return 'Japonca';
  }
  return 'İngilizce';
}

function detectProductType(card, { priceLabel, productName } = {}) {
  const normalizedLabel = normalizePriceLabel(priceLabel);
  const nameText = `${productName || ''} ${card?.name || ''}`;

  if (
    (normalizedLabel && isGradedPriceLabel(normalizedLabel))
    || /\[(PSA|BGS|CGC|SGC|ACE|TAG|Grade)\s+[\d.]+\]/i.test(nameText)
  ) {
    return 'Graded Cards';
  }

  const text = `${card?.category?.name || ''} ${nameText}`;
  const matched = TYPE_RULES.find((rule) => rule.pattern.test(text));
  if (matched) return matched.type;
  if (SEALED_FALLBACK_PATTERN.test(text)) return 'Kutular';
  return 'Single Cards';
}

function classifyPokemonShopPlacement(card, { priceLabel = null, productName = null, isBulk = false } = {}) {
  const language = detectLanguageBranch(card, { productName });
  const productType = isBulk
    ? 'Bulk'
    : detectProductType(card, { priceLabel, productName });

  return {
    language,
    productType,
    leafName: productType,
    path: ['Pokemon', language],
    category: {
      name: productType,
      path: ['Pokemon', language],
    },
  };
}

function dedupeCategoryRefs(categories) {
  const seen = new Set();
  return categories.filter((entry) => {
    const key = `${(entry.path || []).join('>')}|${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolvePokemonShopCategories(card, { priceLabel = null, productName = null, isBulk = false } = {}) {
  const placement = classifyPokemonShopPlacement(card, { priceLabel, productName, isBulk });
  const rootName = getTaxonomyOrThrow('pokemon').rootCategoryName;

  // ikas üst kategori sayfasında alt menüyü doldurmak için dil + kök de atanır.
  // Yalnızca leaf atanınca Pokemon sayfasında İngilizce/Japonca resultCount=0 kalır.
  const categories = dedupeCategoryRefs([
    {
      name: placement.leafName,
      path: [rootName, placement.language],
    },
    {
      name: placement.language,
      path: [rootName],
    },
    {
      name: rootName,
      path: [],
    },
  ]);

  return {
    ...placement,
    categories,
  };
}

async function ensurePokemonShopTaxonomy({ allowCreate = true, force = false } = {}) {
  if (!force && shopTaxonomyReady) {
    return { skipped: true };
  }

  const taxonomy = getTaxonomyOrThrow('pokemon');
  const { category: rootCategory } = await ensureRootCategory('pokemon', { allowCreate });
  if (!rootCategory?.id) {
    throw new Error(`"${taxonomy.rootCategoryName}" kök kategorisi oluşturulamadı.`);
  }

  const stats = {
    rootCategoryId: rootCategory.id,
    rootCategoryName: rootCategory.name,
    created: 0,
    existing: 0,
  };

  async function ensureChild(name, parentId) {
    if (!parentId) {
      throw new Error(`Kategori parent olmadan oluşturulamaz: ${name}`);
    }
    const result = await ensureCategoryExists({ name, parentId, allowCreate });
    if (!result.category?.id) {
      throw new Error(`Kategori hazırlanamadı: ${name}`);
    }
    if (result.created) stats.created += 1;
    else stats.existing += 1;
    return result.category;
  }

  for (const language of LANGUAGE_BRANCHES) {
    const languageCategory = await ensureChild(language, rootCategory.id);
    for (const productType of PRODUCT_TYPE_LEAVES) {
      await ensureChild(productType, languageCategory.id);
    }
  }

  invalidateCategoryCache();
  shopTaxonomyReady = true;
  return stats;
}

function collectPokemonShopCategoryIds(categories, root) {
  const keepIds = new Set();
  if (!root?.id) return keepIds;

  keepIds.add(root.id);

  for (const languageName of LANGUAGE_BRANCHES) {
    const language = categories.find(
      (entry) => entry.name === languageName && entry.parentId === root.id,
    );
    if (!language?.id) continue;
    keepIds.add(language.id);

    for (const productType of PRODUCT_TYPE_LEAVES) {
      const leaf = categories.find(
        (entry) => entry.name === productType && entry.parentId === language.id,
      );
      if (leaf?.id) keepIds.add(leaf.id);
    }
  }

  return keepIds;
}

function collectProtectedCategoryIds(categories) {
  const protectedIds = new Set();
  const onePieceRootName = getTaxonomyOrThrow('onepiece').rootCategoryName;
  const pokemonRootName = getTaxonomyOrThrow('pokemon').rootCategoryName;
  const categoriesById = new Map(categories.map((entry) => [entry.id, entry]));
  const opRoot = categories.find((entry) => entry.name === onePieceRootName && !entry.parentId);

  // One Piece shop ağacı (kök + dil + tip) — set kategorileri değil
  if (opRoot?.id) {
    protectedIds.add(opRoot.id);
    for (const languageName of LANGUAGE_BRANCHES) {
      const language = categories.find(
        (entry) => entry.name === languageName && entry.parentId === opRoot.id,
      );
      if (!language?.id) continue;
      protectedIds.add(language.id);
      for (const productType of PRODUCT_TYPE_LEAVES) {
        const leaf = categories.find(
          (entry) => entry.name === productType && entry.parentId === language.id,
        );
        if (leaf?.id) protectedIds.add(leaf.id);
      }
    }
  }

  for (const category of categories) {
    const path = buildCategoryPath(category, categoriesById);
    const rootName = path[0] || '';

    if (rootName === pokemonRootName) continue;

    if (
      /\briftbound\b/i.test(path.join(' > '))
      || /\briftbound\b/i.test(category.name)
    ) {
      protectedIds.add(category.id);
    }
  }

  return protectedIds;
}

async function listPokemonShopTaxonomySummary() {
  const categories = await listCategories({ refresh: true });
  const rootName = getTaxonomyOrThrow('pokemon').rootCategoryName;
  const root = categories.find((entry) => entry.name === rootName && !entry.parentId);

  const languages = LANGUAGE_BRANCHES.map((languageName) => {
    const language = categories.find(
      (entry) => entry.name === languageName && entry.parentId === (root?.id || null),
    );
    const children = categories
      .filter((entry) => entry.parentId === language?.id)
      .map((child) => ({ id: child.id, name: child.name }));

    return {
      language: languageName,
      languageId: language?.id || null,
      children,
    };
  });

  return {
    rootName,
    rootId: root?.id || null,
    languages,
  };
}

/**
 * Shop ağacını VISIBLE yapar; One Piece dışındaki diğer tüm kategorileri HIDDEN yapar.
 */
async function syncPokemonShopStorefrontVisibility({
  dryRun = false,
  hideOthers = true,
  delayMs = Number(process.env.IKAS_CATEGORY_VISIBILITY_DELAY_MS || 250),
} = {}) {
  const salesChannelId = await getStorefrontSalesChannelId();
  const taxonomy = getTaxonomyOrThrow('pokemon');
  const categories = await listCategories({ refresh: true });
  const root = categories.find(
    (entry) => entry.name === taxonomy.rootCategoryName && !entry.parentId,
  );

  if (!root?.id) {
    throw new Error(`"${taxonomy.rootCategoryName}" kök kategorisi bulunamadı.`);
  }

  const keepIds = collectPokemonShopCategoryIds(categories, root);
  const protectedIds = collectProtectedCategoryIds(categories);
  const categoriesById = new Map(categories.map((entry) => [entry.id, entry]));

  const stats = {
    dryRun,
    keepVisible: keepIds.size,
    protectedNonPokemon: protectedIds.size,
    shown: 0,
    hidden: 0,
    skipped: 0,
    failed: 0,
    toShow: [],
    toHide: [],
    failures: [],
  };

  for (const category of categories) {
    if (!keepIds.has(category.id) && !protectedIds.has(category.id)) continue;
    const visible = isCategoryVisibleOnStorefront(category, salesChannelId);
    if (visible) {
      stats.skipped += 1;
      continue;
    }
    stats.toShow.push({
      id: category.id,
      name: category.name,
      reason: keepIds.has(category.id) ? 'shop' : 'protected',
    });
  }

  if (hideOthers) {
    for (const category of categories) {
      if (keepIds.has(category.id) || protectedIds.has(category.id)) continue;
      if (!isCategoryVisibleOnStorefront(category, salesChannelId)) {
        stats.skipped += 1;
        continue;
      }
      const path = buildCategoryPath(category, categoriesById).join(' > ');
      stats.toHide.push({ id: category.id, name: category.name, path });
    }
  }

  if (dryRun) {
    stats.shown = stats.toShow.length;
    stats.hidden = stats.toHide.length;
    return stats;
  }

  for (const item of stats.toShow) {
    try {
      const category = categoriesById.get(item.id);
      const result = await ensureCategoryStorefrontVisibility(category);
      if (result.updated) stats.shown += 1;
      else stats.skipped += 1;
    } catch (error) {
      stats.failed += 1;
      stats.failures.push({ id: item.id, name: item.name, action: 'show', reason: error.message });
      console.error(`[pokemon-shop] VISIBLE başarısız ${item.name}: ${error.message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  for (const item of stats.toHide) {
    try {
      const category = categoriesById.get(item.id);
      const result = await ensureCategoryStorefrontHidden(category);
      if (result.updated) stats.hidden += 1;
      else stats.skipped += 1;
    } catch (error) {
      stats.failed += 1;
      stats.failures.push({ id: item.id, name: item.name, action: 'hide', reason: error.message });
      console.error(`[pokemon-shop] HIDDEN başarısız ${item.name}: ${error.message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  invalidateCategoryCache();
  return stats;
}

function isPokemonProduct(product) {
  const brand = String(product?.brand?.name || '');
  const categoryNames = (product?.categories || []).map((category) => String(category?.name || ''));
  const productName = String(product?.name || '');

  if (looksLikeNonPokemonProduct({ name: productName, brand, categoryNames })) {
    return false;
  }

  if (/^one\s*piece$/i.test(brand) || /\briftbound\b/i.test(brand)) {
    return false;
  }

  // Sadece açık Pokemon brand veya gerçek Pokemon set kategorisi
  if (/^pokemon$/i.test(brand)) {
    return true;
  }

  return categoryNames.some((name) => /^pokemon\b/i.test(name));
}

module.exports = {
  LANGUAGE_BRANCHES,
  PRODUCT_TYPE_LEAVES,
  detectLanguageBranch,
  detectProductType,
  classifyPokemonShopPlacement,
  resolvePokemonShopCategories,
  ensurePokemonShopTaxonomy,
  listPokemonShopTaxonomySummary,
  syncPokemonShopStorefrontVisibility,
  collectPokemonShopCategoryIds,
  isPokemonProduct,
};
