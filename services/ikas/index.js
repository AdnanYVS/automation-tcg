const auth = require('./auth');
const products = require('./products');
const images = require('./images');
const salesChannel = require('./salesChannel');
const categories = require('./categories');
const brands = require('./brands');
const orders = require('./orders');

module.exports = {
  ...auth,
  ...products,
  ...images,
  ...salesChannel,
  ...categories,
  ...brands,
  ...orders,
};
