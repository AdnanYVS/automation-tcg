const { isGradedPriceLabel } = require('../kartfiyat/cards');
const { detectGameFromCard, getTaxonomyOrThrow, getSupportedGames } = require('./taxonomy');
const {
  ensureRootCategory,
  ensureCategoryExists,
  listCategories,
  invalidateCategoryCache,
  buildCategoryPath,
  isCategoryVisibleOnStorefront,
  ensureCategoryStorefrontVisibility,
  ensureCategoryStorefrontHidden,
} = require('./categories');
const { getStorefrontSalesChannelId } = require('./salesChannel');

const NAV_ROOT_GROUPS = {
  sealed: 'Sealed Ürünler',
  single: 'Single Kartlar',
  graded: 'Graded Kartlar',
};

/** Eski İngilizce/büyük harf isimler — migration ve visibility sync için */
const LEGACY_NAV_GROUP_NAMES = [
  'KAPALI KUTULAR',
  'SINGLE KARTLAR',
  'GRADED KARTLAR',
];

const BULK_SUBCATEGORIES = ['Bulk / İngilizce', 'Bulk / Japonca'];

const BULK_LANGUAGE_MAP = {
  en: 'Bulk / İngilizce',
  ja: 'Bulk / Japonca',
};

const SEALED_SUBCATEGORIES = [
  'Elite Trainer Box',
  'Booster Pack',
  'Booster Bundle',
  'Booster Box',
  'Collection Box',
  'Tin Box',
  'Diğer Ürünler',
];

const SINGLE_LANGUAGE_SUBCATEGORIES = [
  'İngilizce Kartlar',
  'Japonca Kartlar',
  'Çince Kartlar',
];

const GRADED_COMPANY_SUBCATEGORIES = [
  'PSA Graded',
  'BGS Graded',
  'CGC Graded',
  'ACE Graded',
  'TAG Graded',
  'Diğer Graded',
];

/** Eski shop ağacı leaf isimleri — vitrin sync sırasında gizlenir */
const LEGACY_SHOP_LANGUAGE_BRANCHES = ['İngilizce', 'Japonca', 'Çince'];
const LEGACY_SHOP_PRODUCT_TYPE_LEAVES = [
  'Booster Box',
  'Elite Trainer Box',
  'Single Pack',
  'Tinler',
  'Kutular',
  'Single Cards',
  'Graded Cards',
];

const SEALED_TYPE_RULES = [
  { subtype: 'Elite Trainer Box', pattern: /\b(elite trainer box|etb)\b/i },
  { subtype: 'Booster Pack', pattern: /\b(booster pack|sleeved booster|booster paket)\b/i },
  { subtype: 'Booster Bundle', pattern: /\bbooster bundle\b/i },
  { subtype: 'Booster Box', pattern: /\bbooster box\b/i },
  { subtype: 'Collection Box', pattern: /\b(collection box|premium collection|special collection|ultra premium collection)\b/i },
  { subtype: 'Tin Box', pattern: /\b(tin box|mini tin|poke ball tin|\btin\b)/i },
];

const SEALED_FALLBACK_PATTERN = /\b(box|bundle|deck|build box|gift box|display|blister|prerelease|trainer box|premium box|collection|tin)\b/i;

const GRADED_COMPANY_MAP = {
  PSA: 'PSA Graded',
  BGS: 'BGS Graded',
  CGC: 'CGC Graded',
  ACE: 'ACE Graded',
  TAG: 'TAG Graded',
  SGC: 'Diğer Graded',
  GRADE: 'Diğer Graded',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBulkLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'ja' || raw === 'jp' || raw === 'japonca' || raw === 'japanese') return 'ja';
  return 'en';
}

function resolveBulkCategoryName(bulkLanguage) {
  return BULK_LANGUAGE_MAP[normalizeBulkLanguage(bulkLanguage)] || BULK_SUBCATEGORIES[0];
}

function classifySealedSubtype(card) {
  const text = `${card?.category?.name || ''} ${card?.name || ''}`;
  const matchedRule = SEALED_TYPE_RULES.find((rule) => rule.pattern.test(text));
  if (matchedRule) return matchedRule.subtype;
  if (SEALED_FALLBACK_PATTERN.test(text)) return 'Diğer Ürünler';
  return null;
}

