const {
  getAllMappings,
  findByIkasVariantId,
  findByKartfiyatCardId,
  insertMapping,
  updateMappingIkasIds,
  updateMappingPriceSnapshot,
  ensureQrTokenForMapping,
} = require('../db');
const { getCachedProductCatalog } = require('./ikas/products');
const { getCardById, getPriceChartingUsd, normalizePriceLabel } = require('./kartfiyat');
const { getUsdTryRate } = require('./exchangeRate');
const { calculateFinalPriceTry, getPriceMultiplierForCard } = require('./pricing');
const { buildQrUrl } = require('./qrToken');

function isAutomationProductSku(sku) {
  return /^KF-/i.test(String(sku || ''));
}

function parseAutomationSku(sku) {
  const normalized = String(sku || '').trim();
  const match = normalized.match(/^KF-(\d+)(?:-(.+))?$/i);
  if (!match) return null;

  const kartfiyatCardId = match[1];
  let priceLabel = null;

  if (match[2]) {
    const suffix = match[2];
    const gradedMatch = suffix.match(/^(PSA|BGS|CGC|SGC|ACE|TAG|GRADE)(\d+(?:\.\d+)?)$/i);
    if (gradedMatch) {
      const company = /^GRADE$/i.test(gradedMatch[1]) ? 'Grade' : gradedMatch[1].toUpperCase();
      priceLabel = normalizePriceLabel(`${company} ${gradedMatch[2]}`);
    } else {
      priceLabel = normalizePriceLabel(suffix.replace(/_/g, ' '));
    }
  }

  return { kartfiyatCardId, priceLabel };
}

function extractPriceLabelFromProduct(product) {
  const nameMatch = String(product?.name || '').match(
    /\[((?:PSA|BGS|CGC|SGC|ACE|TAG|Grade)\s+[\d.]+)\]/i,
  );
  if (nameMatch) {
    return normalizePriceLabel(nameMatch[1]);
  }
  return null;
}

