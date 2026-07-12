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

async function saveVariantStock({ productId, variantId, stockCount, stockLocationId }) {
  if (stockCount === undefined || stockCount === null) {
    return null;
  }

  const locationId = stockLocationId || await getDefaultStockLocationId();
  const data = await graphqlRequest(SAVE_VARIANT_STOCKS_MUTATION, {
    input: {
      stockInputs: [{
        deleted: false,
        productId,
        variantId,
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
    throw new Error(`ikas stok güncellenemedi (${errors}).`);
  }

  return result;
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
}) {
  const increment = Number(incrementBy);
  if (!Number.isFinite(increment) || increment <= 0) {
    throw new Error('incrementBy pozitif bir sayı olmalıdır.');
  }

  const previousStock = await getVariantStockAtLocation({
    productId,
    variantId,
    stockLocationId,
  });
  const newStock = previousStock + increment;

  await saveVariantStock({
    productId,
    variantId,
    stockLocationId,
    stockCount: newStock,
  });

  return { previousStock, newStock, incrementBy: increment };
}

function buildVariantInput({ sku, sellPrice, currency = 'TRY', isActive = true, variantValues = [], barcodeList = [] }) {
  const variant = { sku, isActive, prices: [{ sellPrice, currency }] };
  if (variantValues.length > 0) variant.variantValues = variantValues;
  if (barcodeList.length > 0) variant.barcodeList = barcodeList;
  return variant;
}

async function listAllProducts({ pageSize = 50 } = {}) {
  let page = 1;
  const products = [];

  while (true) {
    const data = await graphqlRequest(LIST_PRODUCTS_QUERY, {
      pagination: { page, limit: pageSize },
    });
    const items = data.listProduct?.data || [];
    if (!items.length) break;

    products.push(...items);
    if (items.length < pageSize) break;
    page += 1;
  }

  return products;
}

async function updateProductCategories({ productId, categoryName, categoryPath = [] }) {
  const categories = [{ name: categoryName }];
  if (categoryPath.length > 0) {
    categories[0].path = categoryPath;
  }

  const data = await graphqlRequest(UPDATE_PRODUCT_MUTATION, {
    input: {
      id: productId,
      categories,
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
}) {
  const input = { id: productId };

  if (brandName) {
    input.brand = { name: brandName };
  }

  if (categoryName) {
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

  if (categoryName) {
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
  const variant = product.variants?.[0];

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

async function updateVariantPrices(variantUpdates, { currency = 'TRY', priceListId = null } = {}) {
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
  if (result?.errors?.length) {
    const errors = result.errors
      .map((entry) => entry.errorCode || JSON.stringify(entry))
      .join(', ');
    throw new Error(`ikas fiyat güncellenemedi (${errors}).`);
  }

  return result;
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
  saveVariantStock,
  getVariantStockAtLocation,
  listAllVariantStocks,
  incrementVariantStock,
  listStockLocations,
};