function classifyProductKind(card, { priceLabel, productKind } = {}) {
  if (productKind === 'bulk') return 'bulk';

  const nameText = String(card?.name || '');
  if (priceLabel && isGradedPriceLabel(priceLabel)) return 'graded';
  if (/\[(PSA|BGS|CGC|SGC|ACE|TAG|Grade)\s+[\d.]+\]/i.test(nameText)) return 'graded';
  if (classifySealedSubtype(card)) return 'sealed';
  return 'single';
}

function detectLanguageCategory(card, taxonomy) {
  const categoryName = String(card?.category?.name || '');
  const nameText = String(card?.name || '');
  const blob = `${categoryName} ${nameText}`;

  if (taxonomy.japanesePattern.test(categoryName) || /\bjapanese\b|\bjaponca\b/i.test(blob)) {
    return 'Japonca Kartlar';
  }
  if (/\bchinese\b|\bcince\b|\bçince\b|\bsimplified\b/i.test(blob)) {
    return 'Çince Kartlar';
  }
  return 'İngilizce Kartlar';
}

function getGradedNavigationCategory(priceLabel, productName = '') {
  const labelMatch = String(priceLabel || '').trim().match(/^(PSA|BGS|CGC|SGC|ACE|TAG|Grade)\b/i);
  const nameMatch = String(productName || '').match(/\[(PSA|BGS|CGC|SGC|ACE|TAG|Grade)\s+[\d.]+\]/i);
  const match = labelMatch || nameMatch;
  if (!match) return 'Diğer Graded';
  const key = match[1].toUpperCase() === 'GRADE' ? 'GRADE' : match[1].toUpperCase();
  return GRADED_COMPANY_MAP[key] || 'Diğer Graded';
}

function buildCategoryRef(rootName, ...segments) {
  return {
    name: segments[segments.length - 1],
    path: [rootName, ...segments.slice(0, -1)],
  };
}

