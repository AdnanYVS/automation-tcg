require('dotenv').config();

const axios = require('axios');

const CACHE_MS = Number(process.env.EXCHANGE_RATE_CACHE_MS || 86_400_000);
let cachedRate = null;
let cacheExpiresAt = 0;

async function fetchUsdTryFromTcmb() {
  const response = await axios.get('https://www.tcmb.gov.tr/kurlar/today.xml', {
    timeout: 15000,
    responseType: 'text',
  });

  const xml = String(response.data || '');
  const usdBlock = xml.match(/<Currency[^>]*Kod="USD"[^>]*>[\s\S]*?<\/Currency>/i);
  if (!usdBlock) throw new Error('TCMB yanıtında USD kuru bulunamadı.');

  const sellingMatch = usdBlock[0].match(/<ForexSelling>([\d.,]+)<\/ForexSelling>/i)
    || usdBlock[0].match(/<BanknoteSelling>([\d.,]+)<\/BanknoteSelling>/i);
  if (!sellingMatch) throw new Error('TCMB yanıtında USD satış kuru bulunamadı.');

  const rate = Number(sellingMatch[1].replace(',', '.'));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('TCMB USD kuru geçersiz.');
  return rate;
}

async function getUsdTryRate() {
  const now = Date.now();
  if (cachedRate && now < cacheExpiresAt) return cachedRate;

  const provider = String(process.env.EXCHANGE_RATE_PROVIDER || 'tcmb').toLowerCase();
  const rate = provider === 'tcmb' ? await fetchUsdTryFromTcmb() : await fetchUsdTryFromTcmb();

  cachedRate = rate;
  cacheExpiresAt = now + CACHE_MS;
  console.log(`USD/TRY kuru alındı (${provider}): ${rate}`);
  return rate;
}

module.exports = { getUsdTryRate };
