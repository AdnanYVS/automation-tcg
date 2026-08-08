const express = require('express');
const { getWarehouseInventory } = require('../../services/warehouseInventory');
const { getSalesHistory } = require('../../services/salesHistory');
const { backfillIkasMappings, refreshMappingPriceSnapshots } = require('../../services/mappingBackfill');
const { getInventoryEvents, getInventoryEventSummary } = require('../../db');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.use(requireAuth);

router.get('/warehouse-inventory', async (req, res) => {
  try {
    const data = await getWarehouseInventory({
      locationId: req.query.locationId || null,
      search: req.query.search || null,
      inStockOnly: String(req.query.inStockOnly).toLowerCase() === 'true',
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/warehouse-inventory hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/inventory/sync-mappings', async (req, res) => {
  try {
    const withPrices = Boolean(req.body?.withPrices);
    const forceRelink = Boolean(req.body?.forceRelink);
    const mappingResult = await backfillIkasMappings({
      apply: true,
      withPrices,
      forceRelink,
    });
    let priceResult = null;
    if (withPrices) {
      priceResult = await refreshMappingPriceSnapshots({
        apply: true,
        onlyMissing: true,
      });
    }
    return res.json({
      success: true,
      data: {
        mappings: mappingResult.stats,
        prices: priceResult?.stats || null,
      },
    });
  } catch (error) {
    console.error('POST /api/inventory/sync-mappings hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sales-history', async (req, res) => {
  try {
    const data = await getSalesHistory({
      locationId: req.query.locationId || null,
      search: req.query.search || null,
      limit: req.query.limit ? Number(req.query.limit) : 200,
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/sales-history hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/inventory-events', (req, res) => {
  try {
    const events = getInventoryEvents({
      eventType: req.query.eventType || null,
      stockLocationId: req.query.locationId || null,
      limit: req.query.limit ? Number(req.query.limit) : 100,
    });
    const summary = getInventoryEventSummary();
    return res.json({ success: true, data: { events, summary } });
  } catch (error) {
    console.error('GET /api/inventory-events hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
