const express = require('express');
const { searchCards, getCardById, getPriceChartingUsd, getCardPriceInfo, getCardImageUrl } = require('../../services/kartfiyat');
const { getSetCodeRegistry } = require('../../services/kartfiyat/setRegistry');
const { createBasicProduct, listStockLocations, resolveCategoryForCard, incrementVariantStock } = require('../../services/ikas');
const { DEFAULT_BRAND_NAME } = require('../../services/ikas/brands');
const { getUsdTryRate } = require('../../services/exchangeRate');
const { calculateFinalPriceTry } = require('../../services/pricing');
const { generateProductBarcode } = require('../../services/barcode');
const { insertMapping, findByKartfiyatCardId, updateMappingPriceSnapshot, insertInventoryEvent } = require('../../db');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.use(requireAuth);

router.get('/set-codes', async (req, res) => {
  try {
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

router.get('/search-card', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    if (query.length < 2) {
      return res.status(400).json({ success: false, error: 'query parametresi en az 2 karakter olmalıdır.' });
    }

    const perPage = req.query.perPage ? Number(req.query.perPage) : 20;

    const result = await searchCards({
      q: query,
      page: req.query.page ? Number(req.query.page) : 1,
      perPage,
      categoryId: req.query.categoryId ? Number(req.query.categoryId) : undefined,
      game: req.query.game || 'pokemon',
      market: req.query.market,
    });

    const items = result.items.map((card) => ({
      id: card.id,
      name: card.name,
      code: card.code,
      category: card.category,
      images: card.images,
      priceInfo: getCardPriceInfo(card),
    }));

    return res.json({
      success: true,
      data: {
        items,
        pagination: result.pagination,
        searchMode: result.searchMode || 'text',
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

    const existing = findByKartfiyatCardId(kartfiyatCardId);
    if (existing?.ikas_product_id && existing?.ikas_variant_id) {
      const stockResult = await incrementVariantStock({
        productId: existing.ikas_product_id,
        variantId: existing.ikas_variant_id,
        stockLocationId,
        incrementBy: stockCount,
      });

      insertInventoryEvent({
        mappingId: existing.id,
        kartfiyatCardId,
        ikasVariantId: existing.ikas_variant_id,
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
          ikasVariantId: existing.ikas_variant_id,
          stockLocationId,
          previousStock: stockResult.previousStock,
          newStock: stockResult.newStock,
          incrementBy: stockResult.incrementBy,
        },
      });
    }

    const card = await getCardById(kartfiyatCardId);
    const name = req.body.name || card.name;
    if (!name) return res.status(400).json({ success: false, error: 'Ürün adı bulunamadı.' });

    const sku = req.body.code || card.code || `KF-${kartfiyatCardId}`;
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
      const usdPrice = getPriceChartingUsd(card);
      if (!usdPrice) {
        return res.status(400).json({
          success: false,
          error: 'PriceCharting USD fiyatı bulunamadı. sellPrice alanını manuel gönderin.',
        });
      }
      sellPrice = calculateFinalPriceTry(
        usdPrice,
        await getUsdTryRate(),
        Number(process.env.FINAL_COST_MULTIPLIER || 1.86),
      );
    }

    const imageUrl = req.body.imageUrl || getCardImageUrl(card);

    const category = await resolveCategoryForCard(card);
    const barcode = generateProductBarcode(kartfiyatCardId);

    const product = await createBasicProduct({
      name,
      sku,
      sellPrice,
      stockCount,
      stockLocationId,
      currency: 'TRY',
      imageUrl,
      categoryName: category.name,
      categoryPath: category.path,
      brandName: DEFAULT_BRAND_NAME,
      barcode,
    });
    const variant = product.variants?.[0];
    if (!variant?.id || !product.id) {
      throw new Error('ikas ürün yanıtında productId veya variantId bulunamadı.');
    }

    const mapping = insertMapping({
      ikasVariantId: variant.id,
      ikasProductId: product.id,
      kartfiyatCardId,
      barcode,
      priceManual: hasManualSellPrice,
    });

    if (hasManualSellPrice) {
      updateMappingPriceSnapshot({
        mappingId: mapping.id,
        cardName: name,
        usdPrice: null,
        tryPrice: sellPrice,
      });
    } else {
      const usdPrice = getPriceChartingUsd(card);
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
      note: hasManualSellPrice ? 'Yeni ürün (manuel fiyat)' : 'Yeni ürün',
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
