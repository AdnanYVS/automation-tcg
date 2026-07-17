const { graphqlRequest } = require('./client');
const { uploadProductImage } = require('./images');
const { enableProductForSale } = require('./salesChannel');

const CREATE_PRODUCT_MUTATION = `
  mutation CreateProduct($input: CreateProductInput!) {
    createProduct(input: $input) {
      id
      name
      type
      variants {
        id
        sku
        barcodeList
        isActive
        prices { sellPrice currency }
        variantValues { variantTypeName variantValueName }
      }
    }
  }
`;

const ADD_VARIANT_MUTATION = `
  mutation AddVariantToProduct($input: AddVariantToProductInput!) {
    addVariantToProduct(input: $input)
  }
`;

const UPDATE_VARIANT_PRICES_MUTATION = `
  mutation UpdateVariantPrices($input: UpdateVariantPricesInput!) {
    updateVariantPrices(input: $input) {
      errors {
        errorCode
      }
    }
  }
`;

const SAVE_VARIANT_STOCKS_MUTATION = `
  mutation SaveVariantStocks($input: SaveVariantStocksInput!) {
    saveVariantStocks(input: $input) {
      errors {
        errorCode
      }
    }
  }
`;

const LIST_STOCK_LOCATIONS_QUERY = `
  query ListStockLocation {
    listStockLocation {
      id
      name
    }
  }
`;

const LIST_PRODUCT_STOCK_LOCATION_QUERY = `
  query ListProductStockLocation {
    listProductStockLocation {
      productId
      variantId
      stockCount
      stockLocationId
    }
  }
`;

const LIST_PRODUCTS_QUERY = `
  query ListProduct($pagination: PaginationInput) {
    listProduct(pagination: $pagination) {
      count
      data {
        id
        name
        brand {
          id
          name
        }
        categories {
          id
          name
        }
        variants {
          id
          sku
          barcodeList
          isActive
        }
      }
    }
  }
`;

const GET_PRODUCT_QUERY = `
  query GetProduct($id: StringFilterInput!) {
    listProduct(id: $id) {
      data {
        id
        name
        variants {
          id
          sku
          barcodeList
          isActive
        }
      }
    }
  }
`;

const LIST_PRODUCT_BY_SKU_QUERY = `
  query ListProductBySku($sku: StringFilterInput!, $includeDeleted: Boolean) {
    listProduct(sku: $sku, includeDeleted: $includeDeleted) {
      data {
        id
        name
        variants {
          id
          sku
          barcodeList
          isActive
        }
      }
    }
  }
`;

const LIST_PRODUCT_BY_BARCODE_QUERY = `
  query ListProductByBarcode($barcodeList: StringFilterInput!, $includeDeleted: Boolean) {
    listProduct(barcodeList: $barcodeList, includeDeleted: $includeDeleted) {
      data {
        id
        name
        variants {
          id
          sku
          barcodeList
          isActive
        }
      }
    }
  }
`;

const UPDATE_PRODUCT_MUTATION = `
  mutation UpdateProduct($input: UpdateProductInput!) {
    updateProduct(input: $input) {
      id
      name
      brand {
        id
        name
      }
      categories {
        id
        name
      }
    }
  }
`;

let cachedStockLocations = null;
let cachedProductCatalog = null;
let cachedProductCatalogAt = 0;
const PRODUCT_CATALOG_CACHE_MS = Number(process.env.IKAS_PRODUCT_CATALOG_CACHE_MS || 120000);

async function listStockLocations() {
  if (cachedStockLocations) {
    return cachedStockLocations;
  }

  const data = await graphqlRequest(LIST_STOCK_LOCATIONS_QUERY);
  cachedStockLocations = data.listStockLocation || [];

  if (!cachedStockLocations.length) {
    throw new Error('ikas stok lokasyonu bulunamadı.');
  }

  return cachedStockLocations;
}

