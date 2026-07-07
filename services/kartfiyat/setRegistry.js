require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { listCategories } = require('./categories');
const { fetchVendorToolsSets } = require('./setCodeSources');

const CACHE_PATH = process.env.SET_CODES_PATH || path.join(__dirname, '../../data/set-codes.json');
const OVERRIDES_PATH = process.env.SET_OVERRIDES_PATH || path.join(__dirname, '../../data/japanese-set-overrides.json');
const EN_OVERRIDES_PATH = process.env.EN_SET_OVERRIDES_PATH || path.join(__dirname, '../../data/english-set-overrides.json');
const CACHE_MAX_AGE_MS = Number(process.env.SET_CODES_CACHE_MS || 7 * 24 * 60 * 60 * 1000);
const MATCH_SCORE_THRESHOLD = Number(process.env.SET_MATCH_SCORE_THRESHOLD || 50);

let memoryCache = null;

const PTCGO_SEARCH_TERMS = {
  MEW: ['151', 'scarlet violet 151', 'pokemon card 151'],
  PAL: ['paldea evolved'],
  OBF: ['obsidian flames'],
  PAR: ['paradox rift'],
  TEF: ['temporal forces'],
  SSP: ['surging sparks'],
  PRE: ['prismatic evolutions'],
  ASC: ['ascended heroes'],
  PFL: ['phantasmal flames'],
  MEG: ['mega evolution'],
  JTG: ['journey together'],
  BLK: ['black bolt'],
  WHT: ['white flare'],
  SWSH: ['sword shield'],
  ASR: ['astral radiance'],
  BRS: ['brilliant stars'],
  CRZ: ['crown zenith'],
  DAA: ['darkness ablaze'],
  EVS: ['evolving skies'],
  FST: ['fusion strike'],
  LOR: ['lost origin'],
  PGO: ['pokemon go'],
  SHF: ['shining fates'],
  SIT: ['silver tempest'],
  CRE: ['chilling reign'],
  BST: ['battle styles'],
  SHL: ['shrouded fable'],
  DRI: ['destined rivals'],
};

const META_CATEGORY_PATTERN = /setler$/i;

function isMetaCategoryName(name) {
  const value = String(name || '').trim();
  return META_CATEGORY_PATTERN.test(value)
    || /^(ingilizce|japonca|korece|cince)\s+setler$/i.test(value);
}

function isJapaneseCategory(category) {
  return /pokemon japanese/i.test(category?.name || '');
}

function isEnglishPokemonCategory(category) {
  const name = String(category?.name || '');
  return /^pokemon\s+/i.test(name)
    && !/japanese|korean|chinese|cince|korece/i.test(name)
    && !isMetaCategoryName(name);
}

function normalizeCategoryName(name) {
  return String(name || '')
    .replace(/^pokemon japanese\s+/i, '')
    .replace(/^pokemon\s+/i, '')
    .toLowerCase()
    .replace(/[：:]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSetCode(code) {
  return String(code || '').trim().toUpperCase();
}

function readOverridesFile(filePath = OVERRIDES_PATH) {
  if (!fs.existsSync(filePath)) return {};

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`${path.basename(filePath)} okunamadı:`, error.message);
    return {};
  }
}

