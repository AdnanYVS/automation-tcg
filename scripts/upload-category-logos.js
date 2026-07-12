#!/usr/bin/env node
/**
 * Onaylanmış kategori logolarını ikas'a yükler.
 * Önce category-logos.html üzerinden onay verin.
 */

require('dotenv').config();

const { uploadApprovedCategoryLogos, buildCategoryLogoPreview } = require('../services/categoryLogos');

async function main() {
  const preview = await buildCategoryLogoPreview();
  const approved = preview.items.filter((item) => item.status === 'approved' || item.status === 'failed');

  if (!approved.length) {
    console.log('Yüklenecek onaylı kategori logosu yok. Önce /category-logos.html sayfasından onay verin.');
    process.exit(0);
  }

  console.log(`[category-logos] ${approved.length} onaylı logo yüklenecek...`);
  const stats = await uploadApprovedCategoryLogos({
    delayMs: Number(process.env.IKAS_CATEGORY_LOGO_DELAY_MS || 400),
  });
  console.log('[category-logos] Tamamlandı:', stats);
  if (stats.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[category-logos] Kritik hata:', error.message);
  process.exit(1);
});