async function getDefaultStockLocationId() {
  if (process.env.IKAS_STOCK_LOCATION_ID) {
    return process.env.IKAS_STOCK_LOCATION_ID;
  }

  const locations = await listStockLocations();
  return locations[0].id;
}

async function getProductById(productId) {
  if (!productId) return null;

  try {
    const data = await graphqlRequest(GET_PRODUCT_QUERY, { id: { eq: String(productId) } });
    return data.listProduct?.data?.[0] || null;
  } catch (error) {
    // Bazı ikas tenantlarında id filtresi farklı olabilir; fallback listeleme.
    console.warn(`[ikas] getProductById filtre başarısız (${productId}):`, error.message);
  }

  const products = await listAllProducts();
  return products.find((product) => product.id === productId) || null;
}

async function listProductsBySku(sku) {
  const target = String(sku || '').trim();
  if (!target) return [];

  try {
    const data = await graphqlRequest(LIST_PRODUCT_BY_SKU_QUERY, {
      sku: { eq: target },
      includeDeleted: false,
    });
    const active = data.listProduct?.data || [];
    if (active.length) return active;

    const deleted = await graphqlRequest(LIST_PRODUCT_BY_SKU_QUERY, {
      sku: { eq: target },
      includeDeleted: true,
    });
    return deleted.listProduct?.data || [];
  } catch (error) {
    console.warn(`[ikas] SKU ile ürün arama başarısız (${target}):`, error.message);
    return [];
  }
}

async function listProductsByBarcode(barcode) {
  const target = String(barcode || '').trim();
  if (!target) return [];

  async function query(filter, includeDeleted) {
    const data = await graphqlRequest(LIST_PRODUCT_BY_BARCODE_QUERY, {
      barcodeList: filter,
      includeDeleted,
    });
    return data.listProduct?.data || [];
  }

  try {
    // Bazı tenantlarda array alan için eq, bazılarında in çalışır
    for (const filter of [{ eq: target }, { in: [target] }]) {
      const active = await query(filter, false);
      if (active.length) return active;
      const withDeleted = await query(filter, true);
      if (withDeleted.length) return withDeleted;
    }
    return [];
  } catch (error) {
    console.warn(`[ikas] Barkod ile ürün arama başarısız (${target}):`, error.message);
    return [];
  }
}

function findExactVariantBySku(product, sku) {
  const target = String(sku || '').trim();
  if (!target || !product) return null;
  return (product.variants || []).find(
    (entry) => String(entry.sku || '').trim() === target,
  ) || null;
}

function findExactVariantByBarcode(product, barcode) {
  const target = String(barcode || '').trim();
  if (!target || !product) return null;
  return (product.variants || []).find((entry) =>
    (entry.barcodeList || []).some((code) => String(code || '').trim() === target),
  ) || null;
}

/**
 * Önce exact SKU, sonra exact barkod.
 * Barkod eşleşmesi SKU tahmininden bağımsızdır (ikas SKU'su KF-{id} olmayabilir).
 * Graded SKU asla base SKU'ya düşmez.
 */
