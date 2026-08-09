function getStorefrontBaseUrl() {
  return String(
    process.env.IKAS_STOREFRONT_URL
    || process.env.STOREFRONT_BASE_URL
    || 'https://carddunyasi.com',
  ).replace(/\/$/, '');
}

function buildIkasProductUrl(slug) {
  const clean = String(slug || '').trim().replace(/^\//, '');
  if (!clean) return null;
  return `${getStorefrontBaseUrl()}/${clean}`;
}

module.exports = {
  getStorefrontBaseUrl,
  buildIkasProductUrl,
};
