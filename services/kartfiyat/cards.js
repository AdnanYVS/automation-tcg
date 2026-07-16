const { createKartfiyatClient, parseApiResponse } = require('./client');
const { getCategoryItems } = require('./categories');
const { resolveSetForGame } = require('./setCodeResolver');
const { normalizeGameId } = require('../ikas/taxonomy');
const { calculateFinalPriceTry } = require('../pricing');

const SET_CODE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9.+]{1,7})-(\d{1,4})$/;

function parseSetCodeQuery(query) {
  const match = String(query || '').trim().match(SET_CODE_PATTERN);
  if (!match) return null;

  return {
    setCode: match[1].toUpperCase(),
    cardNumber: match[2],
  };
}

function filterItemsByCardNumber(items, cardNumber, setCode) {
  const target = String(cardNumber);
  const targetNum = String(Number(target));
  const padded = target.padStart(3, '0');
  const normalizedSetCode = setCode ? String(setCode).trim().toUpperCase() : null;

  return items.filter((item) => {
    const name = String(item.name || '');
    const code = String(item.code || '');

    const hashMatch = name.match(/#(\d+)\b/);
    if (hashMatch && hashMatch[1] === target) {
      return true;
    }

    if (code === target || code === padded) {
      return true;
    }

    if (normalizedSetCode) {
      const setCodePattern = new RegExp(`${normalizedSetCode}-0*${targetNum}\\b`, 'i');
      if (setCodePattern.test(name) || setCodePattern.test(code)) {
        return true;
      }
    }

    const suffixMatch = name.match(/-0*(\d{1,4})\b/);
    if (suffixMatch && String(Number(suffixMatch[1])) === targetNum) {
      return true;
    }

    return false;
  });
}

async function searchBySetCode({
  setCode,
  cardNumber,
  page = 1,
  perPage = 20,
  game = 'pokemon',
} = {}) {
  const setEntry = await resolveSetForGame(setCode, game);

  if (!setEntry) {
    throw new Error(`"${setCode}" set kodu için kategori bulunamadı.`);
  }

  const result = await getCategoryItems(setEntry.categoryId, {
    search: cardNumber,
    page,
    perPage,
  });

  const items = filterItemsByCardNumber(
    result.items,
    cardNumber,
    setEntry.setCode || setCode,
  );
  const gameId = normalizeGameId(game);

  return {
    items,
    pagination: result.pagination,
    searchMode: setEntry.language === 'en' ? 'english-set-code' : 'japanese-set-code',
    setCode: setEntry.setCode || setCode,
    cardNumber,
    game: gameId,
    category: {
      id: setEntry.categoryId,
      name: setEntry.categoryName,
      setName: setEntry.setName,
      language: setEntry.language || 'ja',
    },
  };
}

async function searchCards({ q, page = 1, perPage = 20, categoryId, game, market } = {}) {
  const query = String(q || '').trim();
  if (query.length < 2) {
    throw new Error('Arama sorgusu en az 2 karakter olmalıdır.');
  }

  const setCodeQuery = parseSetCodeQuery(query);
  if (setCodeQuery) {
    return searchBySetCode({
      setCode: setCodeQuery.setCode,
      cardNumber: setCodeQuery.cardNumber,
      page,
      perPage,
      game: game || 'pokemon',
    });
  }

  const client = createKartfiyatClient();
  try {
    const response = await client.get('/items/search', {
      params: {
        q: query,
        page,
        per_page: perPage,
        category_id: categoryId,
        game,
        market,
      },
    });
    const payload = parseApiResponse(response);
    return {
      items: payload.data || [],
      pagination: payload.pagination || null,
      searchMode: 'text',
    };
  } catch (error) {
    console.error('KartFiyat kart araması başarısız:', error.message);
    throw error;
  }
}

async function getCardById(cardId) {
  if (cardId === undefined || cardId === null || cardId === '') {
    throw new Error('Kart ID zorunludur.');
  }

  const client = createKartfiyatClient();
  try {
    const response = await client.get(`/items/${cardId}`);
    return parseApiResponse(response).data;
  } catch (error) {
    console.error(`KartFiyat kart detayı alınamadı (id: ${cardId}):`, error.message);
    throw error;
  }
}

function parseUsdPrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const cleaned = String(value || '').replace(/[^0-9.,-]/g, '').replace(',', '.');
  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : null;
}

const PRICE_LABEL_PRIORITY = [
  'ungraded',
  'near mint',
  'lightly played',
  'moderately played',
  'heavily played',
];

const GRADED_LABEL_PATTERN = /^(PSA|BGS|CGC|SGC|Grade)\s+([\d.]+)$/i;
const GRADING_COMPANY_ORDER = ['PSA', 'BGS', 'CGC', 'SGC', 'Grade'];

function getPriceChartingCandidates(card) {
  if (!card?.prices?.length) return [];

  const prices = card.prices.filter((entry) => {
    const market = String(entry.market || card.market || '').toLowerCase();
    return market.includes('pricecharting');
  });

  return prices.length ? prices : card.prices;
}

function normalizePriceLabel(label) {
  const value = String(label || '').trim();
  if (!value || /^ungraded$/i.test(value)) return null;
  return value;
}