async function findProductBySkuOrBarcode({ sku = null, barcode = null, products = null } = {}) {
  const targetSku = String(sku || '').trim();
  const targetBarcode = String(barcode || '').trim();

  if (targetSku) {
    const matches = await listProductsBySku(targetSku);
    for (const product of matches) {
      const variant = findExactVariantBySku(product, targetSku);
      if (variant?.id) {
        return { product, variant };
      }
    }
  }

  if (targetBarcode) {
    const matches = await listProductsByBarcode(targetBarcode);
    for (const product of matches) {
      const variant = findExactVariantByBarcode(product, targetBarcode);
      if (variant?.id) {
        if (targetSku && String(variant.sku || '').trim() !== targetSku) {
          console.warn(
            `[ikas] Barkod eşleşti ama SKU farklı: barcode=${targetBarcode}`
            + ` beklenen=${targetSku} gerçek=${variant.sku || '?'}`
            + ` → barkod güvenilir kabul edildi`,
          );
        }
        return { product, variant };
      }
    }
  }

  const catalog = products?.length ? products : null;
  if (catalog) {
    if (targetSku) {
      const foundBySku = findProductBySkuInCatalog(catalog, targetSku);
      if (foundBySku) return foundBySku;
    }
    if (targetBarcode) {
      const foundByBarcode = findProductByBarcodeInCatalog(catalog, targetBarcode);
      if (foundByBarcode) {
        if (targetSku && String(foundByBarcode.variant.sku || '').trim() !== targetSku) {
          console.warn(
            `[ikas] Katalog barkod eşleşti, SKU farklı: barcode=${targetBarcode}`
            + ` beklenen=${targetSku} gerçek=${foundByBarcode.variant.sku || '?'}`,
          );
        }
        return foundByBarcode;
      }
    }
  }

  // Son çare: tam katalog
  if (targetSku || targetBarcode) {
    try {
      const fullCatalog = await getCachedProductCatalog();
      if (targetSku) {
        const foundBySku = findProductBySkuInCatalog(fullCatalog, targetSku);
        if (foundBySku) return foundBySku;
      }
      if (targetBarcode) {
        const foundByBarcode = findProductByBarcodeInCatalog(fullCatalog, targetBarcode);
        if (foundByBarcode) return foundByBarcode;
      }
    } catch (error) {
      console.warn('[ikas] Katalog taraması başarısız:', error.message);
    }
  }

  return null;
}

function pickLiveVariant(product, { preferredVariantId = null, sku = null } = {}) {
  const variants = product?.variants || [];
  if (!variants.length) return null;

  if (preferredVariantId) {
    const preferred = variants.find((variant) => variant.id === preferredVariantId);
    if (preferred) return preferred;
  }

  if (sku) {
    const bySku = variants.find((variant) => String(variant.sku || '') === String(sku));
    if (bySku) return bySku;
  }

  return variants[0];
}

async function resolveLiveVariant({ productId, variantId = null, sku = null }) {
  const product = await getProductById(productId);
  if (!product?.id) {
    throw new Error(`ikas ürünü bulunamadı: ${productId}`);
  }

  const variant = pickLiveVariant(product, {
    preferredVariantId: variantId,
    sku,
  });

  if (!variant?.id) {
    throw new Error(`ikas ürününde aktif varyant bulunamadı: ${productId}`);
  }

  return {
    product,
    variant,
    variantChanged: Boolean(variantId && variant.id !== variantId),
  };
}

function findProductBySkuInCatalog(products, sku) {
  const target = String(sku || '').trim();
  if (!target || !products?.length) return null;

  for (const product of products) {
    const variant = (product.variants || []).find(
      (entry) => String(entry.sku || '').trim() === target,
    );
    if (variant?.id) {
      return { product, variant };
    }
  }

  return null;
}

function findProductByBarcodeInCatalog(products, barcode) {
  const target = String(barcode || '').trim();
  if (!target || !products?.length) return null;

  for (const product of products) {
    for (const variant of product.variants || []) {
      const barcodes = variant.barcodeList || [];
      if (barcodes.some((entry) => String(entry || '').trim() === target)) {
        return { product, variant };
      }
    }
  }

  return null;
}

/**
 * Geçersiz/silinmiş productId durumunda SKU veya barkod ile canlı ürün+varyant bulur.
 * Kategori ağacı değişikliği ürün ID'sini değiştirmez; asıl sorun genelde eski mapping ID'leridir.
 */
