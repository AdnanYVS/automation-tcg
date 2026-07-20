require('dotenv').config();

const axios = require('axios');

const BASE_URL = process.env.KARTFIYAT_API_URL || 'https://kartfiyat.com/api/v1';

function createKartfiyatClient() {
  const token = process.env.KARTFIYAT_API_TOKEN;
  if (!token) {
    throw new Error('KARTFIYAT_API_TOKEN ortam değişkeni tanımlı değil.');
  }

  return axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
}

function parseApiResponse(response) {
  const payload = response.data;
  if (!payload?.success) {
    const error = payload?.error || {};
    throw new Error(`KartFiyat API hatası [${error.code || 'UNKNOWN'}]: ${error.message || 'Bilinmeyen hata'}`);
  }
  return payload;
}

module.exports = { createKartfiyatClient, parseApiResponse };
