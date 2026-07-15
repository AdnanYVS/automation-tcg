const GAME_TAXONOMIES = {
  pokemon: {
    id: 'pokemon',
    kartfiyatGame: 'pokemon',
    rootCategoryName: process.env.IKAS_POKEMON_ROOT_NAME
      || process.env.IKAS_CATEGORY_ROOT_NAME
      || 'Pokemon',
    brandName: process.env.IKAS_POKEMON_BRAND_NAME || 'Pokemon',
    categoryPatterns: [/^pokemon\b/i],
    japanesePattern: /pokemon japanese/i,
  },
  onepiece: {
    id: 'onepiece',
    kartfiyatGame: 'onepiece',
    rootCategoryName: process.env.IKAS_ONEPIECE_ROOT_NAME || 'One Piece',
    brandName: process.env.IKAS_ONEPIECE_BRAND_NAME || 'One Piece',
    categoryPatterns: [/^one piece\b/i, /\bone\s*piece\b/i],
    japanesePattern: /one piece japanese/i,
  },
};

const DEFAULT_GAME_ID = 'pokemon';

const ONE_PIECE_CODE_PATTERN = /\b(?:OP|EB|ST|PRB|OP-\d)\d{0,2}\b/i;
const NON_POKEMON_BRAND_PATTERN = /\b(one\s*piece|riftbound|lorcana|digimon|yu-?gi-?oh|flesh\s*and\s*blood)\b/i;

function normalizeGameId(game) {
  const value = String(game || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!value) return DEFAULT_GAME_ID;
  if (value === 'onepiece' || value === 'op') return 'onepiece';
  if (value === 'pokemon' || value === 'pkmn') return 'pokemon';
  return String(game || '').trim().toLowerCase();
}

function getSupportedGames() {
  return Object.values(GAME_TAXONOMIES);
}

function getTaxonomy(gameId) {
  const normalized = normalizeGameId(gameId);
  return GAME_TAXONOMIES[normalized] || null;
}

function getTaxonomyOrThrow(gameId) {
  const taxonomy = getTaxonomy(gameId);
  if (!taxonomy) {
    throw new Error(`Desteklenmeyen oyun: ${gameId}`);
  }
  return taxonomy;
}

function buildExternalTaxonomy(rawGame, { categoryName } = {}) {
  const label = String(rawGame || categoryName || 'Other').trim();
  const id = normalizeGameId(label) || 'other';
  return {
    id,
    kartfiyatGame: id,
    rootCategoryName: label,
    brandName: label,
    categoryPatterns: [],
    japanesePattern: /$a/,
    unsupported: true,
  };
}

function detectGameFromCategoryName(categoryName) {
  const value = String(categoryName || '').trim();
  if (!value) return null;

  if (/\briftbound\b/i.test(value)) {
    return buildExternalTaxonomy('Riftbound', { categoryName: value });
  }

  for (const taxonomy of getSupportedGames()) {
    if (taxonomy.categoryPatterns.some((pattern) => pattern.test(value))) {
      return taxonomy;
    }
  }

  if (ONE_PIECE_CODE_PATTERN.test(value) && /\b(one\s*piece|japanese|english)\b/i.test(value)) {
    return getTaxonomyOrThrow('onepiece');
  }

  return null;
}

function detectGameFromCard(card, { fallbackGame } = {}) {
  const rawGame = String(card?.game || card?.category?.game || '').trim();
  const normalizedRaw = normalizeGameId(rawGame);

  if (normalizedRaw === 'onepiece' || /onepiece|one\s*piece/i.test(rawGame)) {
    return getTaxonomyOrThrow('onepiece');
  }
  if (normalizedRaw === 'pokemon' || /^pokemon$/i.test(rawGame)) {
    return getTaxonomyOrThrow('pokemon');
  }
  if (rawGame && !getTaxonomy(rawGame)) {
    return buildExternalTaxonomy(rawGame, { categoryName: card?.category?.name });
  }

  const fromCategory = detectGameFromCategoryName(card?.category?.name);
  if (fromCategory) return fromCategory;

  const explicitFallback = getTaxonomy(fallbackGame);
  if (explicitFallback) return explicitFallback;

  if (NON_POKEMON_BRAND_PATTERN.test(`${card?.name || ''} ${card?.category?.name || ''}`)) {
    if (/\bone\s*piece\b/i.test(`${card?.name || ''} ${card?.category?.name || ''}`)
      || ONE_PIECE_CODE_PATTERN.test(`${card?.name || ''} ${card?.category?.name || ''}`)) {
      return getTaxonomyOrThrow('onepiece');
    }
    return buildExternalTaxonomy(card?.category?.name || card?.name || 'Other');
  }

  return getTaxonomyOrThrow(DEFAULT_GAME_ID);
}

function isJapaneseCategoryName(categoryName, taxonomy) {
  return taxonomy.japanesePattern.test(String(categoryName || ''));
}

function isMetaCategoryName(categoryName) {
  const value = String(categoryName || '').trim();
  if (!/setler$/i.test(value)) return false;
  return !getSupportedGames().some((taxonomy) =>
    taxonomy.categoryPatterns.some((pattern) => pattern.test(value)),
  );
}

function looksLikeNonPokemonProduct({ name, brand, categoryNames = [] } = {}) {
  const blob = [name, brand, ...categoryNames].filter(Boolean).join(' ');
  if (NON_POKEMON_BRAND_PATTERN.test(blob)) return true;
  if (/\briftbound\b/i.test(blob)) return true;
  if (/\bone\s*piece\b/i.test(blob)) return true;
  if (ONE_PIECE_CODE_PATTERN.test(blob) && /\b(op|eb|st|prb)\d{2}\b/i.test(blob)) return true;
  return false;
}

module.exports = {
  GAME_TAXONOMIES,
  DEFAULT_GAME_ID,
  NON_POKEMON_BRAND_PATTERN,
  normalizeGameId,
  getSupportedGames,
  getTaxonomy,
  getTaxonomyOrThrow,
  detectGameFromCategoryName,
  detectGameFromCard,
  isJapaneseCategoryName,
  isMetaCategoryName,
  looksLikeNonPokemonProduct,
  buildExternalTaxonomy,
};