async function resolveLiveProductVariant({
  productId,
  variantId = null,
  sku = null,
  skuCandidates = [],
  barcode = null,
  products = null,
} = {}) {
  const candidateSkus = [...new Set(
    [sku, ...(Array.isArray(skuCandidates) ? skuCandidates : [])]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )];

  let product = null;
  if (productId) {
    product = await getProductById(productId);
  }

  let productChanged = false;

  if (!product?.id) {
    let found = null;
    for (const candidate of candidateSkus) {
      found = await findProductBySkuOrBarcode({ sku: candidate, barcode, products });
      if (found?.product?.id) break;
    }
    // SKU adayları tutmazsa yalnızca barkod dene (SKU KF-{id} olmayabilir)
    if (!found?.product?.id && barcode) {
      found = await findProductBySkuOrBarcode({ barcode, products });
    }

    if (!found?.product?.id) {
      throw new Error(
        `ikas ürünü bulunamadı: ${productId || '?'}`
        + (candidateSkus.length ? ` (sku: ${candidateSkus.join(' | ')})` : '')
        + (barcode ? ` (barcode: ${barcode})` : ''),
      );
    }

    product = found.product;
    productChanged = Boolean(productId && product.id !== productId);

    const variant = found.variant;

    if (!variant?.id) {
      throw new Error(`ikas ürününde aktif varyant bulunamadı: ${product.id}`);
    }

    return {
      product,
      variant,
      productChanged,
      variantChanged: Boolean(variantId && variant.id !== variantId) || productChanged,
    };
  }

  // Ürün ID geçerliyse: önce preferred variant, sonra exact SKU adayları
  let variant = null;
  if (variantId) {
    variant = (product.variants || []).find((entry) => entry.id === variantId) || null;
  }
  if (!variant) {
    for (const candidate of candidateSkus) {
      variant = findExactVariantBySku(product, candidate);
      if (variant) break;
    }
  }
  if (!variant && barcode) {
    variant = findExactVariantByBarcode(product, barcode);
  }
  if (!variant && !candidateSkus.length && !barcode) {
    variant = pickLiveVariant(product, { preferredVariantId: variantId });
  }

  // ID/variant uyuşmazlığında exact SKU/barkod ile yeniden çöz
  if (!variant?.id && (candidateSkus.length || barcode)) {
    let found = null;
    for (const candidate of candidateSkus) {
      found = await findProductBySkuOrBarcode({ sku: candidate, barcode, products });
      if (found?.product?.id) break;
    }
    if (!found?.product?.id && barcode) {
      found = await findProductBySkuOrBarcode({ barcode, products });
    }
    if (found?.product?.id && found?.variant?.id) {
      return {
        product: found.product,
        variant: found.variant,
        productChanged: found.product.id !== productId,
        variantChanged: true,
      };
    }
  }

  if (!variant?.id) {
    throw new Error(
      `ikas ürününde aktif varyant bulunamadı: ${product.id}`
      + (candidateSkus.length ? ` (sku: ${candidateSkus.join(' | ')})` : ''),
    );
  }

  return {
    product,
    variant,
    productChanged: false,
    variantChanged: Boolean(variantId && variant.id !== variantId),
  };
}

async function applyVariantPriceBatch(variantUpdates, { priceListId = null } = {}) {
  const variantPriceInputs = variantUpdates.map(({ productId, variantId, sellPrice }) => ({
    deleted: false,
    productId,
    variantId,
    price: { sellPrice: Number(sellPrice) },
  }));

  const data = await graphqlRequest(UPDATE_VARIANT_PRICES_MUTATION, {
    input: { priceListId, variantPriceInputs },
  });

  const result = data.updateVariantPrices;
  const errorCodes = (result?.errors || []).map((entry) => entry.errorCode).filter(Boolean);

  if (errorCodes.length) {
    const error = new Error(`ikas fiyat güncellenemedi (${errorCodes.join(', ')}).`);
    error.errorCodes = errorCodes;
    throw error;
  }

  return result;
}

