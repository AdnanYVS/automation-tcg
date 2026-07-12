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
    categoryPatterns: [/^one piece\b/i],
    japanesePattern: /one piece japanese/i,
  },
};

const DEFAULT_GAME_ID = 'pokemon';

function normalizeGameId(game) {
  const value = String(game || '').trim().toLowerCase();
  if (!value) return DEFAULT_GAME_ID;
  if (value === 'one-piece' || value === 'one_piece') return 'onepiece';
  return value;
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

function detectGameFromCategoryName(categoryName) {
  const value = String(categoryName || '').trim();
  if (!value) return null;

  for (const taxonomy of getSupportedGames()) {
    if (taxonomy.categoryPatterns.some((pattern) => pattern.test(value))) {
      return taxonomy;
    }
  }

  return null;
}

function detectGameFromCard(card, { fallbackGame } = {}) {
  const categoryName = card?.category?.name;
  const fromCategory = detectGameFromCategoryName(categoryName);
  if (fromCategory) return fromCategory;

  const explicitGame = getTaxonomy(card?.game || card?.category?.game || fallbackGame);
  if (explicitGame) return explicitGame;

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

module.exports = {
  GAME_TAXONOMIES,
  DEFAULT_GAME_ID,
  normalizeGameId,
  getSupportedGames,
  getTaxonomy,
  getTaxonomyOrThrow,
  detectGameFromCategoryName,
  detectGameFromCard,
  isJapaneseCategoryName,
  isMetaCategoryName,
};