function expandNavigationToCategoryRefs(rootName, navSegments) {
  const refs = [];
  for (let index = navSegments.length - 1; index >= 0; index -= 1) {
    refs.push({
      name: navSegments[index],
      path: [rootName, ...navSegments.slice(0, index)],
    });
  }
  refs.push({ name: rootName, path: [] });
  return refs;
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

function buildProductTags(card, { kind, bulkLanguage, priceLabel, productName } = {}) {
  const taxonomy = detectGameFromCard(card);
  const tags = [`game:${taxonomy.id}`, `type:${kind}`];

  if (kind === 'bulk') {
    tags.push(`lang:${normalizeBulkLanguage(bulkLanguage)}`);
    return tags;
  }

  if (kind === 'single') {
    const langCategory = detectLanguageCategory(card, taxonomy);
    if (langCategory.includes('Japonca')) tags.push('lang:ja');
    else if (langCategory.includes('Çince')) tags.push('lang:zh');
    else tags.push('lang:en');
  }

  if (kind === 'graded') {
    const gradedLeaf = getGradedNavigationCategory(priceLabel, productName);
    tags.push(`graded:${gradedLeaf.replace(/\s+/g, '-').toLowerCase()}`);
  }

  if (kind === 'sealed') {
    const sealedLeaf = classifySealedSubtype(card) || 'diger';
    tags.push(`sealed:${sealedLeaf.replace(/\s+/g, '-').toLowerCase()}`);
  }

  return tags;
}

let navigationTaxonomyReady = new Set();

async function ensureNavigationTaxonomy(gameId, { allowCreate = true, force = false } = {}) {
  if (!force && navigationTaxonomyReady.has(gameId)) {
    return { gameId, skipped: true };
  }

  const { category: rootCategory } = await ensureRootCategory(gameId, { allowCreate });
  if (!rootCategory?.id) {
    throw new Error(`"${gameId}" kök kategorisi bulunamadı.`);
  }

  const stats = {
    gameId,
    rootCategoryId: rootCategory.id,
    rootCategoryName: rootCategory.name,
    created: 0,
    existing: 0,
  };

  async function ensureChild(name, parentId) {
    if (!parentId) {
      throw new Error(`Navigasyon kategorisi parent olmadan oluşturulamaz: ${name}`);
    }
    const result = await ensureCategoryExists({ name, parentId, allowCreate });
    if (!result.category?.id) {
      throw new Error(`Navigasyon kategorisi hazırlanamadı: ${name}`);
    }
    if (result.created) stats.created += 1;
    else stats.existing += 1;
    return result.category;
  }

  const groupIds = {};
  for (const groupName of Object.values(NAV_ROOT_GROUPS)) {
    const group = await ensureChild(groupName, rootCategory.id);
    groupIds[groupName] = group.id;
  }

  for (const subtype of SEALED_SUBCATEGORIES) {
    await ensureChild(subtype, groupIds[NAV_ROOT_GROUPS.sealed]);
  }
  for (const subtype of SINGLE_LANGUAGE_SUBCATEGORIES) {
    await ensureChild(subtype, groupIds[NAV_ROOT_GROUPS.single]);
  }
  for (const subtype of GRADED_COMPANY_SUBCATEGORIES) {
    await ensureChild(subtype, groupIds[NAV_ROOT_GROUPS.graded]);
  }
  for (const bulkName of BULK_SUBCATEGORIES) {
    await ensureChild(bulkName, rootCategory.id);
  }

  invalidateCategoryCache();
  navigationTaxonomyReady.add(gameId);
  return stats;
}

function resolveNavigationCategories(card, {
  priceLabel,
  productKind = null,
  bulkLanguage = null,
  productName = null,
} = {}) {
  const taxonomy = detectGameFromCard(card);
  const rootName = taxonomy.rootCategoryName;
  const kind = classifyProductKind(card, { priceLabel, productKind });
  let navSegments = [];

  if (kind === 'bulk') {
    navSegments = [resolveBulkCategoryName(bulkLanguage)];
  } else if (kind === 'graded') {
    navSegments = [
      NAV_ROOT_GROUPS.graded,
      getGradedNavigationCategory(priceLabel, productName || card?.name),
    ];
  } else if (kind === 'sealed') {
    navSegments = [
      NAV_ROOT_GROUPS.sealed,
      classifySealedSubtype(card) || 'Diğer Ürünler',
    ];
  } else {
    navSegments = [
      NAV_ROOT_GROUPS.single,
      detectLanguageCategory(card, taxonomy),
    ];
  }

  return {
    kind,
    navSegments,
    navigation: [buildCategoryRef(rootName, ...navSegments)],
    taxonomy,
    tags: buildProductTags(card, {
      kind,
      bulkLanguage,
      priceLabel,
      productName: productName || card?.name,
    }),
  };
}

function resolveProductCategories(card, _setCategory = null, options = {}) {
  const {
    kind,
    navSegments,
    navigation,
    taxonomy,
    tags,
  } = resolveNavigationCategories(card, options);
  const rootName = taxonomy.rootCategoryName;
  const categories = dedupeCategoryRefs(expandNavigationToCategoryRefs(rootName, navSegments));

  return {
    categories,
    kind,
    navigation,
    navSegments,
    tags,
    gameId: taxonomy.id,
    brandName: taxonomy.brandName,
  };
}

function collectNavigationCategoryIds(categories, root) {
  const keepIds = new Set();
  if (!root?.id) return keepIds;

  keepIds.add(root.id);

  const allGroupNames = [
    ...Object.values(NAV_ROOT_GROUPS),
    ...LEGACY_NAV_GROUP_NAMES,
    ...BULK_SUBCATEGORIES,
  ];

  for (const groupName of allGroupNames) {
    const group = categories.find(
      (entry) => entry.name === groupName && entry.parentId === root.id,
    );
    if (!group?.id) continue;
    keepIds.add(group.id);

    for (const childName of [
      ...SEALED_SUBCATEGORIES,
      ...SINGLE_LANGUAGE_SUBCATEGORIES,
      ...GRADED_COMPANY_SUBCATEGORIES,
      ...LEGACY_SHOP_LANGUAGE_BRANCHES,
      ...LEGACY_SHOP_PRODUCT_TYPE_LEAVES,
    ]) {
      const child = categories.find(
        (entry) => entry.name === childName && entry.parentId === group.id,
      );
      if (child?.id) keepIds.add(child.id);

      for (const grandChildName of LEGACY_SHOP_PRODUCT_TYPE_LEAVES) {
        const grandChild = categories.find(
          (entry) => entry.name === grandChildName && entry.parentId === child?.id,
        );
        if (grandChild?.id) keepIds.add(grandChild.id);
      }
    }
  }

  for (const bulkName of BULK_SUBCATEGORIES) {
    const bulk = categories.find(
      (entry) => entry.name === bulkName && entry.parentId === root.id,
    );
    if (bulk?.id) keepIds.add(bulk.id);
  }

  return keepIds;
}

function collectProtectedCategoryIds(categories) {
  const protectedIds = new Set();
  const categoriesById = new Map(categories.map((entry) => [entry.id, entry]));

  for (const category of categories) {
    const path = buildCategoryPath(category, categoriesById);
    const pathText = path.join(' > ');
    if (/\briftbound\b/i.test(pathText) || /\briftbound\b/i.test(category.name)) {
      protectedIds.add(category.id);
    }
  }

  return protectedIds;
}

async function syncNavigationStorefrontVisibility({
  dryRun = false,
  hideOthers = true,
  delayMs = Number(process.env.IKAS_CATEGORY_VISIBILITY_DELAY_MS || 250),
} = {}) {
  const salesChannelId = await getStorefrontSalesChannelId();
  const categories = await listCategories({ refresh: true });
  const categoriesById = new Map(categories.map((entry) => [entry.id, entry]));
  const keepIds = new Set();
  const protectedIds = collectProtectedCategoryIds(categories);

  for (const game of getSupportedGames()) {
    const root = categories.find(
      (entry) => entry.name === game.rootCategoryName && !entry.parentId,
    );
    for (const id of collectNavigationCategoryIds(categories, root)) {
      keepIds.add(id);
    }
  }

  const stats = {
    dryRun,
    keepVisible: keepIds.size,
    protectedNonNav: protectedIds.size,
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
    if (isCategoryVisibleOnStorefront(category, salesChannelId)) {
      stats.skipped += 1;
      continue;
    }
    stats.toShow.push({
      id: category.id,
      name: category.name,
      reason: keepIds.has(category.id) ? 'navigation' : 'protected',
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
      console.error(`[navigation] VISIBLE başarısız ${item.name}: ${error.message}`);
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
      console.error(`[navigation] HIDDEN başarısız ${item.name}: ${error.message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  invalidateCategoryCache();
  return stats;
}

async function listNavigationCategorySummary(gameId) {
  const categories = await listCategories({ refresh: true });
  const taxonomy = getTaxonomyOrThrow(gameId);
  const rootName = taxonomy.rootCategoryName;
  const root = categories.find((entry) => entry.name === rootName);

  const groups = Object.values(NAV_ROOT_GROUPS).map((groupName) => {
    const group = categories.find((entry) =>
      entry.name === groupName && entry.parentId === (root?.id || null),
    );
    const children = categories.filter((entry) => entry.parentId === group?.id);
    return {
      groupName,
      groupId: group?.id || null,
      children: children.map((child) => ({ id: child.id, name: child.name })),
    };
  });

  const bulk = BULK_SUBCATEGORIES.map((bulkName) => {
    const category = categories.find((entry) =>
      entry.name === bulkName && entry.parentId === (root?.id || null),
    );
    return {
      name: bulkName,
      id: category?.id || null,
    };
  });

  return { rootName, rootId: root?.id || null, groups, bulk };
}

module.exports = {
  NAV_ROOT_GROUPS,
  LEGACY_NAV_GROUP_NAMES,
  BULK_SUBCATEGORIES,
  SEALED_SUBCATEGORIES,
  SINGLE_LANGUAGE_SUBCATEGORIES,
  GRADED_COMPANY_SUBCATEGORIES,
  classifyProductKind,
  classifySealedSubtype,
  detectLanguageCategory,
  getGradedNavigationCategory,
  normalizeBulkLanguage,
  resolveBulkCategoryName,
  buildProductTags,
  ensureNavigationTaxonomy,
  resolveNavigationCategories,
  resolveProductCategories,
  collectNavigationCategoryIds,
  syncNavigationStorefrontVisibility,
  listNavigationCategorySummary,
};