async function updateVariantPrices(variantUpdates, {
  priceListId = null,
  products = null,
} = {}) {
  if (!variantUpdates?.length) {
    return { isSuccess: true, idChanges: [] };
  }

  try {
    const result = await applyVariantPriceBatch(variantUpdates, { priceListId });
    return { ...result, idChanges: [] };
  } catch (error) {
    const isRecoverable = /INVALID_PRODUCT_ID|INVALID_VARIANT_ID/i.test(error.message)
      || (error.errorCodes || []).some((code) => /INVALID_PRODUCT_ID|INVALID_VARIANT_ID/i.test(code));

    if (!isRecoverable) {
      throw error;
    }

    console.warn(
      `[ikas] Fiyat güncellemede geçersiz ürün/varyant (${error.message}), canlı ID'ler çözülecek (${variantUpdates.length} kayıt)`,
    );

    // SKU/barkod API ile çöz; tam katalog findProductBySkuOrBarcode içinde son çare olarak yüklenir.
    const resolvedUpdates = [];
    const idChanges = [];
    const failures = [];

    for (const update of variantUpdates) {
      try {
        const live = await resolveLiveProductVariant({
          productId: update.productId,
          variantId: update.variantId,
          sku: update.sku,
          skuCandidates: update.skuCandidates,
          barcode: update.barcode,
          products,
        });

        if (live.productChanged || live.variantChanged) {
          idChanges.push({
            mappingId: update.mappingId || null,
            fromProductId: update.productId,
            fromVariantId: update.variantId,
            productId: live.product.id,
            variantId: live.variant.id,
            sku: live.variant.sku || update.sku || null,
          });
          console.warn(
            `[ikas] Mapping ID düzeltildi: ${update.productId}/${update.variantId}`
            + ` → ${live.product.id}/${live.variant.id}`
            + (update.sku ? ` (sku: ${update.sku})` : ''),
          );
        }

        resolvedUpdates.push({
          productId: live.product.id,
          variantId: live.variant.id,
          sellPrice: update.sellPrice,
        });
      } catch (resolveError) {
        failures.push({
          productId: update.productId,
          variantId: update.variantId,
          sku: update.sku,
          reason: resolveError.message,
        });
      }
    }

    if (!resolvedUpdates.length) {
      const detail = failures.map((entry) => entry.reason).join('; ');
      throw new Error(`ikas fiyat güncellenemedi (INVALID_PRODUCT_ID). ${detail}`);
    }

    const result = await applyVariantPriceBatch(resolvedUpdates, { priceListId });

    if (failures.length) {
      console.warn(`[ikas] ${failures.length} fiyat kaydı çözülemedi:`, failures.slice(0, 10));
    }

    return {
      ...result,
      idChanges,
      failures,
      updated: resolvedUpdates.length,
    };
  }
}


async function saveVariantStock({ productId, variantId, stockCount, stockLocationId, sku = null }) {
  if (stockCount === undefined || stockCount === null) {
    return null;
  }

  const locationId = stockLocationId || await getDefaultStockLocationId();

  async function attempt(targetVariantId) {
    const data = await graphqlRequest(SAVE_VARIANT_STOCKS_MUTATION, {
      input: {
        stockInputs: [{
          deleted: false,
          productId,
          variantId: targetVariantId,
          stockLocationId: locationId,
          stockCount: Number(stockCount),
        }],
      },
    });

    const result = data.saveVariantStocks;
    if (result?.errors?.length) {
      const errors = result.errors
        .map((entry) => entry.errorCode || JSON.stringify(entry))
        .join(', ');
      const error = new Error(`ikas stok güncellenemedi (${errors}).`);
      error.errorCodes = result.errors.map((entry) => entry.errorCode).filter(Boolean);
      throw error;
    }

    return { result, variantId: targetVariantId };
  }

  try {
    return await attempt(variantId);
  } catch (error) {
    const isInvalidVariant = /INVALID_VARIANT_ID/i.test(error.message)
      || (error.errorCodes || []).includes('INVALID_VARIANT_ID');

    if (!isInvalidVariant) {
      throw error;
    }

    console.warn(
      `[ikas] Geçersiz variantId (${variantId}), ürün yeniden okunuyor: ${productId}`,
    );

    const live = await resolveLiveVariant({ productId, variantId, sku });
    if (live.variant.id === variantId) {
      throw error;
    }

    const retry = await attempt(live.variant.id);
    return {
      ...retry,
      resolvedVariantId: live.variant.id,
      variantChanged: true,
    };
  }
}

