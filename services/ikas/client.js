require('dotenv').config();

const axios = require('axios');
const { getAccessToken } = require('./auth');

const GRAPHQL_URL = process.env.IKAS_API_URL || 'https://api.myikas.com/api/v2/admin/graphql';

async function graphqlRequest(query, variables = {}) {
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
    const message = error.message.startsWith('ikas GraphQL hatası:')
      ? error.message
      : (error.response?.data?.errors?.[0]?.message || error.response?.data?.message || error.message);

    console.error('ikas GraphQL isteği başarısız:', message);
    throw new Error(message.startsWith('ikas GraphQL') ? message : `ikas GraphQL isteği başarısız: ${message}`);
  }
}

module.exports = { graphqlRequest };