function resolveIdentifiers({ product, variant }) {
  const parsed = parseAutomationSku(variant?.sku);
  if (!parsed) return null;

  const priceLabel = parsed.priceLabel || extractPriceLabelFromProduct(product);
  return {
    kartfiyatCardId: parsed.kartfiyatCardId,
    priceLabel,
    sku: variant.sku,
    barcode: variant.barcodeList?.[0] || null,
    cardName: product?.name || null,
    ikasProductId: product?.id,
    ikasVariantId: variant?.id,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enrichWithKartfiyatSnapshot(entry, { usdTryRate = null } = {}) {
  try {
    const card = await getCardById(entry.kartfiyatCardId);
    const { multiplier } = getPriceMultiplierForCard(card);
    const rate = usdTryRate || await getUsdTryRate();
    const usdPrice = getPriceChartingUsd(card, { label: entry.priceLabel });
    const tryPrice = usdPrice ? calculateFinalPriceTry(usdPrice, rate, multiplier) : null;

    return {
      cardName: card?.name || entry.cardName,
      usdPrice,
      tryPrice,
    };
  } catch (error) {
    return {
      cardName: entry.cardName,
      usdPrice: null,
      tryPrice: null,
      warning: error.message,
    };
  }
}

function createStats() {
  return {
    catalogVariants: 0,
    eligible: 0,
    created: 0,
    updated: 0,
    skippedMapped: 0,
    skippedConflict: 0,
    skippedInvalid: 0,
    failed: 0,
  };
}

async function backfillIkasMappings({
  apply = false,
  withPrices = false,
  forceRelink = false,
  kartfiyatDelayMs = Number(process.env.KARTFIYAT_REQUEST_DELAY_MS || 80),
} = {}) {
  const stats = createStats();
  const actions = [];
  const usdTryRate = withPrices ? await getUsdTryRate() : null;
  const catalog = await getCachedProductCatalog();
  const mappingsByVariantId = new Set(
    getAllMappings()
      .filter((mapping) => mapping.ikas_variant_id)
      .map((mapping) => mapping.ikas_variant_id),
  );

  for (const product of catalog) {
    for (const variant of product.variants || []) {
      stats.catalogVariants += 1;
      if (!variant?.id || !isAutomationProductSku(variant.sku)) continue;

      if (mappingsByVariantId.has(variant.id)) {
        stats.skippedMapped += 1;
        continue;
      }

      const entry = resolveIdentifiers({ product, variant });
      if (!entry?.kartfiyatCardId || !entry.ikasVariantId) {
        stats.skippedInvalid += 1;
        continue;
      }

      stats.eligible += 1;

      try {
        const existing = findByKartfiyatCardId(entry.kartfiyatCardId, { priceLabel: entry.priceLabel })
          || findByKartfiyatCardId(entry.kartfiyatCardId);

        let action = 'create';
        let mappingId = null;

        if (existing) {
          if (existing.ikas_variant_id && existing.ikas_variant_id !== entry.ikasVariantId) {
            if (!existing.ikas_missing && !forceRelink) {
              stats.skippedConflict += 1;
              actions.push({
                action: 'conflict',
                kartfiyatCardId: entry.kartfiyatCardId,
                sku: entry.sku,
                existingVariantId: existing.ikas_variant_id,
                incomingVariantId: entry.ikasVariantId,
              });
              continue;
            }
            action = 'update';
            mappingId = existing.id;
          } else {
            action = 'update';
            mappingId = existing.id;
          }
        }

        let snapshot = {
          cardName: entry.cardName,
          usdPrice: null,
          tryPrice: null,
        };

        if (withPrices) {
          snapshot = await enrichWithKartfiyatSnapshot(entry, { usdTryRate });
          if (kartfiyatDelayMs > 0) await sleep(kartfiyatDelayMs);
        }

        if (!apply) {
          if (action === 'create') stats.created += 1;
          else stats.updated += 1;
          actions.push({
            action,
            kartfiyatCardId: entry.kartfiyatCardId,
            sku: entry.sku,
            cardName: snapshot.cardName,
            priceLabel: entry.priceLabel,
          });
          continue;
        }

        if (action === 'create') {
          const created = insertMapping({
            ikasVariantId: entry.ikasVariantId,
            kartfiyatCardId: entry.kartfiyatCardId,
            ikasProductId: entry.ikasProductId,
            barcode: entry.barcode,
            sku: entry.sku,
            priceLabel: entry.priceLabel,
          });
          mappingId = created.id;
          stats.created += 1;
        } else {
          updateMappingIkasIds({
            mappingId,
            ikasProductId: entry.ikasProductId,
            ikasVariantId: entry.ikasVariantId,
            sku: entry.sku,
            barcode: entry.barcode,
            clearMissing: true,
          });
          stats.updated += 1;
        }

        if (snapshot.cardName || snapshot.usdPrice || snapshot.tryPrice) {
          updateMappingPriceSnapshot({
            mappingId,
            cardName: snapshot.cardName,
            usdPrice: snapshot.usdPrice,
            tryPrice: snapshot.tryPrice,
          });
        }

        const qrToken = ensureQrTokenForMapping(mappingId);
        mappingsByVariantId.add(entry.ikasVariantId);

        actions.push({
          action,
          mappingId,
          kartfiyatCardId: entry.kartfiyatCardId,
          sku: entry.sku,
          qrUrl: buildQrUrl(qrToken),
        });
      } catch (error) {
        stats.failed += 1;
        actions.push({
          action: 'failed',
          kartfiyatCardId: entry.kartfiyatCardId,
          sku: entry.sku,
          error: error.message,
        });
      }
    }
  }

  return { stats, actions, apply };
}

async function refreshMappingPriceSnapshots({
  apply = true,
  onlyMissing = true,
  kartfiyatDelayMs = Number(process.env.KARTFIYAT_REQUEST_DELAY_MS || 80),
} = {}) {
  const stats = { total: 0, updated: 0, skipped: 0, failed: 0 };
  const usdTryRate = await getUsdTryRate();
  const mappings = getAllMappings().filter((mapping) => {
    if (!mapping.kartfiyat_card_id) return false;
    if (onlyMissing && Number(mapping.last_try_price) > 0) return false;
    return true;
  });

  stats.total = mappings.length;

  for (const mapping of mappings) {
    try {
      const entry = {
        kartfiyatCardId: mapping.kartfiyat_card_id,
        priceLabel: mapping.price_label || null,
        cardName: mapping.card_name,
      };
      const snapshot = await enrichWithKartfiyatSnapshot(entry, { usdTryRate });

      if (!snapshot.usdPrice && !snapshot.tryPrice) {
        stats.skipped += 1;
        continue;
      }

      if (apply) {
        updateMappingPriceSnapshot({
          mappingId: mapping.id,
          cardName: snapshot.cardName,
          usdPrice: snapshot.usdPrice,
          tryPrice: snapshot.tryPrice,
        });
      }
      stats.updated += 1;
      if (kartfiyatDelayMs > 0) await sleep(kartfiyatDelayMs);
    } catch (error) {
      stats.failed += 1;
    }
  }

  return { stats, apply, onlyMissing };
}

module.exports = {
  backfillIkasMappings,
  refreshMappingPriceSnapshots,
  parseAutomationSku,
  isAutomationProductSku,
};
