#!/usr/bin/env node
/**
 * ikas kataloğundaki KF-* ürünleri card_mappings tablosu ile eşleştirir.
 *
 * Kullanım:
 *   node scripts/backfill-ikas-mappings.js --dry-run
 *   node scripts/backfill-ikas-mappings.js --apply
 *   node scripts/backfill-ikas-mappings.js --apply --with-prices
 */

require('dotenv').config();

const { initDatabase } = require('../db');
const { backfillIkasMappings } = require('../services/mappingBackfill');

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    withPrices: argv.includes('--with-prices'),
    forceRelink: argv.includes('--force-relink'),
  };
}

async function main() {
  const { apply, withPrices, forceRelink } = parseArgs(process.argv);
  initDatabase();

  console.log(`[mapping-backfill] mode=${apply ? 'apply' : 'dry-run'} prices=${withPrices} forceRelink=${forceRelink}`);
  const { stats, actions } = await backfillIkasMappings({ apply, withPrices, forceRelink });

  for (const entry of actions.slice(0, 20)) {
    if (entry.action === 'conflict') {
      console.warn(
        `[mapping-backfill] CONFLICT card=${entry.kartfiyatCardId} sku=${entry.sku}`
        + ` existingVariant=${entry.existingVariantId} incoming=${entry.incomingVariantId}`,
      );
      continue;
    }
    if (entry.action === 'failed') {
      console.error(`[mapping-backfill] FAIL card=${entry.kartfiyatCardId} sku=${entry.sku}: ${entry.error}`);
      continue;
    }
    const label = entry.priceLabel ? ` label=${entry.priceLabel}` : '';
    console.log(
      `[mapping-backfill] ${entry.action.toUpperCase()} card=${entry.kartfiyatCardId}`
      + ` sku=${entry.sku}${label}${entry.qrUrl ? ` → ${entry.qrUrl}` : ''}`,
    );
  }

  if (actions.length > 20) {
    console.log(`[mapping-backfill] ... ${actions.length - 20} kayıt daha`);
  }

  console.log('[mapping-backfill] Özet:', stats);
  if (!apply) {
    console.log('[mapping-backfill] Yazmak için --apply kullanın.');
    if (!withPrices) {
      console.log('[mapping-backfill] KartFiyat fiyat snapshot için --with-prices ekleyin.');
    }
  }
}

main().catch((error) => {
  console.error('[mapping-backfill] Hata:', error.message);
  process.exit(1);
});
