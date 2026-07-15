const express = require('express');
const {
  searchCards,
  getCardById,
  getPriceChartingUsd,
  getCardPriceInfo,
  getGradedPrices,
  getCardPricesPayload,
  getCardImageUrl,
  normalizePriceLabel,
  isGradedPriceLabel,
} = require('../../services/kartfiyat');
const { getSetCodeRegistry } = require('../../services/kartfiyat/setRegistry');
const { getOnePieceSetCodeRegistry } = require('../../services/kartfiyat/onepieceSetRegistry');
const { createBasicProduct, listStockLocations, resolveCategoryForCard, incrementVariantStock } = require('../../services/ikas');
const {
  ensurePokemonShopTaxonomy,
  resolvePokemonShopCategories,
} = require('../../services/ikas/pokemonShopCategories');
const {
  ensureOnePieceShopTaxonomy,
  resolveOnePieceShopCategories,
} = require('../../services/ikas/onePieceShopCategories');
const { getUsdTryRate } = require('../../services/exchangeRate');
const { calculateFinalPriceTry, getPriceMultiplierForCard } = require('../../services/pricing');
const { generateProductBarcode } = require('../../services/barcode');
const { insertMapping, findByKartfiyatCardId, updateMappingPriceSnapshot, updateMappingIkasIds, insertInventoryEvent } = require('../../db');
const { getSupportedGames, normalizeGameId } = require('../../services/ikas/taxonomy');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

function buildGradedProductName(baseName, priceLabel) {
  const normalized = normalizePriceLabel(priceLabel);
  if (!normalized) return baseName;

  const suffix = ` [${normalized}]`;
  return String(baseName || '').includes(suffix) ? baseName : `${baseName}${suffix}`;
}

function buildGradedSku(baseSku, priceLabel) {
  const normalized = normalizePriceLabel(priceLabel);
  if (!normalized) return baseSku;
  return `${baseSku}-${normalized.replace(/\s+/g, '').toUpperCase()}`;
}

router.use(requireAuth);