async function listAllVariantStocks() {
  const data = await graphqlRequest(LIST_PRODUCT_STOCK_LOCATION_QUERY);
  return data.listProductStockLocation || [];
}

async function getVariantStockAtLocation({ productId, variantId, stockLocationId }) {
  const rows = await listAllVariantStocks();
  const match = rows.find(
    (row) => row.productId === productId
      && row.variantId === variantId
      && row.stockLocationId === stockLocationId,
  );

  return Number(match?.stockCount || 0);
}

async function incrementVariantStock({
  productId,
  variantId,
  stockLocationId,
  incrementBy = 1,
  sku = null,
}) {
  const increment = Number(incrementBy);
  if (!Number.isFinite(increment) || increment <= 0) {
    throw new Error('incrementBy pozitif bir sayı olmalıdır.');
  }

  const live = await resolveLiveVariant({ productId, variantId, sku });
  const effectiveVariantId = live.variant.id;

  const previousStock = await getVariantStockAtLocation({
    productId,
    variantId: effectiveVariantId,
    stockLocationId,
  });
  const newStock = previousStock + increment;

  const stockResult = await saveVariantStock({
    productId,
    variantId: effectiveVariantId,
    stockLocationId,
    stockCount: newStock,
    sku: sku || live.variant.sku,
  });

  return {
    previousStock,
    newStock,
    incrementBy: increment,
    variantId: stockResult.variantId || effectiveVariantId,
    variantChanged: live.variantChanged || Boolean(stockResult.variantChanged),
  };
}

function buildVariantInput({ sku, sellPrice, currency = 'TRY', isActive = true, variantValues = [], barcodeList = [] }) {
  const variant = { sku, isActive, prices: [{ sellPrice, currency }] };
  if (variantValues.length > 0) variant.variantValues = variantValues;
  if (barcodeList.length > 0) variant.barcodeList = barcodeList;
  return variant;
}

async function listAllProducts({ pageSize = 200 } = {}) {
  let page = 1;
  const products = [];
  let totalCount = null;

  while (true) {
    const data = await graphqlRequest(LIST_PRODUCTS_QUERY, {
      pagination: { page, limit: pageSize },
    });
    const items = data.listProduct?.data || [];
    if (totalCount == null && Number.isFinite(data.listProduct?.count)) {
      totalCount = data.listProduct.count;
    }
    if (!items.length) break;

    products.push(...items);
    if (items.length < pageSize) break;
    if (totalCount != null && products.length >= totalCount) break;
    page += 1;
  }

  cachedProductCatalog = products;
  cachedProductCatalogAt = Date.now();
  return products;
}

async function getCachedProductCatalog() {
  if (
    cachedProductCatalog
    && (Date.now() - cachedProductCatalogAt) < PRODUCT_CATALOG_CACHE_MS
  ) {
    return cachedProductCatalog;
  }
  return listAllProducts();
}

async function updateProductCategories({ productId, categoryName, categoryPath = [], categories = null }) {
  const categoryInputs = categories?.length
    ? categories
    : [{ name: categoryName, ...(categoryPath.length > 0 ? { path: categoryPath } : {}) }];

  const data = await graphqlRequest(UPDATE_PRODUCT_MUTATION, {
    input: {
      id: productId,
      categories: categoryInputs,
    },
  });

  return data.updateProduct;
}

async function updateProductBrand({ productId, brandName }) {
  const data = await graphqlRequest(UPDATE_PRODUCT_MUTATION, {
    input: {
      id: productId,
      brand: { name: brandName },
    },
  });

  return data.updateProduct;
}

