#!/usr/bin/env node
/**
 * Navigasyon kategori ağacını vitrinde görünür yapar; diğer kategorileri gizler.
 *
 * Kullanım:
 *   node scripts/sync-navigation-storefront-visibility.js --dry-run
 *   node scripts/sync-navigation-storefront-visibility.js --apply
 */

require('dotenv').config();

const { syncNavigationStorefrontVisibility } = require('../services/ikas/navigationCategories');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run') || !apply;
  return { dryRun, apply };
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  console.log(`[navigation-visibility] Mod: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);

  const stats = await syncNavigationStorefrontVisibility({ dryRun, hideOthers: true });
  console.log('[navigation-visibility] Özet:', JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error('[navigation-visibility] Kritik hata:', error.message);
  process.exit(1);
});
