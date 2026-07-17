#!/usr/bin/env node
/**
 * Mevcut mapping kayıtlarına ikas'taki gerçek variant SKU'sunu yazar.
 * Onay/fiyat kurtarma için KF-{id} varsayımına bağımlılığı azaltır.
 *
 * Kullanım:
 *   node scripts/backfill-mapping-skus.js --dry-run
 *   node scripts/backfill-mapping-skus.js --apply
 */
require('dotenv').config();

const { getAllMappings, updateMappingIkasIds } = require('../db');
const { getProductById, listAllProducts } = require('../services/ikas/products');

async function main() {
  const apply = process.argv.includes('--apply');
  const mappings = getAllMappings();
  const stats = { total: mappings.length, updated: 0, skipped: 0, missing: 0, failed: 0 };

  console.log(`[backfill-skus] ${mappings.length} mapping, mode=${apply ? 'apply' : 'dry-run'}`);

  let catalog = null;

  for (const mapping of mappings) {
    try {
      if (mapping.sku) {
        stats.skipped += 1;
        continue;
      }

      let product = null;
      if (mapping.ikas_product_id) {
        product = await getProductById(mapping.ikas_product_id);
      }

      let variant = null;
      if (product?.variants?.length) {
        variant = product.variants.find((entry) => entry.id === mapping.ikas_variant_id)
          || product.variants[0];
      }

      if (!variant?.sku) {
        if (!catalog) {
          console.log('[backfill-skus] Katalog yükleniyor (ID ile bulunamayanlar için)...');
          catalog = await listAllProducts();
        }
        for (const item of catalog) {
          const match = (item.variants || []).find((entry) => entry.id === mapping.ikas_variant_id);
          if (match?.sku) {
            product = item;
            variant = match;
            break;
          }
        }
      }

      if (!variant?.sku) {
        stats.missing += 1;
        console.warn(
          `[backfill-skus] SKU yok: mapping=${mapping.id} card=${mapping.kartfiyat_card_id} `
          + `product=${mapping.ikas_product_id || '?'}`,
        );
        continue;
      }

      console.log(
        `[backfill-skus] ${apply ? 'UPDATE' : 'WOULD'} mapping=${mapping.id}`
        + ` → sku=${variant.sku}`
        + (product?.id && product.id !== mapping.ikas_product_id
          ? ` product=${mapping.ikas_product_id}→${product.id}`
          : ''),
      );

      if (apply) {
        updateMappingIkasIds({
          mappingId: mapping.id,
          ikasProductId: product?.id || null,
          ikasVariantId: variant.id || null,
          sku: variant.sku,
          barcode: variant.barcodeList?.[0] || null,
        });
      }
      stats.updated += 1;
    } catch (error) {
      stats.failed += 1;
      console.error(`[backfill-skus] mapping=${mapping.id} hata:`, error.message);
    }
  }

  console.log('[backfill-skus] Tamamlandı:', stats);
  if (!apply) {
    console.log('[backfill-skus] Yazmak için --apply kullanın.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
