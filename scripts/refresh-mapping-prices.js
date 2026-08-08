#!/usr/bin/env node
/**
 * Mevcut mapping kayıtlarına KartFiyat fiyat snapshot yazar.
 *
 *   node scripts/refresh-mapping-prices.js --dry-run
 *   node scripts/refresh-mapping-prices.js --apply
 *   node scripts/refresh-mapping-prices.js --apply --all
 */

require('dotenv').config();

const { initDatabase } = require('../db');
const { refreshMappingPriceSnapshots } = require('../services/mappingBackfill');

async function main() {
  const apply = process.argv.includes('--apply');
  const onlyMissing = !process.argv.includes('--all');
  initDatabase();

  console.log(`[mapping-prices] mode=${apply ? 'apply' : 'dry-run'} onlyMissing=${onlyMissing}`);
  const { stats } = await refreshMappingPriceSnapshots({ apply, onlyMissing });
  console.log('[mapping-prices] Özet:', stats);
  if (!apply) console.log('[mapping-prices] Yazmak için --apply kullanın.');
}

main().catch((error) => {
  console.error('[mapping-prices] Hata:', error.message);
  process.exit(1);
});
