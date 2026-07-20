const { graphqlRequest } = require('./client');

const LIST_ORDERS_QUERY = `
  query ListOrder($pagination: PaginationInput, $stockLocationId: StringFilterInput, $search: String) {
    listOrder(
      pagination: $pagination
      stockLocationId: $stockLocationId
      search: $search
    ) {
      count
      data {
        id
        orderNumber
        status
        orderPaymentStatus
        createdAt
        orderedAt
        stockLocationId
        stockLocation {
          id
          name
        }
        orderLineItems {
          id
          quantity
          finalPrice
          finalUnitPrice
          status
          stockLocationId
          variant {
            id
            sku
            barcodeList
            name
            productId
          }
        }
      }
    }
  }
`;

const EXCLUDED_ORDER_STATUSES = new Set([
  'DRAFT',
  'CANCELLED',
  'REFUNDED',
]);

const EXCLUDED_LINE_STATUSES = new Set([
  'CANCELLED',
  'CANCEL_REQUESTED',
  'CANCEL_REJECTED',
  'REFUNDED',
  'REFUND_REQUESTED',
  'REFUND_REJECTED',
  'REFUND_REQUEST_ACCEPTED',
]);

async function listOrdersPage({
  page = 1,
  limit = 50,
  stockLocationId = null,
  search = null,
} = {}) {
  const variables = {
    pagination: { page, limit },
  };

  if (stockLocationId) {
    variables.stockLocationId = { eq: stockLocationId };
  }
  if (search) {
    variables.search = search;
  }

  const data = await graphqlRequest(LIST_ORDERS_QUERY, variables);
  return data.listOrder || { count: 0, data: [] };
}

async function listAllOrders({ stockLocationId = null, search = null, pageSize = 50, maxPages = 40 } = {}) {
  const orders = [];
  let page = 1;
  let totalCount = 0;

  while (page <= maxPages) {
    const result = await listOrdersPage({
      page,
      limit: pageSize,
      stockLocationId,
      search,
    });

    if (page === 1) totalCount = result.count || 0;
    const items = result.data || [];
    if (!items.length) break;

    orders.push(...items);
    if (items.length < pageSize) break;
    page += 1;
  }

  return { count: totalCount, orders };
}

function isCountableOrder(order) {
  return order?.status && !EXCLUDED_ORDER_STATUSES.has(order.status);
}

function isCountableLineItem(lineItem) {
  return lineItem?.status && !EXCLUDED_LINE_STATUSES.has(lineItem.status);
}

module.exports = {
  listOrdersPage,
  listAllOrders,
  isCountableOrder,
  isCountableLineItem,
  EXCLUDED_ORDER_STATUSES,
  EXCLUDED_LINE_STATUSES,
};
