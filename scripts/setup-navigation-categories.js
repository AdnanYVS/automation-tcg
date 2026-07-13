#!/usr/bin/env node
/**
 * Mağaza navigasyon kategorilerini oluşturur:
 * KAPALI KUTULAR, SINGLE KARTLAR, GRADED KARTLAR
 *
 * Kullanım:
 *   node scripts/setup-navigation-categories.js [--dry-run]
 */

require('dotenv').config();

const { getSupportedGames } = require('../services/ikas/taxonomy');
const {
  ensureNavigationTaxonomy,
  listNavigationCategorySummary,
} = require('../services/ikas/navigationCategories');

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  const games = getSupportedGames();

  console.log('[navigation] Mağaza navigasyon kategorileri kuruluyor...');

  for (const game of games) {
    if (dryRun) {
      const summary = await listNavigationCategorySummary(game.id);
      console.log(`[navigation] DRY-RUN ${game.id}:`, JSON.stringify(summary, null, 2));
      continue;
    }

    const stats = await ensureNavigationTaxonomy(game.id, { allowCreate: true });
    const summary = await listNavigationCategorySummary(game.id);
    console.log(`[navigation] ${game.id} tamam:`, stats);
    console.log(`[navigation] ${game.id} özet:`, summary);
  }
}

main().catch((error) => {
  console.error('[navigation] Kritik hata:', error.message);
  process.exit(1);
});
