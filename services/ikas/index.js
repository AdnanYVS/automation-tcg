const auth = require('./auth');
const products = require('./products');
const images = require('./images');
const salesChannel = require('./salesChannel');
const categories = require('./categories');
const navigationCategories = require('./navigationCategories');
const pokemonShopCategories = require('./pokemonShopCategories');
const onePieceShopCategories = require('./onePieceShopCategories');
const brands = require('./brands');
const orders = require('./orders');

module.exports = {
  ...auth,
  ...products,
  ...images,
  ...salesChannel,
  ...categories,
  ...navigationCategories,
  ...pokemonShopCategories,
  // One Piece shop — yalnızca unique isimler (LANGUAGE_BRANCHES vs çakışmasın)
  ensureOnePieceShopTaxonomy: onePieceShopCategories.ensureOnePieceShopTaxonomy,
  resolveOnePieceShopCategories: onePieceShopCategories.resolveOnePieceShopCategories,
  classifyOnePieceShopPlacement: onePieceShopCategories.classifyOnePieceShopPlacement,
  listOnePieceShopTaxonomySummary: onePieceShopCategories.listOnePieceShopTaxonomySummary,
  syncOnePieceShopStorefrontVisibility: onePieceShopCategories.syncOnePieceShopStorefrontVisibility,
  isOnePieceProduct: onePieceShopCategories.isOnePieceProduct,
  ...brands,
  ...orders,
};
