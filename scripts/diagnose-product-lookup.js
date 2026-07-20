#!/usr/bin/env node
/**
 * Tek ürün için ID / SKU / barkod lookup tanısı.
 *
 *   node scripts/diagnose-product-lookup.js --product-id=... --sku=... --barcode=...
 */
require('dotenv').config();

const {
  getProductById,
  listProductsBySku,
  listProductsByBarcode,
  listAllProducts,
  findProductBySkuOrBarcode,
} = require('../services/ikas/products');

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((entry) => entry.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function main() {
  const productId = arg('product-id');
  const sku = arg('sku');
  const barcode = arg('barcode');

  if (!productId && !sku && !barcode) {
    console.error('Kullanım: --product-id= --sku= --barcode= (en az biri)');
    process.exit(1);
  }

  console.log('Girdi:', { productId, sku, barcode });

  if (productId) {
    const byId = await getProductById(productId);
    console.log('getProductById:', byId
      ? { id: byId.id, name: byId.name, variants: byId.variants?.map((v) => ({ id: v.id, sku: v.sku, barcodeList: v.barcodeList })) }
      : null);
  }

  if (sku) {
    const bySku = await listProductsBySku(sku);
    console.log('listProductsBySku count:', bySku.length, bySku.map((p) => ({
      id: p.id,
      name: p.name,
      skus: (p.variants || []).map((v) => v.sku),
    })));
  }

  if (barcode) {
    const byBarcode = await listProductsByBarcode(barcode);
    console.log('listProductsByBarcode count:', byBarcode.length, byBarcode.map((p) => ({
      id: p.id,
      name: p.name,
      barcodes: (p.variants || []).map((v) => v.barcodeList),
      skus: (p.variants || []).map((v) => v.sku),
    })));
  }

  console.log('Katalog yükleniyor...');
  const catalog = await listAllProducts();
  const inCatalogById = productId
    ? catalog.find((p) => p.id === productId)
    : null;
  console.log('katalog size:', catalog.length);
  console.log('katalogda productId:', inCatalogById
    ? { id: inCatalogById.id, name: inCatalogById.name, variants: inCatalogById.variants }
    : null);

  if (barcode) {
    const hit = catalog.find((p) =>
      (p.variants || []).some((v) =>
        (v.barcodeList || []).some((b) => String(b?.barcode || b || '').trim() === String(barcode).trim()),
      ),
    );
    console.log('katalogda barcode:', hit
      ? { id: hit.id, name: hit.name, variants: hit.variants }
      : null);
  }

  if (sku) {
    const hit = catalog.find((p) =>
      (p.variants || []).some((v) => String(v.sku || '').trim() === String(sku).trim()),
    );
    console.log('katalogda sku:', hit
      ? { id: hit.id, name: hit.name, variants: hit.variants }
      : null);
  }

  const resolved = await findProductBySkuOrBarcode({ sku, barcode, products: catalog });
  console.log('findProductBySkuOrBarcode:', resolved
    ? {
      productId: resolved.product.id,
      name: resolved.product.name,
      variantId: resolved.variant.id,
      sku: resolved.variant.sku,
      barcodeList: resolved.variant.barcodeList,
    }
    : null);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
