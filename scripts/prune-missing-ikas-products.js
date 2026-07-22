#!/usr/bin/env node
/**
 * ikas'ta olmayan mapping'leri işaretler; pending fiyat alert'lerini reddeder.
 * Böylece silinmiş ürünler için tekrar fiyat onayı çıkmaz.
 *
 *   node scripts/prune-missing-ikas-products.js --dry-run
 *   node scripts/prune-missing-ikas-products.js --apply
 */
require('dotenv').config();

const { pruneMissingIkasMappings } = require('../services/priceTracking');

async function main() {
  const apply = process.argv.includes('--apply');
  const stats = await pruneMissingIkasMappings({ apply });
  if (!apply) {
    console.log('[prune-missing] Yazmak için --apply kullanın.');
  }
  console.log(stats);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
