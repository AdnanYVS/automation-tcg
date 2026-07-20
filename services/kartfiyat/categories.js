const { createKartfiyatClient, parseApiResponse } = require('./client');

async function listCategories({ game = 'pokemon' } = {}) {
  const client = createKartfiyatClient();

  try {
    const response = await client.get('/categories', { params: { game } });
    return parseApiResponse(response).data || [];
  } catch (error) {
    console.error('KartFiyat kategori listesi alınamadı:', error.message);
    throw error;
  }
}

async function getCategoryItems(categoryId, { search, page = 1, perPage = 20 } = {}) {
  const client = createKartfiyatClient();

  try {
    const response = await client.get(`/categories/${categoryId}/items`, {
      params: {
        search,
        page,
        per_page: perPage,
        sort_by: 'name',
        sort_order: 'asc',
      },
    });

    const payload = parseApiResponse(response);

    return {
      items: payload.data || [],
      pagination: payload.pagination || null,
      category: payload.category || null,
    };
  } catch (error) {
    console.error(`KartFiyat kategori ürünleri alınamadı (id: ${categoryId}):`, error.message);
    throw error;
  }
}

module.exports = {
  listCategories,
  getCategoryItems,
};
