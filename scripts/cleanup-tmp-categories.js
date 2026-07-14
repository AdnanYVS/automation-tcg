#!/usr/bin/env node
/**
 * __TMP_DUP__ kategorilerini temizler:
 * 1) Üzerinde kalan ürünleri KartFiyat set kategorisine taşır
 * 2) Boş TMP kategorilerini siler
 *
 * Kullanım:
 *   node scripts/cleanup-tmp-categories.js --dry-run
 *   node scripts/cleanup-tmp-categories.js --apply
 */

require('dotenv').config();

const {
  buildTemporaryCategoryCleanupPlan,
  buildTemporaryProductRescuePlan,
  rescueTemporaryCategoryProducts,
  consolidateDuplicateCategories,
} = require('../services/ikas/categoryConsolidation');

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    dryRun: !argv.includes('--apply'),
  };
}

async function main() {
  const { apply, dryRun } = parseArgs(process.argv);
  const delayMs = Number(process.env.IKAS_CONSOLIDATE_DELAY_MS || 1200);

  console.log(`[tmp-cleanup] Başlıyor${dryRun ? ' (dry-run)' : ' (apply)'}...`);

  const [cleanupPlan, rescuePlan] = await Promise.all([
    buildTemporaryCategoryCleanupPlan(),
    buildTemporaryProductRescuePlan(),
  ]);

  console.log('[tmp-cleanup] Özet:', {
    totalTemporaryCategories: cleanupPlan.totalTemporaryCategories,
    emptyTemporaryCategories: cleanupPlan.emptyTemporaryCategories.length,
    temporaryWithProducts: cleanupPlan.temporaryCategoriesWithProducts.length,
    productsToRescue: rescuePlan.totalProducts,
  });

  if (rescuePlan.totalProducts) {
    console.log('[tmp-cleanup] Kurtarılacak ürünler:');
    for (const item of rescuePlan.items) {
      console.log(
        `  - ${item.productName} (${item.sku || 'SKU yok'})`
        + ` ← ${item.temporaryCategoryNames.join(', ')}`
        + ` → KF-${item.kartfiyatCardId || '?'}`,
      );
    }
  }

  if (dryRun) {
    if (rescuePlan.totalProducts) {
      await rescueTemporaryCategoryProducts({ dryRun: true, delayMs });
    }
    console.log(
      `\n[tmp-cleanup] Dry-run: ${rescuePlan.totalProducts} ürün taşınacak, `
      + `${cleanupPlan.emptyTemporaryCategories.length + cleanupPlan.temporaryCategoriesWithProducts.length} TMP silinecek (ürünler taşındıktan sonra).`,
    );
    console.log('[tmp-cleanup] Uygulamak için: npm run categories:tmp-cleanup:apply');
    return;
  }

  const result = await consolidateDuplicateCategories({
    dryRun: false,
    delayMs,
    cleanupOnly: true,
    skipCleanup: false,
  });

  console.log('\n[tmp-cleanup] Sonuç:', {
    temporaryRescued: result.stats.temporaryRescued,
    temporaryRescueFailed: result.stats.temporaryRescueFailed,
    temporaryDeleted: result.stats.temporaryDeleted,
    temporaryDeleteFailed: result.stats.temporaryDeleteFailed,
  });

  if (result.stats.failures.length) {
    console.log('[tmp-cleanup] Hatalar:');
    for (const failure of result.stats.failures.slice(0, 30)) {
      console.log(`  - ${failure.type}: ${failure.productName || failure.categoryName} → ${failure.reason}`);
    }
  }

  const verify = await buildTemporaryCategoryCleanupPlan();
  console.log('\n[tmp-cleanup] Doğrulama:', {
    remainingTmp: verify.totalTemporaryCategories,
    remainingWithProducts: verify.temporaryCategoriesWithProducts.length,
    remainingEmpty: verify.emptyTemporaryCategories.length,
  });

  if (
    result.stats.temporaryRescueFailed > 0
    || result.stats.temporaryDeleteFailed > 0
    || verify.totalTemporaryCategories > 0
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[tmp-cleanup] Kritik hata:', error.message);
  process.exit(1);
});
