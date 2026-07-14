#!/usr/bin/env node
/**
 * Yinelenen (nested) ikas kategorilerini birleştirir.
 *
 * Kullanım:
 *   node scripts/consolidate-duplicate-categories.js --dry-run
 *   node scripts/consolidate-duplicate-categories.js --apply
 *   node scripts/consolidate-duplicate-categories.js --apply --cleanup-only
 */

require('dotenv').config();

const {
  buildDuplicateCategoryConsolidationPlan,
  buildTemporaryCategoryCleanupPlan,
  consolidateDuplicateCategories,
} = require('../services/ikas/categoryConsolidation');

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    dryRun: !argv.includes('--apply'),
    cleanupOnly: argv.includes('--cleanup-only'),
    skipCleanup: argv.includes('--skip-cleanup'),
  };
}

function printPlan(plan, cleanupPlan) {
  console.log('\n[consolidate] Özet:', plan.summary);
  console.log('[consolidate] Geçici kategori temizliği:', {
    totalTemporaryCategories: cleanupPlan.totalTemporaryCategories,
    emptyTemporaryCategories: cleanupPlan.emptyTemporaryCategories.length,
    temporaryCategoriesWithProducts: cleanupPlan.temporaryCategoriesWithProducts.length,
  });
  if (cleanupPlan.temporaryCategoriesWithProducts.length) {
    console.log('[consolidate] Ürünlü TMP kategorileri kurtarma için hazır.');
  }
  console.log('[consolidate] Kök kategori:', plan.rootName, `(${plan.rootId})`);
  console.log('[consolidate] Örnek gruplar:');

  for (const group of plan.groups.slice(0, 8)) {
    console.log(`\n  ${group.name}`);
    console.log(`    tutulacak: depth=${group.canonical.depth}, ürün=${group.canonical.productCount} (${group.canonical.id.slice(0, 8)})`);
    for (const duplicate of group.duplicates) {
      console.log(`    silinecek: depth=${duplicate.depth}, ürün=${duplicate.productCount} (${duplicate.id.slice(0, 8)})`);
    }
    if (group.productMoves.length) {
      console.log(`    taşınacak ürün: ${group.productMoves.length}`);
    }
  }

  if (plan.groups.length > 8) {
    console.log(`\n  ... ve ${plan.groups.length - 8} grup daha`);
  }
}

async function main() {
  const { apply, dryRun, cleanupOnly, skipCleanup } = parseArgs(process.argv);
  const delayMs = Number(process.env.IKAS_CONSOLIDATE_DELAY_MS || process.env.IKAS_TAXONOMY_DELAY_MS || 1000);

  const modeLabel = cleanupOnly ? ' (cleanup-only)' : '';
  console.log(`[consolidate] Başlıyor${dryRun ? ' (dry-run)' : ' (apply)'}${modeLabel}...`);

  const plan = await buildDuplicateCategoryConsolidationPlan();
  const cleanupPlan = await buildTemporaryCategoryCleanupPlan();
  printPlan(plan, cleanupPlan);

  if (!plan.groups.length && !cleanupPlan.emptyTemporaryCategories.length) {
    console.log('\n[consolidate] Birleştirilecek duplicate kategori yok.');
    return;
  }

  if (dryRun) {
    const preview = await consolidateDuplicateCategories({ dryRun: true, delayMs, cleanupOnly, skipCleanup });
    console.log('\n[consolidate] Dry-run sonucu:', preview.stats);
    console.log('[consolidate] Uygulamak için: node scripts/consolidate-duplicate-categories.js --apply');
    console.log('[consolidate] Sadece tmp temizliği: node scripts/consolidate-duplicate-categories.js --apply --cleanup-only');
    return;
  }

  const result = await consolidateDuplicateCategories({
    dryRun: false,
    delayMs,
    cleanupOnly,
    skipCleanup,
  });
  console.log('\n[consolidate] Uygulama sonucu:', result.stats);

  if (result.stats.failures.length) {
    console.log('[consolidate] Hatalar:');
    for (const failure of result.stats.failures.slice(0, 20)) {
      console.log(`  - ${failure.type}: ${failure.productName || failure.categoryName} → ${failure.reason}`);
    }
  }

  if (!dryRun && (result.stats.categoriesRenameFailed > 0 || result.stats.productsFailed > 0 || result.stats.categoriesFailed > 0)) {
    console.log('[consolidate] Kısmi hata varsa komutu tekrar çalıştırabilirsiniz.');
  }

  const verifyPlan = await buildDuplicateCategoryConsolidationPlan();
  console.log('\n[consolidate] Doğrulama:', verifyPlan.summary);

  if (result.stats.productsFailed > 0 || result.stats.categoriesFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[consolidate] Kritik hata:', error.message);
  process.exit(1);
});
