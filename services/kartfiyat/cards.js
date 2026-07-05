const { createKartfiyatClient, parseApiResponse } = require('./client');
const { getCategoryItems } = require('./categories');
const { resolveJapaneseSet, getSetCodeRegistry } = require('./setRegistry');

const SET_CODE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9.+]{1,7})-(\d{1,4})$/;

function parseSetCodeQuery(query) {
  const match = String(query || '').trim().match(SET_CODE_PATTERN);
  if (!match) return null;

  return {
    setCode: match[1].toUpperCase(),
    cardNumber: match[2],
  };
}

function filterItemsByCardNumber(items, cardNumber) {
  const target = String(cardNumber);

  return items.filter((item) => {
    const hashMatch = String(item.name || '').match(/#(\d+)\b/);
    if (hashMatch) {
      return hashMatch[1] === target;
    }

    return String(item.code || '') === target;
  });
}

async function searchJapaneseBySetCode({
  setCode,
  cardNumber,
  page = 1,
  perPage = 20,
}) {
  const setEntry = await resolveJapaneseSet(setCode);

  if (!setEntry) {
    throw new Error(`"${setCode}" set kodu için Japonca kategori bulunamadı.`);
  }

  const result = await getCategoryItems(setEntry.categoryId, {
    search: cardNumber,
    page,
    perPage,
  });

  const items = filterItemsByCardNumber(result.items, cardNumber);

  return {
    items,
    pagination: result.pagination,
    searchMode: 'japanese-set-code',
    setCode,
    cardNumber,
    category: {
      id: setEntry.categoryId,
      name: setEntry.categoryName,
      setName: setEntry.setName,
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
    return searchJapaneseBySetCode({
      setCode: setCodeQuery.setCode,
      cardNumber: setCodeQuery.cardNumber,
      page,
      perPage,
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

function getPriceChartingEntry(card) {
  if (!card?.prices?.length) return null;

  const prices = card.prices.filter((entry) => {
    const market = String(entry.market || card.market || '').toLowerCase();
    return market.includes('pricecharting');
  });

  const candidates = prices.length ? prices : card.prices;

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

function getPriceChartingUsd(card) {
  const entry = getPriceChartingEntry(card);
  return entry ? parseUsdPrice(entry.price) : null;
}

function getCardPriceInfo(card) {
  const entry = getPriceChartingEntry(card);
  if (!entry) return null;

  const usd = parseUsdPrice(entry.price);
  if (usd === null) return null;

  return {
    label: entry.label,
    usd,
    formatted: `$${usd.toFixed(2)}`,
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
  searchJapaneseBySetCode,
  parseSetCodeQuery,
  getCardById,
  parseUsdPrice,
  getPriceChartingUsd,
  getCardPriceInfo,
  getCardImageUrl,
};