router.get('/set-codes', async (req, res) => {
  try {
    const game = normalizeGameId(req.query.game || 'pokemon');

    if (game === 'onepiece') {
      const registry = await getOnePieceSetCodeRegistry();
      const codes = Object.values(registry.codes || {}).map((entry) => ({
        setCode: entry.setCode,
        setName: entry.setName,
        categoryName: entry.categoryName,
        categoryId: entry.categoryId,
        source: entry.source || null,
        language: entry.language || 'en',
        game: 'onepiece',
      })).filter((entry, index, list) =>
        list.findIndex((item) => item.setCode === entry.setCode && item.language === entry.language) === index,
      );

      return res.json({
        success: true,
        data: {
          game: 'onepiece',
          updatedAt: registry.updatedAt,
          totalCodes: registry.totalCodes,
          totalEnglishCategories: registry.totalEnglishCategories,
          coveredEnglishCategories: registry.coveredEnglishCategories,
          totalJapaneseCategories: registry.totalJapaneseCategories,
          coveredJapaneseCategories: registry.coveredJapaneseCategories,
          englishCodeCount: registry.englishCodeCount,
          japaneseCodeCount: registry.japaneseCodeCount,
          sources: registry.sources,
          codes,
        },
      });
    }

    const registry = await getSetCodeRegistry();
    const codes = Object.values(registry.codes || {}).map((entry) => ({
      setCode: entry.setCode,
      setName: entry.setName,
      categoryName: entry.categoryName,
      categoryId: entry.categoryId,
      source: entry.source || null,
      language: entry.language || 'ja',
    })).filter((entry, index, list) =>
      list.findIndex((item) => item.setCode === entry.setCode && item.language === entry.language) === index,
    );

    return res.json({
      success: true,
      data: {
        game: 'pokemon',
        updatedAt: registry.updatedAt,
        totalCodes: registry.totalCodes,
        totalCategories: registry.totalCategories,
        coveredCategories: registry.coveredCategories,
        totalEnglishCategories: registry.totalEnglishCategories,
        coveredEnglishCategories: registry.coveredEnglishCategories,
        englishCodeCount: registry.englishCodeCount,
        japaneseCodeCount: registry.japaneseCodeCount,
        sources: registry.sources,
        codes,
      },
    });
  } catch (error) {
    console.error('GET /api/set-codes hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/games', (req, res) => {
  return res.json({
    success: true,
    data: getSupportedGames().map((game) => ({
      id: game.id,
      label: game.brandName,
      kartfiyatGame: game.kartfiyatGame,
      rootCategoryName: game.rootCategoryName,
    })),
  });
});

router.get('/search-card', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    if (query.length < 2) {
      return res.status(400).json({ success: false, error: 'query parametresi en az 2 karakter olmalıdır.' });
    }

    const perPage = req.query.perPage ? Number(req.query.perPage) : 20;
    const game = normalizeGameId(req.query.game || 'pokemon');
    const supportedGame = getSupportedGames().find((entry) => entry.id === game);
    if (!supportedGame) {
      return res.status(400).json({ success: false, error: `Desteklenmeyen oyun: ${req.query.game}` });
    }

    const result = await searchCards({
      q: query,
      page: req.query.page ? Number(req.query.page) : 1,
      perPage,
      categoryId: req.query.categoryId ? Number(req.query.categoryId) : undefined,
      game: supportedGame.kartfiyatGame,
      market: req.query.market,
    });

    const items = result.items.map((card) => {
      const gradedPrices = getGradedPrices(card)
        .filter((entry) => entry.company === 'PSA')
        .slice(0, 3)
        .map((entry) => ({
          label: entry.label,
          usd: entry.usd,
          formattedUsd: entry.formattedUsd,
        }));

      return {
        id: card.id,
        name: card.name,
        code: card.code,
        category: card.category,
        images: card.images,
        priceInfo: getCardPriceInfo(card),
        gradedPrices,
        gradedCount: getGradedPrices(card).length,
      };
    });

    return res.json({
      success: true,
      data: {
        items,
        pagination: result.pagination,
        searchMode: result.searchMode || 'text',
        game: supportedGame.id,
        setCode: result.setCode || null,
        cardNumber: result.cardNumber || null,
        category: result.category || null,
      },
    });
  } catch (error) {
    console.error('GET /api/search-card hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/cards/:id/prices', async (req, res) => {
  try {
    const card = await getCardById(req.params.id);
    const usdTryRate = await getUsdTryRate();
    const { multiplier, gameId, gameLabel } = getPriceMultiplierForCard(card);

    return res.json({
      success: true,
      data: {
        ...getCardPricesPayload(card, { usdTryRate, multiplier }),
        gameId,
        gameLabel,
      },
    });
  } catch (error) {
    console.error('GET /api/cards/:id/prices hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/stock-locations', async (req, res) => {
  try {
    const locations = await listStockLocations();
    return res.json({ success: true, data: locations });
  } catch (error) {
    console.error('GET /api/stock-locations hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/import-card', async (req, res) => {
  try {
    const cardId = req.body.cardId ?? req.body.id;
    if (!cardId) return res.status(400).json({ success: false, error: 'cardId zorunludur.' });

    const kartfiyatCardId = String(cardId);
    const priceLabel = normalizePriceLabel(req.body.priceLabel);
    const stockLocationId = req.body.stockLocationId;
    if (!stockLocationId) {
      return res.status(400).json({
        success: false,
        error: 'stockLocationId zorunludur. İstanbul veya İzmir stok lokasyonunu seçin.',
      });
    }

    const stockCount = req.body.stockCount !== undefined ? Number(req.body.stockCount) : 1;
    if (!Number.isFinite(stockCount) || stockCount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'stockCount pozitif bir sayı olmalıdır.',
      });
    }

    const existing = findByKartfiyatCardId(kartfiyatCardId, { priceLabel });
    let brokenExistingMapping = null;
    if (existing?.ikas_product_id && existing?.ikas_variant_id) {
      try {
        const expectedSku = buildGradedSku(
          req.body.code || `KF-${kartfiyatCardId}`,
          priceLabel,
        );
        const stockResult = await incrementVariantStock({
          productId: existing.ikas_product_id,
          variantId: existing.ikas_variant_id,
          stockLocationId,
          incrementBy: stockCount,
          sku: expectedSku,
        });

        if (stockResult.variantChanged && stockResult.variantId) {
          updateMappingIkasIds({
            mappingId: existing.id,
            ikasVariantId: stockResult.variantId,
          });
        }

        insertInventoryEvent({
          mappingId: existing.id,
          kartfiyatCardId,
          ikasVariantId: stockResult.variantId || existing.ikas_variant_id,
          stockLocationId,
          quantity: stockCount,
          eventType: 'import',
          note: 'Stok artırımı',
        });

        return res.json({
          success: true,
          data: {
            action: 'stock_incremented',
            mappingId: existing.id,
            kartfiyatCardId,
            ikasProductId: existing.ikas_product_id,
            ikasVariantId: stockResult.variantId || existing.ikas_variant_id,
            stockLocationId,
            previousStock: stockResult.previousStock,
            newStock: stockResult.newStock,
            incrementBy: stockResult.incrementBy,
            variantChanged: Boolean(stockResult.variantChanged),
          },
        });
      } catch (error) {
        const isMissingProduct = /ürünü bulunamadı|INVALID_VARIANT_ID|varyant bulunamadı/i.test(error.message);
        if (!isMissingProduct) {
          throw error;
        }
        brokenExistingMapping = existing;
        console.warn(
          `[import] Mevcut mapping stok güncellenemedi (${kartfiyatCardId}): ${error.message}. Yeni ürün oluşturulacak.`,
        );
      }
    }

    const card = await getCardById(kartfiyatCardId);
    const { multiplier, gameId, gameLabel } = getPriceMultiplierForCard(card);
    const baseName = req.body.name || card.name;
    const name = buildGradedProductName(baseName, priceLabel);
    if (!name) return res.status(400).json({ success: false, error: 'Ürün adı bulunamadı.' });

    const baseSku = req.body.code || card.code || `KF-${kartfiyatCardId}`;
    const sku = buildGradedSku(baseSku, priceLabel);
    const hasManualSellPrice = req.body.sellPrice !== undefined
      && req.body.sellPrice !== null
      && String(req.body.sellPrice).trim() !== '';
    let sellPrice = hasManualSellPrice ? Number(req.body.sellPrice) : null;

    if (hasManualSellPrice && (!Number.isFinite(sellPrice) || sellPrice <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'sellPrice pozitif bir sayı olmalıdır.',
      });
    }

    if (!hasManualSellPrice) {
      const usdPrice = getPriceChartingUsd(card, { label: priceLabel });
      if (!usdPrice) {
        return res.status(400).json({
          success: false,
          error: 'Seçilen fiyat etiketi için PriceCharting USD fiyatı bulunamadı. sellPrice alanını manuel gönderin.',
        });
      }
      sellPrice = calculateFinalPriceTry(
        usdPrice,
        await getUsdTryRate(),
        multiplier,
      );
    }

    const imageUrl = req.body.imageUrl || getCardImageUrl(card);

    const category = await resolveCategoryForCard(card);
    let productCategoryPlan;
    if (category.game === 'pokemon') {
      await ensurePokemonShopTaxonomy({ allowCreate: true });
      const shopPlacement = resolvePokemonShopCategories(card, { priceLabel, productName: name });
      productCategoryPlan = {
        ...shopPlacement,
        kind: shopPlacement.productType,
        navigation: [],
        gameId: 'pokemon',
      };
    } else if (category.game === 'onepiece') {
      await ensureOnePieceShopTaxonomy({ allowCreate: true });
      const shopPlacement = resolveOnePieceShopCategories(card, { priceLabel, productName: name });
      productCategoryPlan = {
        ...shopPlacement,
        kind: shopPlacement.productType,
        navigation: [],
        gameId: 'onepiece',
      };
    } else {
      // Riftbound vb. desteklenmeyen oyunlar: set leaf + kendi kök/brand
      productCategoryPlan = {
        categories: [{
          name: category.name,
          path: category.productCategoryPath?.length
            ? category.productCategoryPath
            : [category.brandName || category.name],
        }],
        kind: 'external',
        navigation: [],
        gameId: category.game,
      };
    }
    const barcodeSource = priceLabel ? `${kartfiyatCardId}:${priceLabel}` : kartfiyatCardId;
    const barcode = generateProductBarcode(barcodeSource);

    const product = await createBasicProduct({
      name,
      sku,
      sellPrice,
      stockCount,
      stockLocationId,
      currency: 'TRY',
      imageUrl,
      categories: productCategoryPlan.categories,
      brandName: category.brandName,
      barcode,
    });
    const variant = product.variants?.[0];
    if (!variant?.id || !product.id) {
      throw new Error('ikas ürün yanıtında productId veya variantId bulunamadı.');
    }

    let mapping;
    if (brokenExistingMapping?.id) {
      updateMappingIkasIds({
        mappingId: brokenExistingMapping.id,
        ikasProductId: product.id,
        ikasVariantId: variant.id,
      });
      mapping = { id: brokenExistingMapping.id };
    } else {
      mapping = insertMapping({
        ikasVariantId: variant.id,
        ikasProductId: product.id,
        kartfiyatCardId,
        barcode,
        priceManual: hasManualSellPrice,
        priceLabel,
      });
    }

    if (hasManualSellPrice) {
      updateMappingPriceSnapshot({
        mappingId: mapping.id,
        cardName: name,
        usdPrice: null,
        tryPrice: sellPrice,
      });
    } else {
      const usdPrice = getPriceChartingUsd(card, { label: priceLabel });
      if (usdPrice) {
        updateMappingPriceSnapshot({
          mappingId: mapping.id,
          cardName: name,
          usdPrice,
          tryPrice: sellPrice,
        });
      }
    }

    insertInventoryEvent({
      mappingId: mapping.id,
      kartfiyatCardId,
      ikasVariantId: variant.id,
      stockLocationId,
      quantity: stockCount,
      eventType: 'import',
      note: hasManualSellPrice
        ? (priceLabel ? `Yeni graded ürün (manuel fiyat: ${priceLabel})` : 'Yeni ürün (manuel fiyat)')
        : (priceLabel ? `Yeni graded ürün (${priceLabel})` : 'Yeni ürün'),
    });

    return res.status(201).json({
      success: true,
      data: {
        action: 'created',
        mappingId: mapping.id,
        kartfiyatCardId,
        ikasProductId: product.id,
        ikasVariantId: variant.id,
        name: product.name,
        sku: variant.sku,
        barcode: variant.barcodeList?.[0] || barcode,
        sellPrice,
        priceManual: hasManualSellPrice,
        priceLabel,
        isGraded: Boolean(priceLabel && isGradedPriceLabel(priceLabel)),
        multiplier: hasManualSellPrice ? null : multiplier,
        gameId,
        gameLabel,
        productKind: productCategoryPlan.kind,
        navigationCategories: productCategoryPlan.navigation.map((entry) => entry.name),
        categories: productCategoryPlan.categories.map((entry) => ({
          name: entry.name,
          path: entry.path,
        })),
        category: {
          id: category.id,
          name: category.name,
          isJapanese: category.isJapanese,
          created: category.created,
        },
      },
    });
  } catch (error) {
    console.error('POST /api/import-card hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
