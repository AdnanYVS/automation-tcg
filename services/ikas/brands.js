const { graphqlRequest } = require('./client');
const { getStorefrontSalesChannelId } = require('./salesChannel');

const LIST_BRANDS_QUERY = `
  query ListProductBrand {
    listProductBrand {
      id
      name
      deleted
      salesChannelIds
    }
  }
`;

const CREATE_BRAND_MUTATION = `
  mutation CreateProductBrand($input: CreateProductBrandInput!) {
    createProductBrand(input: $input) {
      id
      name
      salesChannelIds
    }
  }
`;

const UPDATE_BRAND_MUTATION = `
  mutation UpdateProductBrand($input: UpdateProductBrandInput!) {
    updateProductBrand(input: $input) {
      id
      name
      salesChannelIds
    }
  }
`;

const DEFAULT_BRAND_NAME = 'Pokemon';

let cachedBrands = null;

function normalizeBrandName(name) {
  return String(name || '').trim().toLowerCase();
}

function invalidateBrandCache() {
  cachedBrands = null;
}

async function listBrands({ refresh = false } = {}) {
  if (!refresh && cachedBrands) {
    return cachedBrands;
  }

  const data = await graphqlRequest(LIST_BRANDS_QUERY);
  cachedBrands = data.listProductBrand || [];
  return cachedBrands;
}

function findBrandByName(brands, name) {
  const target = normalizeBrandName(name);
  return brands.find((brand) => normalizeBrandName(brand.name) === target) || null;
}

async function updateBrand({ id, name, salesChannelIds }) {
  const input = { id };
  if (name) input.name = name;
  if (salesChannelIds) input.salesChannelIds = salesChannelIds;

  const data = await graphqlRequest(UPDATE_BRAND_MUTATION, { input });
  invalidateBrandCache();
  return data.updateProductBrand;
}

async function ensureBrandOnStorefront(brand, { salesChannelId } = {}) {
  const channelId = salesChannelId || await getStorefrontSalesChannelId();
  const channels = brand.salesChannelIds || [];

  if (channels.includes(channelId)) {
    return { brand, updated: false };
  }

  const updated = await updateBrand({
    id: brand.id,
    salesChannelIds: [...new Set([...channels, channelId])],
  });
  console.log(`[ikas] Marka mağazada görünür yapıldı: ${updated.name}`);
  return { brand: updated, updated: true };
}

async function createBrand({ name, salesChannelId = null }) {
  const channelId = salesChannelId || await getStorefrontSalesChannelId();
  const data = await graphqlRequest(CREATE_BRAND_MUTATION, {
    input: {
      name: String(name).trim(),
      salesChannelIds: [channelId],
    },
  });

  const brand = data.createProductBrand;
  if (!brand?.id) {
    throw new Error(`ikas markası oluşturulamadı: ${name}`);
  }

  invalidateBrandCache();
  console.log(`[ikas] Yeni marka oluşturuldu: ${brand.name} (${brand.id})`);
  return brand;
}

async function ensureBrandExists({ name = DEFAULT_BRAND_NAME, allowCreate = true } = {}) {
  const brands = await listBrands();
  const existing = findBrandByName(brands, name);
  if (existing) {
    await ensureBrandOnStorefront(existing);
    return { brand: existing, created: false };
  }

  if (!allowCreate) {
    return { brand: null, created: false };
  }

  try {
    const brand = await createBrand({ name });
    return { brand, created: true };
  } catch (error) {
    const refreshed = await listBrands({ refresh: true });
    const fallback = findBrandByName(refreshed, name);
    if (fallback) {
      await ensureBrandOnStorefront(fallback);
      return { brand: fallback, created: false };
    }
    throw error;
  }
}

async function syncPokemonBrand() {
  const { brand, created } = await ensureBrandExists({ name: DEFAULT_BRAND_NAME, allowCreate: true });
  return {
    brandId: brand.id,
    brandName: brand.name,
    created,
    salesChannelIds: brand.salesChannelIds || [],
  };
}

module.exports = {
  DEFAULT_BRAND_NAME,
  listBrands,
  findBrandByName,
  createBrand,
  updateBrand,
  ensureBrandOnStorefront,
  ensureBrandExists,
  syncPokemonBrand,
  invalidateBrandCache,
};
