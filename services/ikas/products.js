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
      isSuccess
      errorInputs { priceListId productId variantId }
    }
  }
`;

const SAVE_VARIANT_STOCKS_MUTATION = `
  mutation SaveVariantStocks($input: SaveVariantStocksInput!) {
    saveVariantStocks(input: $input) {
      isSuccess
      errorInputs { variantId productId }
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
        stockCount,
      }],
    },
  });

  if (!data.saveVariantStocks?.isSuccess) {
    throw new Error('ikas stok güncelleme başarısız.');
  }

  return data.saveVariantStocks;
}

function buildVariantInput({ sku, sellPrice, currency = 'TRY', isActive = true, variantValues = [], barcodeList = [] }) {
  const variant = { sku, isActive, prices: [{ sellPrice, currency }] };
  if (variantValues.length > 0) variant.variantValues = variantValues;
  if (barcodeList.length > 0) variant.barcodeList = barcodeList;
  return variant;
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

  if (categoryName) {
    input.categories = [{ name: categoryName }];
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
      try {
        await saveVariantStock({
          productId: product.id,
          variantId: variant.id,
          stockCount,
          stockLocationId,
        });
      } catch (error) {
        console.error('ikas stok güncelleme başarısız:', error.message);
      }
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
    try {
      await saveVariantStock({
        productId,
        variantId: data.addVariantToProduct,
        stockCount,
        stockLocationId,
      });
    } catch (error) {
      console.error('ikas stok güncelleme başarısız:', error.message);
    }
  }

  return data.addVariantToProduct;
}

async function updateVariantPrices(variantUpdates, { currency = 'TRY', priceListId = null } = {}) {
  const variantPriceInputs = variantUpdates.map(({ productId, variantId, sellPrice }) => ({
    deleted: false,
    productId,
    variantId,
    price: { sellPrice, currency },
  }));

  const data = await graphqlRequest(UPDATE_VARIANT_PRICES_MUTATION, {
    input: { priceListId, variantPriceInputs },
  });

  if (!data.updateVariantPrices?.isSuccess) {
    throw new Error('ikas fiyat güncelleme başarısız.');
  }

  return data.updateVariantPrices;
}

module.exports = {
  createBasicProduct,
  createProductWithVariants,
  addVariantToProduct,
  updateVariantPrices,
  saveVariantStock,
  listStockLocations,
};