async function updateProductTaxonomy({
  productId,
  brandName,
  categoryName,
  categoryPath = [],
  categories = null,
}) {
  const input = { id: productId };

  if (brandName) {
    input.brand = { name: brandName };
  }

  if (categories?.length) {
    input.categories = categories;
  } else if (categoryName) {
    const categoryInput = { name: categoryName };
    if (categoryPath.length > 0) {
      categoryInput.path = categoryPath;
    }
    input.categories = [categoryInput];
  }

  const data = await graphqlRequest(UPDATE_PRODUCT_MUTATION, { input });
  return data.updateProduct;
}

async function createBasicProduct({
  name,
  sku,
  sellPrice,
  currency = 'TRY',
  isActive = true,
  stockCount,
  stockLocationId,
  type = 'PHYSICAL',
  imageUrl,
  categoryName,
  categoryPath,
  categories = null,
  brandName,
  barcode,
}) {
  const input = {
    name,
    type,
    variants: [buildVariantInput({
      sku,
      sellPrice,
      currency,
      isActive,
      barcodeList: barcode ? [barcode] : [],
    })],
  };

  if (brandName) {
    input.brand = { name: brandName };
  }

  if (categories?.length) {
    input.categories = categories;
  } else if (categoryName) {
    const categoryInput = { name: categoryName };
    if (categoryPath?.length) {
      categoryInput.path = categoryPath;
    }
    input.categories = [categoryInput];
  }

  const data = await graphqlRequest(CREATE_PRODUCT_MUTATION, {
    input,
  });

  const product = data.createProduct;
  let variant = product.variants?.[0];

  if (product?.id) {
    try {
      const live = await resolveLiveVariant({
        productId: product.id,
        variantId: variant?.id || null,
        sku,
      });
      variant = live.variant;
      product.variants = live.product.variants || product.variants;
    } catch (error) {
      console.warn('[ikas] Ürün oluşturulduktan sonra varyant yenilenemedi:', error.message);
    }
  }

  if (product?.id && variant?.id) {
    try {
      await enableProductForSale(product.id);
    } catch (error) {
      console.error('ikas satış kanalı güncelleme başarısız:', error.message);
      throw error;
    }

    if (stockCount !== undefined && stockCount !== null) {
      await saveVariantStock({
        productId: product.id,
        variantId: variant.id,
        stockCount,
        stockLocationId,
        sku,
      });
    }

    if (imageUrl) {
      try {
        await uploadProductImage({
          variantIds: [variant.id],
          imageUrl,
          order: 1,
          isMain: true,
        });
      } catch (error) {
        console.error('ikas görsel yükleme başarısız:', error.message);
        throw error;
      }
    }
  }

  return product;
}

async function createProductWithVariants({ name, variants, type = 'PHYSICAL' }) {
  const data = await graphqlRequest(CREATE_PRODUCT_MUTATION, {
    input: { name, type, variants: variants.map((variant) => buildVariantInput(variant)) },
  });
  return data.createProduct;
}

async function addVariantToProduct({ productId, sku, sellPrice, currency = 'TRY', isActive = true, variantValues = [], stockCount, stockLocationId }) {
  const data = await graphqlRequest(ADD_VARIANT_MUTATION, {
    input: { productId, variant: buildVariantInput({ sku, sellPrice, currency, isActive, variantValues }) },
  });

  if (stockCount !== undefined && stockCount !== null) {
    await saveVariantStock({
      productId,
      variantId: data.addVariantToProduct,
      stockCount,
      stockLocationId,
    });
  }

  return data.addVariantToProduct;
}

module.exports = {
  createBasicProduct,
  createProductWithVariants,
  addVariantToProduct,
  updateVariantPrices,
  updateProductCategories,
  updateProductBrand,
  updateProductTaxonomy,
  listAllProducts,
  getProductById,
  resolveLiveVariant,
  resolveLiveProductVariant,
  saveVariantStock,
  getVariantStockAtLocation,
  listAllVariantStocks,
  incrementVariantStock,
  listStockLocations,
};
