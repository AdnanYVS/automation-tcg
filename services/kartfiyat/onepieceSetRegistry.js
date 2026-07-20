require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { listCategories } = require('./categories');

const CACHE_PATH = process.env.ONEPIECE_SET_CODES_PATH
  || path.join(__dirname, '../../data/onepiece-set-codes.json');
const OVERRIDES_PATH = process.env.ONEPIECE_SET_OVERRIDES_PATH
  || path.join(__dirname, '../../data/onepiece-set-overrides.json');
const CACHE_MAX_AGE_MS = Number(process.env.SET_CODES_CACHE_MS || 7 * 24 * 60 * 60 * 1000);
const MATCH_SCORE_THRESHOLD = Number(process.env.SET_MATCH_SCORE_THRESHOLD || 50);

let memoryCache = null;

function normalizeSetCode(code) {
  const raw = String(code || '').trim().toUpperCase();
  const match = raw.match(/^(OP|EB|ST|PRB)(\d{1,2})$/i);
  if (match) {
    return `${match[1].toUpperCase()}${match[2].padStart(2, '0')}`;
  }
  return raw;
}

function normalizeCategoryName(name) {
  return String(name || '')
    .replace(/^one piece japanese\s+/i, '')
    .replace(/^one piece\s+/i, '')
    .replace(/^extra booster\s+/i, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[：:]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMetaCategoryName(name) {
  return /setler$/i.test(String(name || '').trim());
}

function isJapaneseCategory(category) {
  return /one piece japanese/i.test(category?.name || '');
}

function isEnglishCategory(category) {
  const name = String(category?.name || '');
  return /^one piece\s+/i.test(name)
    && !/japanese/i.test(name)
    && !isMetaCategoryName(name);
}

function readOverridesFile() {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};

  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch (error) {
    console.error(`${path.basename(OVERRIDES_PATH)} okunamadı:`, error.message);
    return {};
  }
}

function scoreCategoryMatch(category, searchTerms, { excludeTerms = [] } = {}) {
  const categoryNorm = normalizeCategoryName(category.name);
  if (!categoryNorm) return 0;

  for (const rawExclude of excludeTerms) {
    const exclude = normalizeCategoryName(rawExclude);
    if (exclude && categoryNorm.includes(exclude)) {
      return 0;
    }
  }

  let best = 0;

  for (const rawTerm of searchTerms) {
    const term = normalizeCategoryName(rawTerm);
    if (!term || term.length < 2) continue;

    if (categoryNorm === term) {
      return 100;
    }

    if (categoryNorm.includes(term) || term.includes(categoryNorm)) {
      const score = (Math.min(categoryNorm.length, term.length)
        / Math.max(categoryNorm.length, term.length)) * 90;
      best = Math.max(best, score);
    }

    const categoryWords = categoryNorm.split(' ').filter(Boolean);
    const termWords = term.split(' ').filter((word) => word.length > 2);
    if (termWords.length) {
      const overlap = termWords.filter(
        (word) => categoryWords.includes(word) || categoryNorm.includes(word),
      ).length / termWords.length;
      best = Math.max(best, overlap * 80);
    }
  }

  return best;
}

function findBestCategory(searchTerms, categories, options = {}) {
  let bestCategory = null;
  let bestScore = 0;

  for (const category of categories) {
    const score = scoreCategoryMatch(category, searchTerms, options);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  if (!bestCategory || bestScore < MATCH_SCORE_THRESHOLD) {
    return { category: null, score: bestScore };
  }

  return { category: bestCategory, score: bestScore };
}

function buildSearchTerms({ setCode, setName, extraTerms = [] }) {
  const normalized = normalizeSetCode(setCode);
  return [...new Set([
    setName,
    setCode,
    normalized,
    String(setCode).toLowerCase(),
    ...extraTerms,
  ])].filter(Boolean);
}

function registerCode(codes, rawCode, entry) {
  const normalized = normalizeSetCode(rawCode);
  const variants = new Set([
    String(rawCode).trim(),
    normalized,
    String(rawCode).trim().toLowerCase(),
  ]);

  for (const key of variants) {
    if (!key) continue;
    const existing = codes[key];
    if (existing && existing.language && entry.language && existing.language !== entry.language) {
      codes[`${key}:${entry.language}`] = { ...entry, setCode: normalized };
      continue;
    }
    codes[key] = { ...entry, setCode: normalized };
  }
}

function addCategoryCodes(codes, category, setCode, setName, source, language = 'en') {
  registerCode(codes, setCode, {
    setName: setName || normalizeCategoryName(category.name),
    categoryId: category.id,
    categoryName: category.name,
    source,
    language,
    game: 'onepiece',
  });
}

function extractCodeFromCategoryName(name) {
  const value = String(name || '');
  const patterns = [
    /\b(OP\d{1,2})\b/i,
    /\b(EB\d{1,2})\b/i,
    /\b(ST\d{1,2})\b/i,
    /\b(PRB\d{1,2})\b/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return normalizeSetCode(match[1]);
  }

  return null;
}

async function buildOnePieceSetCodeRegistry() {
  const [categories, overrides] = await Promise.all([
    listCategories({ game: 'onepiece' }),
    Promise.resolve(readOverridesFile()),
  ]);

  const englishCategories = categories.filter(isEnglishCategory);
  const japaneseCategories = categories.filter(isJapaneseCategory);
  const codes = {};
  const unmatched = [];
  const englishCoverage = new Map();
  const japaneseCoverage = new Map();

  function markEnglish(category, setCode, setName, source) {
    addCategoryCodes(codes, category, setCode, setName, source, 'en');
    const existing = englishCoverage.get(category.id) || [];
    existing.push({ setCode, source });
    englishCoverage.set(category.id, existing);
  }

  function markJapanese(category, setCode, setName, source) {
    addCategoryCodes(codes, category, setCode, setName, source, 'ja');
    const existing = japaneseCoverage.get(category.id) || [];
    existing.push({ setCode, source });
    japaneseCoverage.set(category.id, existing);
  }

  for (const [rawCode, override] of Object.entries(overrides)) {
    const setCode = normalizeSetCode(rawCode);
    const searchTerms = buildSearchTerms({
      setCode,
      setName: override.setName,
      extraTerms: override.searchTerms || [],
    });

    const englishMatch = findBestCategory(searchTerms, englishCategories, {
      excludeTerms: override.excludeTerms || [],
    });
    if (englishMatch.category) {
      markEnglish(
        englishMatch.category,
        setCode,
        override.setName || setCode,
        'override-en',
      );
    }

    const japaneseMatch = findBestCategory(searchTerms, japaneseCategories, {
      excludeTerms: override.excludeTerms || [],
    });
    if (japaneseMatch.category) {
      markJapanese(
        japaneseMatch.category,
        setCode,
        override.setName || setCode,
        'override-ja',
      );
    }

    if (!englishMatch.category && !japaneseMatch.category) {
      unmatched.push({
        setCode,
        setName: override.setName || setCode,
        reason: 'override_category_not_found',
      });
    }
  }

  for (const category of [...englishCategories, ...japaneseCategories]) {
    const nameCode = extractCodeFromCategoryName(category.name);
    if (!nameCode) continue;

    const alreadyCovered = isJapaneseCategory(category)
      ? japaneseCoverage.has(category.id)
      : englishCoverage.has(category.id);
    if (alreadyCovered) continue;

    if (isJapaneseCategory(category)) {
      markJapanese(category, nameCode, normalizeCategoryName(category.name), 'name');
    } else {
      markEnglish(category, nameCode, normalizeCategoryName(category.name), 'name');
    }
  }

  const canonicalCodes = {};
  for (const [key, entry] of Object.entries(codes)) {
    canonicalCodes[key] = {
      ...entry,
      setCode: normalizeSetCode(entry.setCode || key),
    };
  }

  const uniqueEntries = Object.values(canonicalCodes).filter((entry, index, list) =>
    list.findIndex((item) =>
      normalizeSetCode(item.setCode) === normalizeSetCode(entry.setCode)
      && item.language === entry.language) === index,
  );

  return {
    updatedAt: new Date().toISOString(),
    game: 'onepiece',
    codes: canonicalCodes,
    unmatched,
    totalCodes: uniqueEntries.length,
    totalEnglishCategories: englishCategories.length,
    coveredEnglishCategories: englishCoverage.size,
    totalJapaneseCategories: japaneseCategories.length,
    coveredJapaneseCategories: japaneseCoverage.size,
    englishCodeCount: uniqueEntries.filter((entry) => entry.language === 'en').length,
    japaneseCodeCount: uniqueEntries.filter((entry) => entry.language === 'ja').length,
    sources: {
      'override-en': uniqueEntries.filter((entry) => entry.source === 'override-en').length,
      'override-ja': uniqueEntries.filter((entry) => entry.source === 'override-ja').length,
      name: uniqueEntries.filter((entry) => entry.source === 'name').length,
    },
  };
}

function readCacheFile() {
  if (!fs.existsSync(CACHE_PATH)) return null;

  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch (error) {
    console.error('onepiece-set-codes.json okunamadı:', error.message);
    return null;
  }
}

function writeCacheFile(registry) {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(registry, null, 2));
}

function isCacheFresh(registry) {
  if (!registry?.updatedAt) return false;
  const age = Date.now() - new Date(registry.updatedAt).getTime();
  return age < CACHE_MAX_AGE_MS;
}

async function syncOnePieceSetCodes({ force = false } = {}) {
  const existing = readCacheFile();
  if (!force && existing && isCacheFresh(existing)) {
    memoryCache = existing;
    return existing;
  }

  console.log('[onepieceSetRegistry] Set kodları senkronize ediliyor...');
  const registry = await buildOnePieceSetCodeRegistry();
  writeCacheFile(registry);
  memoryCache = registry;
  console.log(
    `[onepieceSetRegistry] ${registry.totalCodes} kod, `
    + `EN ${registry.coveredEnglishCategories}/${registry.totalEnglishCategories}, `
    + `JA ${registry.coveredJapaneseCategories}/${registry.totalJapaneseCategories}`,
  );
  return registry;
}

async function getOnePieceSetCodeRegistry() {
  if (memoryCache && isCacheFresh(memoryCache)) {
    return memoryCache;
  }

  const fileCache = readCacheFile();
  if (fileCache && isCacheFresh(fileCache)) {
    memoryCache = fileCache;
    return fileCache;
  }

  return syncOnePieceSetCodes();
}

async function resolveOnePieceSet(setCode) {
  const registry = await getOnePieceSetCodeRegistry();
  const normalized = normalizeSetCode(setCode);
  const lowered = String(setCode || '').trim().toLowerCase();

  return registry.codes?.[normalized]
    || registry.codes?.[lowered]
    || registry.codes?.[`${normalized}:en`]
    || registry.codes?.[`${normalized}:ja`]
    || null;
}

module.exports = {
  CACHE_PATH,
  OVERRIDES_PATH,
  normalizeOnePieceSetCode: normalizeSetCode,
  syncOnePieceSetCodes,
  getOnePieceSetCodeRegistry,
  resolveOnePieceSet,
  buildOnePieceSetCodeRegistry,
};
