require('dotenv').config();

const axios = require('axios');

const OAUTH_URL = process.env.IKAS_OAUTH_URL || 'https://api.myikas.com/api/admin/oauth/token';
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const clientId = process.env.IKAS_CLIENT_ID;
  const clientSecret = process.env.IKAS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('IKAS_CLIENT_ID ve IKAS_CLIENT_SECRET ortam değişkenleri tanımlı olmalıdır.');
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await axios.post(OAUTH_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });

    const { access_token: accessToken, expires_in: expiresIn } = response.data;
    if (!accessToken) throw new Error('ikas OAuth yanıtında access_token bulunamadı.');

    cachedToken = accessToken;
    tokenExpiresAt = now + Number(expiresIn || 14400) * 1000 - 60_000;
    return cachedToken;
  } catch (error) {
    const message = error.response?.data?.error_description || error.response?.data?.message || error.message;
    console.error('ikas OAuth token alınamadı:', message);
    throw new Error(`ikas OAuth hatası: ${message}`);
  }
}

function clearTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

module.exports = { getAccessToken, clearTokenCache };
