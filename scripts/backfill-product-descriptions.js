#!/usr/bin/env node
/**
 * Mevcut ikas ürünlerinin açıklamalarına kartfiyat seri bilgisini yazar.
 *
 * Kullanım:
 *   node scripts/backfill-product-descriptions.js --dry-run
 *   node scripts/backfill-product-descriptions.js --apply
 *   node scripts/backfill-product-descriptions.js --apply --force
 */
require('dotenv').config();

const { syncAllProductSeriesDescriptions } = require('../services/productDescriptions');

async function main() {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');

  console.log(
    `[backfill-descriptions] mode=${apply ? 'apply' : 'dry-run'}`
    + ` skipIfUnchanged=${force ? 'false' : 'true'}`,
  );

  const summary = await syncAllProductSeriesDescriptions({
    dryRun: !apply,
    skipIfUnchanged: !force,
  });

  console.log('[backfill-descriptions] Tamamlandı:', summary);
  if (!apply) {
    console.log('[backfill-descriptions] Yazmak için --apply kullanın.');
  }
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
