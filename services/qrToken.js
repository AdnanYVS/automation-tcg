const crypto = require('crypto');

function generateQrToken() {
  return crypto.randomBytes(9).toString('base64url');
}

function buildQrUrl(token) {
  const base = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (base) return `${base}/q/${token}`;
  return `/q/${token}`;
}

module.exports = {
  generateQrToken,
  buildQrUrl,
};
