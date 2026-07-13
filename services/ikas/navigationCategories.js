const { isGradedPriceLabel } = require('../kartfiyat/cards');
const { detectGameFromCard, getTaxonomyOrThrow } = require('./taxonomy');
const {
  ensureRootCategory,
  ensureCategoryExists,
  listCategories,
  invalidateCategoryCache,
} = require('./categories');

const NAV_ROOT_GROUPS = {
  sealed: 'KAPALI KUTULAR',
  single: 'SINGLE KARTLAR',
  graded: 'GRADED KARTLAR',
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

function classifySealedSubtype(card) {
  const text = `${card?.category?.name || ''} ${card?.name || ''}`;
  const matchedRule = SEALED_TYPE_RULES.find((rule) => rule.pattern.test(text));
  if (matchedRule) return matchedRule.subtype;
  if (SEALED_FALLBACK_PATTERN.test(text)) return 'Diğer Ürünler';
  return null;
}

function classifyProductKind(card, { priceLabel } = {}) {
  if (priceLabel && isGradedPriceLabel(priceLabel)) return 'graded';
  if (classifySealedSubtype(card)) return 'sealed';
  return 'single';
}

function detectLanguageCategory(card, taxonomy) {
  const categoryName = String(card?.category?.name || '');
  if (taxonomy.japanesePattern.test(categoryName) || /\bjapanese\b|\bjaponca\b/i.test(categoryName)) {
    return 'Japonca Kartlar';
  }
  if (/\bchinese\b|\bcince\b|\bçince\b|\bsimplified\b/i.test(categoryName)) {
    return 'Çince Kartlar';
  }
  return 'İngilizce Kartlar';
}

function getGradedNavigationCategory(priceLabel) {
  const match = String(priceLabel || '').trim().match(/^(PSA|BGS|CGC|SGC|ACE|TAG|Grade)\b/i);
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

function dedupeCategoryRefs(categories) {
  const seen = new Set();
  return categories.filter((entry) => {
    const key = `${entry.path.join('>')}|${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function ensureNavigationTaxonomy(gameId, { allowCreate = true } = {}) {
  const { category: rootCategory } = await ensureRootCategory(gameId, { allowCreate });
  if (!rootCategory?.id) {
    throw new Error(`"${gameId}" kök kategorisi bulunamadı.`);
  }

  const rootName = rootCategory.name;
  const stats = {
    gameId,
    rootCategoryId: rootCategory.id,
    rootCategoryName: rootName,
    created: 0,
    existing: 0,
  };

  async function ensureChild(name, parentId) {
    const result = await ensureCategoryExists({ name, parentId, allowCreate });
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

  invalidateCategoryCache();
  return stats;
}

function resolveNavigationCategories(card, { priceLabel } = {}) {
  const taxonomy = detectGameFromCard(card);
  const rootName = taxonomy.rootCategoryName;
  const kind = classifyProductKind(card, { priceLabel });
  const navigation = [];

  if (kind === 'graded') {
    navigation.push(
      buildCategoryRef(rootName, NAV_ROOT_GROUPS.graded, getGradedNavigationCategory(priceLabel)),
    );
  } else if (kind === 'sealed') {
    navigation.push(
      buildCategoryRef(
        rootName,
        NAV_ROOT_GROUPS.sealed,
        classifySealedSubtype(card) || 'Diğer Ürünler',
      ),
    );
  } else {
    navigation.push(
      buildCategoryRef(rootName, NAV_ROOT_GROUPS.single, detectLanguageCategory(card, taxonomy)),
    );
  }

  return {
    kind,
    navigation,
    taxonomy,
  };
}

function resolveProductCategories(card, setCategory, { priceLabel } = {}) {
  const { kind, navigation, taxonomy } = resolveNavigationCategories(card, { priceLabel });
  const rootName = taxonomy.rootCategoryName;

  const categories = dedupeCategoryRefs([
    {
      name: setCategory.name,
      path: setCategory.productCategoryPath?.length
        ? setCategory.productCategoryPath
        : [rootName],
    },
    ...navigation,
  ]);

  return {
    categories,
    kind,
    navigation,
    gameId: taxonomy.id,
  };
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

  return { rootName, rootId: root?.id || null, groups };
}

module.exports = {
  NAV_ROOT_GROUPS,
  SEALED_SUBCATEGORIES,
  SINGLE_LANGUAGE_SUBCATEGORIES,
  GRADED_COMPANY_SUBCATEGORIES,
  classifyProductKind,
  classifySealedSubtype,
  detectLanguageCategory,
  getGradedNavigationCategory,
  ensureNavigationTaxonomy,
  resolveNavigationCategories,
  resolveProductCategories,
  listNavigationCategorySummary,
};
