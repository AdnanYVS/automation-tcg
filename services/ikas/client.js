require('dotenv').config();

const axios = require('axios');
const { getAccessToken } = require('./auth');

const GRAPHQL_URL = process.env.IKAS_API_URL || 'https://api.myikas.com/api/v2/admin/graphql';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  if (error.message?.startsWith('ikas GraphQL hatası:')) {
    return error.message;
  }
  return error.response?.data?.errors?.[0]?.message
    || error.response?.data?.message
    || error.message;
}

function isRetryableError(error, message) {
  const status = error.response?.status;
  return status === 429
    || status === 502
    || status === 503
    || status === 504
    || /timeout|network timeout|rate limit|too many|ECONNRESET|ETIMEDOUT/i.test(message);
}

async function graphqlRequest(query, variables = {}, { maxAttempts } = {}) {
  const attempts = maxAttempts || Number(process.env.IKAS_GRAPHQL_MAX_ATTEMPTS || 6);
  let attempt = 0;

  while (attempt < attempts) {
    try {
      const accessToken = await getAccessToken();
      const response = await axios.post(
        GRAPHQL_URL,
        { query, variables },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: Number(process.env.IKAS_GRAPHQL_TIMEOUT_MS || 120000),
        },
      );

      if (response.data?.errors?.length) {
        const messages = response.data.errors.map((err) => err.message).join(' | ');
        throw new Error(`ikas GraphQL hatası: ${messages}`);
      }

      return response.data.data;
    } catch (error) {
      attempt += 1;
      const message = getErrorMessage(error);

      if (!isRetryableError(error, message) || attempt >= attempts) {
        console.error('ikas GraphQL isteği başarısız:', message);
        throw new Error(message.startsWith('ikas GraphQL') ? message : `ikas GraphQL isteği başarısız: ${message}`);
      }

      const waitMs = Number(process.env.IKAS_GRAPHQL_RETRY_MS || 3000) * attempt;
      console.warn(`[ikas] ${attempt}/${attempts} tekrar (${waitMs}ms): ${message}`);
      await sleep(waitMs);
    }
  }

  throw new Error('ikas GraphQL isteği başarısız: maksimum deneme aşıldı');
}

module.exports = { graphqlRequest };
