#!/usr/bin/env node
/**
 * Mevcut mapping kayıtlarına qr_token atar.
 *
 * Kullanım:
 *   node scripts/backfill-qr-tokens.js --dry-run
 *   node scripts/backfill-qr-tokens.js --apply
 */

require('dotenv').config();

const { getAllMappings, ensureQrTokenForMapping } = require('../db');
const { buildQrUrl } = require('../services/qrToken');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  return { dryRun: !apply, apply };
}

function main() {
  const { dryRun } = parseArgs(process.argv);
  const mappings = getAllMappings();
  const stats = { total: mappings.length, existing: 0, created: 0 };

  for (const mapping of mappings) {
    if (mapping.qr_token) {
      stats.existing += 1;
      continue;
    }
    if (dryRun) {
      stats.created += 1;
      console.log(`[qr-backfill] WOULD mapping=${mapping.id} card=${mapping.kartfiyat_card_id}`);
      continue;
    }
    const token = ensureQrTokenForMapping(mapping.id);
    stats.created += 1;
    console.log(`[qr-backfill] OK mapping=${mapping.id} → ${buildQrUrl(token)}`);
  }

  console.log('[qr-backfill] Özet:', stats);
  if (dryRun) console.log('[qr-backfill] Uygulamak için --apply kullanın.');
}

main();