function scoreCategoryMatch(category, searchTerms) {
  const categoryNorm = normalizeCategoryName(category.name);
  if (!categoryNorm) return 0;

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

function findBestCategory(searchTerms, japaneseCategories) {
  let bestCategory = null;
  let bestScore = 0;

  for (const category of japaneseCategories) {
    const score = scoreCategoryMatch(category, searchTerms);
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

function extractCodeFromCategoryName(name) {
  const suffix = String(name).replace(/^Pokemon Japanese\s+/i, '').trim();
  if (/^[A-Za-z0-9]{2,8}$/.test(suffix)) return suffix;
  if (/^[A-Za-z]{1,4}[0-9]+[A-Za-z]?$/i.test(suffix)) return suffix;
  return null;
}

function slugToFallbackCode(slug) {
  const part = String(slug || '').replace(/^pokemon-japanese-/, '').trim();
  if (!part) return null;
  if (/^[a-z0-9]{2,8}$/i.test(part)) return part.toUpperCase();

  const words = part.split('-').filter((word) => word.length > 1);
  if (!words.length) return null;

  const acronym = words
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 8);

  return acronym.length >= 2 ? acronym : null;
}

function buildSearchTerms({ setCode, setName, extraTerms = [] }) {
  const terms = new Set([
    setName,
    setCode,
    String(setCode).toLowerCase(),
    ...(PTCGO_SEARCH_TERMS[setCode] || []),
    ...(PTCGO_SEARCH_TERMS[normalizeSetCode(setCode)] || []),
    ...extraTerms,
  ]);

  return [...terms].filter(Boolean);
}

function registerCode(codes, rawCode, entry) {
  const variants = new Set([
    String(rawCode).trim(),
    normalizeSetCode(rawCode),
    String(rawCode).trim().toLowerCase(),
  ]);

  for (const key of variants) {
    if (!key) continue;
    const existing = codes[key];
    if (existing && existing.language && entry.language && existing.language !== entry.language) {
      codes[`${key}:${entry.language}`] = { ...entry, setCode: key };
      continue;
    }
    codes[key] = { ...entry, setCode: key };
  }
}

async function fetchTcgdexJapaneseSets() {
  const response = await axios.get('https://api.tcgdex.net/v2/ja/sets', { timeout: 30000 });
  return response.data || [];
}

async function fetchTcgdexEnglishSets() {
  const response = await axios.get('https://api.tcgdex.net/v2/en/sets', { timeout: 30000 });
  return response.data || [];
}

async function fetchPokemonTcgSets() {
  const sets = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const response = await axios.get('https://api.pokemontcg.io/v2/sets', {
      params: { page, pageSize: 250 },
      timeout: 60000,
      headers: process.env.POKEMON_TCG_API_KEY
        ? { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY }
        : undefined,
    });

    const batch = response.data?.data || [];
    sets.push(...batch);
    totalPages = response.data?.totalPages || 1;
    page += 1;
  }

  return sets.filter((set) => set.ptcgoCode);
}

function addCategoryCodes(codes, category, setCode, setName, source, language = 'ja') {
  registerCode(codes, setCode, {
    setName: setName || normalizeCategoryName(category.name),
    categoryId: category.id,
    categoryName: category.name,
    source,
    language,
  });
}

async function buildSetCodeRegistry() {
  const [
    categories,
    tcgdexJaSets,
    tcgdexEnSets,
    pokemonSets,
    vendorToolsSets,
    overrides,
    englishOverrides,
  ] = await Promise.all([
    listCategories({ game: 'pokemon' }),
    fetchTcgdexJapaneseSets(),
    fetchTcgdexEnglishSets(),
    fetchPokemonTcgSets(),
    fetchVendorToolsSets().catch((error) => {
      console.error('[setRegistry] VendorTools set listesi alınamadı:', error.message);
      return [];
    }),
    Promise.resolve(readOverridesFile(OVERRIDES_PATH)),
    Promise.resolve(readOverridesFile(EN_OVERRIDES_PATH)),
  ]);

  const japaneseCategories = categories.filter(isJapaneseCategory);
  const englishCategories = categories.filter(isEnglishPokemonCategory);

  const enNameById = Object.fromEntries(
    tcgdexEnSets.map((set) => [String(set.id).toLowerCase(), set.name]),
  );

  const codes = {};
  const unmatched = [];
  const categoryCoverage = new Map();
  const englishCategoryCoverage = new Map();

  function markCovered(category, setCode, setName, source, language = 'ja') {
    addCategoryCodes(codes, category, setCode, setName, source, language);
    const existing = categoryCoverage.get(category.id) || [];
    existing.push({ setCode, source, language });
    categoryCoverage.set(category.id, existing);
  }

  function markEnglishCovered(category, setCode, setName, source) {
    markCovered(category, setCode, setName, source, 'en');
    const existing = englishCategoryCoverage.get(category.id) || [];
    existing.push({ setCode, source });
    englishCategoryCoverage.set(category.id, existing);
  }

  function hasEnglishCode(setCode) {
    const key = normalizeSetCode(setCode);
    const entry = codes[key] || codes[`${key}:en`];
    return entry?.language === 'en';
  }

  for (const [rawCode, override] of Object.entries(englishOverrides)) {
    const { category } = findBestCategory(
      buildSearchTerms({
        setCode: rawCode,
        setName: override.setName,
        extraTerms: override.searchTerms || [],
      }),
      englishCategories,
    );

    if (category) {
      markEnglishCovered(category, rawCode, override.setName || rawCode, 'override-en');
    } else {
      unmatched.push({
        setCode: normalizeSetCode(rawCode),
        setName: override.setName || rawCode,
        reason: 'english_override_category_not_found',
      });
    }
  }

  for (const [rawCode, override] of Object.entries(overrides)) {
    const { category } = findBestCategory(
      buildSearchTerms({
        setCode: rawCode,
        setName: override.setName,
        extraTerms: override.searchTerms || [],
      }),
      japaneseCategories,
    );

    if (category) {
      markCovered(category, rawCode, override.setName || rawCode, 'override');
    } else {
      unmatched.push({
        setCode: normalizeSetCode(rawCode),
        setName: override.setName || rawCode,
        reason: 'override_category_not_found',
      });
    }
  }

  for (const vendorSet of vendorToolsSets) {
    const { category } = findBestCategory(
      buildSearchTerms({ setCode: vendorSet.setCode, setName: vendorSet.setName }),
      japaneseCategories,
    );

    if (category) {
      markCovered(category, vendorSet.setCode, vendorSet.setName, 'vendortools');
    } else {
      unmatched.push({
        setCode: vendorSet.setCode,
        setName: vendorSet.setName,
        reason: 'vendortools_no_match',
      });
    }
  }

  for (const set of tcgdexJaSets) {
    const setCode = String(set.id).trim();
    if (!setCode || codes[setCode] || codes[normalizeSetCode(setCode)]) continue;

    const enName = enNameById[setCode.toLowerCase()];
    const { category } = findBestCategory(
      buildSearchTerms({ setCode, setName: set.name, extraTerms: enName ? [enName] : [] }),
      japaneseCategories,
    );

    if (category && !categoryCoverage.has(category.id)) {
      markCovered(category, setCode, enName || set.name, 'tcgdex');
    }
  }

  for (const set of pokemonSets) {
    const setCode = normalizeSetCode(set.ptcgoCode);
    if (!setCode || hasEnglishCode(setCode)) continue;

    const { category } = findBestCategory(
      buildSearchTerms({ setCode, setName: set.name }),
      englishCategories,
    );

    if (category) {
      markEnglishCovered(category, setCode, set.name, 'ptcgo-en');
    } else {
      unmatched.push({
        setCode,
        setName: set.name,
        reason: 'ptcgo_en_no_match',
      });
    }
  }

  for (const set of tcgdexEnSets) {
    const setCode = normalizeSetCode(set.id);
    if (!setCode || hasEnglishCode(setCode) || codes[setCode]) continue;

    const { category } = findBestCategory(
      buildSearchTerms({ setCode, setName: set.name }),
      englishCategories,
    );

    if (category && !englishCategoryCoverage.has(category.id)) {
      markEnglishCovered(category, setCode, set.name, 'tcgdex-en');
    }
  }

  for (const category of japaneseCategories) {
    const nameCode = extractCodeFromCategoryName(category.name);
    if (nameCode && !codes[nameCode] && !codes[normalizeSetCode(nameCode)]) {
      markCovered(category, nameCode, normalizeCategoryName(category.name), 'name');
    }
  }

  for (const category of japaneseCategories) {
    if (categoryCoverage.has(category.id)) continue;

    const fallbackCode = slugToFallbackCode(category.slug);
    if (fallbackCode) {
      markCovered(category, fallbackCode, normalizeCategoryName(category.name), 'slug');
      continue;
    }

    unmatched.push({
      categoryId: category.id,
      categoryName: category.name,
      reason: 'kartfiyat_no_code',
    });
  }

  const canonicalCodes = {};
  for (const [key, entry] of Object.entries(codes)) {
    canonicalCodes[key] = {
      ...entry,
      setCode: normalizeSetCode(entry.setCode || key),
    };
  }

  const uniqueEntries = Object.values(canonicalCodes).filter((entry, index, list) =>
    list.findIndex((item) => normalizeSetCode(item.setCode) === normalizeSetCode(entry.setCode)
      && item.language === entry.language) === index,
  );

  return {
    updatedAt: new Date().toISOString(),
    codes: canonicalCodes,
    unmatched,
    totalCodes: uniqueEntries.length,
    totalCategories: japaneseCategories.length,
    coveredCategories: categoryCoverage.size,
    totalEnglishCategories: englishCategories.length,
    coveredEnglishCategories: englishCategoryCoverage.size,
    sources: {
      vendortools: uniqueEntries.filter((entry) => entry.source === 'vendortools').length,
      tcgdex: uniqueEntries.filter((entry) => entry.source === 'tcgdex').length,
      'tcgdex-en': uniqueEntries.filter((entry) => entry.source === 'tcgdex-en').length,
      'ptcgo-en': uniqueEntries.filter((entry) => entry.source === 'ptcgo-en').length,
      'override-en': uniqueEntries.filter((entry) => entry.source === 'override-en').length,
      ptcgo: uniqueEntries.filter((entry) => entry.source === 'ptcgo').length,
      override: uniqueEntries.filter((entry) => entry.source === 'override').length,
      name: uniqueEntries.filter((entry) => entry.source === 'name').length,
      slug: uniqueEntries.filter((entry) => entry.source === 'slug').length,
    },
    englishCodeCount: uniqueEntries.filter((entry) => entry.language === 'en').length,
    japaneseCodeCount: uniqueEntries.filter((entry) => entry.language === 'ja').length,
  };
}

function readCacheFile() {
  if (!fs.existsSync(CACHE_PATH)) return null;

  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch (error) {
    console.error('set-codes.json okunamadı:', error.message);
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

async function syncSetCodes({ force = false } = {}) {
  const existing = readCacheFile();

  if (!force && existing && isCacheFresh(existing)) {
    memoryCache = existing;
    return existing;
  }

  console.log('[setRegistry] Set kodları senkronize ediliyor...');
  const registry = await buildSetCodeRegistry();
  writeCacheFile(registry);
  memoryCache = registry;
  console.log(
    `[setRegistry] ${registry.totalCodes} kod, ${registry.coveredCategories}/${registry.totalCategories} kategori.`,
    registry.sources || '',
  );
  return registry;
}

async function getSetCodeRegistry() {
  if (memoryCache && isCacheFresh(memoryCache)) {
    return memoryCache;
  }

  const fileCache = readCacheFile();
  if (fileCache && isCacheFresh(fileCache)) {
    memoryCache = fileCache;
    return fileCache;
  }

  return syncSetCodes();
}

async function resolveSet(setCode) {
  const registry = await getSetCodeRegistry();
  const normalized = normalizeSetCode(setCode);
  const lowered = String(setCode || '').trim().toLowerCase();

  return registry.codes?.[normalized]
    || registry.codes?.[lowered]
    || registry.codes?.[`${normalized}:en`]
    || registry.codes?.[`${normalized}:ja`]
    || null;
}

async function resolveJapaneseSet(setCode) {
  const entry = await resolveSet(setCode);
  if (!entry || entry.language === 'en') {
    return null;
  }
  return entry;
}

module.exports = {
  CACHE_PATH,
  OVERRIDES_PATH,
  syncSetCodes,
  getSetCodeRegistry,
  resolveSet,
  resolveJapaneseSet,
  buildSetCodeRegistry,
};
