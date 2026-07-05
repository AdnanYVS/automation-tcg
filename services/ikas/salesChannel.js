const { graphqlRequest } = require('./client');

const LIST_SALES_CHANNELS_QUERY = `
  query ListSalesChannel {
    listSalesChannel {
      id
      name
      type
    }
  }
`;

const UPDATE_SALES_CHANNEL_STATUS_MUTATION = `
  mutation UpdateProductSalesChannelStatus($input: UpdateSalesChannelStatusInput!) {
    updateProductSalesChannelStatus(input: $input)
  }
`;

let cachedSalesChannelId = null;

async function getStorefrontSalesChannelId() {
  if (process.env.IKAS_SALES_CHANNEL_ID) {
    return process.env.IKAS_SALES_CHANNEL_ID;
  }

  if (cachedSalesChannelId) {
    return cachedSalesChannelId;
  }

  const data = await graphqlRequest(LIST_SALES_CHANNELS_QUERY);
  const channels = data.listSalesChannel || [];
  const storefront = channels.find((channel) => channel.type === 'STOREFRONT') || channels[0];

  if (!storefront?.id) {
    throw new Error('ikas satış kanalı bulunamadı.');
  }

  cachedSalesChannelId = storefront.id;
  return cachedSalesChannelId;
}

/**
 * Ürünü mağaza satış kanalında görünür (satışa açık) yapar.
 */
async function enableProductForSale(productId) {
  if (!productId) {
    throw new Error('enableProductForSale için productId zorunludur.');
  }

  const salesChannelId = await getStorefrontSalesChannelId();

  return graphqlRequest(UPDATE_SALES_CHANNEL_STATUS_MUTATION, {
    input: {
      salesChannelId,
      data: [{ productId, status: 'VISIBLE' }],
    },
  });
}

module.exports = {
  getStorefrontSalesChannelId,
  enableProductForSale,
};