function buildKartfiyatSku(kartfiyatCardId, priceLabel = null) {
  const base = `KF-${kartfiyatCardId}`;
  const normalized = normalizePriceLabel(priceLabel);
  if (!normalized) return base;
  return `${base}-${normalized.replace(/\s+/g, '').toUpperCase()}`;
}

function isGradedPriceLabel(label) {
  return GRADED_LABEL_PATTERN.test(String(label || '').trim());
}

function parseGradedLabel(label) {
  const match = String(label || '').trim().match(GRADED_LABEL_PATTERN);
  if (!match) return null;

  return {
    company: match[1].toUpperCase() === 'GRADE' ? 'Grade' : match[1].toUpperCase(),
    grade: match[2],
    numericGrade: Number(match[2]),
  };
}

function sortGradedEntries(a, b) {
  const gradeA = parseGradedLabel(a.label);
  const gradeB = parseGradedLabel(b.label);
  if (!gradeA || !gradeB) return 0;

  const companyDiff = GRADING_COMPANY_ORDER.indexOf(gradeA.company)
    - GRADING_COMPANY_ORDER.indexOf(gradeB.company);
  if (companyDiff !== 0) return companyDiff;

  return gradeB.numericGrade - gradeA.numericGrade;
}

function buildPriceEntry(entry) {
  const usd = parseUsdPrice(entry.price);
  if (usd === null) return null;

  const label = String(entry.label || '').trim();
  const graded = parseGradedLabel(label);

  return {
    label,
    usd,
    formattedUsd: `$${usd.toFixed(2)}`,
    isGraded: Boolean(graded),
    company: graded?.company || null,
    grade: graded?.grade || null,
    updatedAt: entry.updated_at || null,
  };
}

function getPriceChartingEntries(card) {
  return getPriceChartingCandidates(card)
    .map(buildPriceEntry)
    .filter(Boolean);
}

function getPriceChartingEntry(card, { label } = {}) {
  const normalizedLabel = normalizePriceLabel(label);
  const candidates = getPriceChartingCandidates(card);

  if (normalizedLabel) {
    const exact = candidates.find(
      (entry) => String(entry.label || '').trim().toLowerCase() === normalizedLabel.toLowerCase(),
    );
    if (exact && parseUsdPrice(exact.price) !== null) return exact;
    return null;
  }

  for (const preferredLabel of PRICE_LABEL_PRIORITY) {
    const match = candidates.find(
      (entry) => String(entry.label || '').toLowerCase() === preferredLabel,
    );
    if (match && parseUsdPrice(match.price) !== null) {
      return match;
    }
  }

  return candidates.find((entry) => parseUsdPrice(entry.price) !== null) || null;
}

function getPriceChartingUsd(card, options = {}) {
  const entry = getPriceChartingEntry(card, options);
  return entry ? parseUsdPrice(entry.price) : null;
}

function getGradedPrices(card) {
  return getPriceChartingEntries(card)
    .filter((entry) => entry.isGraded)
    .sort(sortGradedEntries);
}

function getCardPriceInfo(card, options = {}) {
  const entry = getPriceChartingEntry(card, options);
  if (!entry) return null;

  const usd = parseUsdPrice(entry.price);
  if (usd === null) return null;

  const label = String(entry.label || '').trim();
  const graded = parseGradedLabel(label);

  return {
    label,
    usd,
    formatted: `$${usd.toFixed(2)}`,
    formattedUsd: `$${usd.toFixed(2)}`,
    isGraded: Boolean(graded),
    company: graded?.company || null,
    grade: graded?.grade || null,
  };
}

function buildTryPrice(usd, usdTryRate, multiplier = 1.86) {
  return calculateFinalPriceTry(usd, usdTryRate, multiplier);
}

function enrichPriceWithTry(entry, usdTryRate, multiplier = 1.86) {
  if (!entry) return null;

  const tryPrice = buildTryPrice(entry.usd, usdTryRate, multiplier);
  return {
    ...entry,
    try: tryPrice,
    formattedTry: `${tryPrice.toLocaleString('tr-TR')} ₺`,
  };
}

function getCardPricesPayload(card, { usdTryRate, multiplier = 1.86 } = {}) {
  const ungradedEntry = getCardPriceInfo(card);
  const graded = getGradedPrices(card).map((entry) => enrichPriceWithTry(entry, usdTryRate, multiplier));

  return {
    ungraded: enrichPriceWithTry(ungradedEntry, usdTryRate, multiplier),
    graded,
    gradedCount: graded.length,
    usdTryRate,
    multiplier,
  };
}

function getCardImageUrl(card) {
  if (!Array.isArray(card?.images) || card.images.length === 0) {
    return null;
  }

  const sorted = [...card.images].sort((a, b) => (a.order || 0) - (b.order || 0));
  return sorted[0]?.url || null;
}

module.exports = {
  searchCards,
  searchBySetCode,
  searchJapaneseBySetCode: searchBySetCode,
  parseSetCodeQuery,
  getCardById,
  parseUsdPrice,
  normalizePriceLabel,
  buildKartfiyatSku,
  isGradedPriceLabel,
  getPriceChartingUsd,
  getPriceChartingEntry,
  getPriceChartingEntries,
  getGradedPrices,
  getCardPriceInfo,
  getCardPricesPayload,
  getCardImageUrl,
};
