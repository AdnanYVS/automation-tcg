#!/usr/bin/env node
/**
 * Pokemon shop kategori ağacını oluşturur, storefront'ta görünür yapar
 * ve (varsayılan) yeni ağaç + One Piece dışındaki kategorileri HIDDEN yapar.
 *
 * Kullanım:
 *   node scripts/setup-pokemon-shop-categories.js [--dry-run] [--keep-others-visible]
 */

require('dotenv').config();

const {
  ensurePokemonShopTaxonomy,
  listPokemonShopTaxonomySummary,
  syncPokemonShopStorefrontVisibility,
  PRODUCT_TYPE_LEAVES,
} = require('../services/ikas/pokemonShopCategories');

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    hideOthers: !argv.includes('--keep-others-visible'),
  };
}

async function main() {
  const { dryRun, hideOthers } = parseArgs(process.argv);

  console.log('[pokemon-shop] Pokemon shop kategori ağacı kuruluyor...');
  console.log(`[pokemon-shop] Diğer kategorileri gizle: ${hideOthers ? 'evet' : 'hayır'}`);

  if (dryRun) {
    const summary = await listPokemonShopTaxonomySummary();
    const visibility = await syncPokemonShopStorefrontVisibility({
      dryRun: true,
      hideOthers,
    });
    console.log('[pokemon-shop] DRY-RUN özet:', JSON.stringify(summary, null, 2));
    console.log('[pokemon-shop] Beklenen yapraklar:', PRODUCT_TYPE_LEAVES.join(', '));
    console.log('[pokemon-shop] DRY-RUN görünürlük:', {
      keepVisible: visibility.keepVisible,
      protectedOnePiece: visibility.protectedOnePiece,
      toShow: visibility.toShow.length,
      toHide: visibility.toHide.length,
      toHideSample: visibility.toHide.slice(0, 20),
    });
    return;
  }

  const stats = await ensurePokemonShopTaxonomy({ allowCreate: true, force: true });
  const visibility = await syncPokemonShopStorefrontVisibility({
    dryRun: false,
    hideOthers,
  });
  const summary = await listPokemonShopTaxonomySummary();

  console.log('[pokemon-shop] Ağaç sonucu:', stats);
  console.log('[pokemon-shop] Görünürlük:', {
    keepVisible: visibility.keepVisible,
    protectedOnePiece: visibility.protectedOnePiece,
    shown: visibility.shown,
    hidden: visibility.hidden,
    skipped: visibility.skipped,
    failed: visibility.failed,
  });
  if (visibility.failures?.length) {
    console.log('[pokemon-shop] Görünürlük hataları (ilk 20):', visibility.failures.slice(0, 20));
  }
  console.log('[pokemon-shop] Özet:', JSON.stringify(summary, null, 2));

  if (visibility.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[pokemon-shop] Kritik hata:', error.message);
  process.exit(1);
});
