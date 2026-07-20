#!/usr/bin/env node
/**
 * One Piece shop kategori ağacını oluşturur, storefront'ta görünür yapar
 * ve (varsayılan) One Piece altındaki eski set/navigasyon kategorilerini HIDDEN yapar.
 *
 * Ağaç:
 *   One Piece → İngilizce | Japonca | Çince → 7 ürün tipi
 *
 * Kullanım:
 *   node scripts/setup-onepiece-shop-categories.js [--dry-run] [--keep-others-visible]
 */

require('dotenv').config();

const {
  ensureOnePieceShopTaxonomy,
  listOnePieceShopTaxonomySummary,
  syncOnePieceShopStorefrontVisibility,
  PRODUCT_TYPE_LEAVES,
} = require('../services/ikas/onePieceShopCategories');

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    hideOthers: !argv.includes('--keep-others-visible'),
  };
}

async function main() {
  const { dryRun, hideOthers } = parseArgs(process.argv);

  console.log('[onepiece-shop] One Piece shop kategori ağacı kuruluyor...');
  console.log(`[onepiece-shop] Eski OP kategorilerini gizle: ${hideOthers ? 'evet' : 'hayır'}`);

  if (dryRun) {
    const summary = await listOnePieceShopTaxonomySummary();
    const visibility = await syncOnePieceShopStorefrontVisibility({
      dryRun: true,
      hideOthers,
    });
    console.log('[onepiece-shop] DRY-RUN özet:', JSON.stringify(summary, null, 2));
    console.log('[onepiece-shop] Beklenen yapraklar:', PRODUCT_TYPE_LEAVES.join(', '));
    console.log('[onepiece-shop] DRY-RUN görünürlük:', {
      keepVisible: visibility.keepVisible,
      protectedOther: visibility.protectedOther,
      toShow: visibility.toShow.length,
      toHide: visibility.toHide.length,
      toHideSample: visibility.toHide.slice(0, 20),
      toShowSample: visibility.toShow.slice(0, 20),
    });
    return;
  }

  const stats = await ensureOnePieceShopTaxonomy({ allowCreate: true, force: true });
  const visibility = await syncOnePieceShopStorefrontVisibility({
    dryRun: false,
    hideOthers,
  });
  const summary = await listOnePieceShopTaxonomySummary();

  console.log('[onepiece-shop] Ağaç sonucu:', stats);
  console.log('[onepiece-shop] Görünürlük:', {
    keepVisible: visibility.keepVisible,
    protectedOther: visibility.protectedOther,
    shown: visibility.shown,
    hidden: visibility.hidden,
    skipped: visibility.skipped,
    failed: visibility.failed,
  });
  if (visibility.failures?.length) {
    console.log('[onepiece-shop] Görünürlük hataları (ilk 20):', visibility.failures.slice(0, 20));
  }
  console.log('[onepiece-shop] Özet:', JSON.stringify(summary, null, 2));

  if (visibility.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[onepiece-shop] Kritik hata:', error.message);
  process.exit(1);
});
