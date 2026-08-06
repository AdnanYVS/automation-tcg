#!/usr/bin/env node
/**
 * Tag koşullarına göre ikas dinamik kategorileri oluşturur.
 * Normal navigasyon ağacına ek yedek katman — menü hiyerarşisi normal kategorilerde kalır.
 *
 * Kullanım:
 *   node scripts/setup-dynamic-categories.js [--dry-run]
 */

require('dotenv').config();

const { createDynamicCategory, listCategories } = require('../services/ikas/categories');
const { getSupportedGames } = require('../services/ikas/taxonomy');
const {
  NAV_ROOT_GROUPS,
  BULK_SUBCATEGORIES,
  SINGLE_LANGUAGE_SUBCATEGORIES,
  GRADED_COMPANY_SUBCATEGORIES,
  SEALED_SUBCATEGORIES,
} = require('../services/ikas/navigationCategories');

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

function brandCondition(brandName) {
  return {
    conditionType: 'PRODUCT_BRAND',
    method: 'IN',
    valueList: [brandName],
  };
}

function tagCondition(tag) {
  return {
    conditionType: 'PRODUCT_TAG',
    method: 'IN',
    valueList: [tag],
  };
}

function buildDynamicCategoryDefinitions(game) {
  const defs = [];
  const brandName = game.brandName;

  for (const languageCategory of SINGLE_LANGUAGE_SUBCATEGORIES) {
    const langTag = languageCategory.includes('Japonca')
      ? 'lang:ja'
      : languageCategory.includes('Çince')
        ? 'lang:zh'
        : 'lang:en';
    defs.push({
      name: `[AUTO] ${brandName} ${NAV_ROOT_GROUPS.single} ${languageCategory}`,
      conditions: [
        brandCondition(brandName),
        tagCondition('type:single'),
        tagCondition(langTag),
      ],
    });
  }

  for (const gradedCategory of GRADED_COMPANY_SUBCATEGORIES) {
    defs.push({
      name: `[AUTO] ${brandName} ${NAV_ROOT_GROUPS.graded} ${gradedCategory}`,
      conditions: [
        brandCondition(brandName),
        tagCondition('type:graded'),
        tagCondition(`graded:${gradedCategory.replace(/\s+/g, '-').toLowerCase()}`),
      ],
    });
  }

  for (const sealedCategory of SEALED_SUBCATEGORIES) {
    defs.push({
      name: `[AUTO] ${brandName} ${NAV_ROOT_GROUPS.sealed} ${sealedCategory}`,
      conditions: [
        brandCondition(brandName),
        tagCondition('type:sealed'),
        tagCondition(`sealed:${sealedCategory.replace(/\s+/g, '-').toLowerCase()}`),
      ],
    });
  }

  for (const bulkCategory of BULK_SUBCATEGORIES) {
    const langTag = bulkCategory.includes('Japonca') ? 'lang:ja' : 'lang:en';
    defs.push({
      name: `[AUTO] ${brandName} ${bulkCategory}`,
      conditions: [
        brandCondition(brandName),
        tagCondition('type:bulk'),
        tagCondition(langTag),
      ],
    });
  }

  return defs;
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  const categories = await listCategories({ refresh: true });
  const existingAutomated = new Set(
    categories.filter((entry) => entry.isAutomated).map((entry) => entry.name),
  );

  const stats = { dryRun, created: 0, existing: 0, failed: 0 };

  for (const game of getSupportedGames()) {
    const definitions = buildDynamicCategoryDefinitions(game);
    for (const definition of definitions) {
      if (existingAutomated.has(definition.name)) {
        stats.existing += 1;
        continue;
      }

      if (dryRun) {
        console.log(`[dynamic-categories] DRY-RUN oluşturulacak: ${definition.name}`);
        stats.created += 1;
        continue;
      }

      try {
        const result = await createDynamicCategory({
          name: definition.name,
          conditions: definition.conditions,
          shouldMatchAllConditions: true,
        });
        if (result.created) stats.created += 1;
        else stats.existing += 1;
        console.log(`[dynamic-categories] ${result.created ? 'Oluşturuldu' : 'Mevcut'}: ${definition.name}`);
      } catch (error) {
        stats.failed += 1;
        console.error(`[dynamic-categories] Başarısız (${definition.name}): ${error.message}`);
      }
    }
  }

  console.log('[dynamic-categories] Özet:', stats);
}

main().catch((error) => {
  console.error('[dynamic-categories] Kritik hata:', error.message);
  process.exit(1);
});
