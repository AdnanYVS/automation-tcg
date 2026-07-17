const express = require('express');
const {
  runPriceCheck,
  approvePriceChange,
  rejectPriceChange,
  approveAllPendingPriceChanges,
  rejectAllPendingPriceChanges,
  bulkResolvePendingPriceChanges,
  getPriceDashboardData,
} = require('../../services/priceTracking');
const { getPortfolioValuation } = require('../../services/portfolioValuation');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.use(requireAuth);

function normalizeBulkFilter(value) {
  const filter = String(value || 'all').trim().toLowerCase();
  if (['all', 'rising', 'falling'].includes(filter)) return filter;
  return null;
}

router.get('/price-changes', (req, res) => {
  try {
    const data = getPriceDashboardData();
    return res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/price-changes hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/price-changes/check-now', async (req, res) => {
  try {
    const summary = await runPriceCheck();
    const data = getPriceDashboardData();
    return res.json({ success: true, data: { summary, ...data } });
  } catch (error) {
    console.error('POST /api/price-changes/check-now hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/price-changes/bulk', async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim().toLowerCase();
    const filter = normalizeBulkFilter(req.body?.filter);
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, error: 'action approve veya reject olmalı.' });
    }
    if (!filter) {
      return res.status(400).json({ success: false, error: 'filter all, rising veya falling olmalı.' });
    }

    const result = await bulkResolvePendingPriceChanges({ action, filter });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('POST /api/price-changes/bulk hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/price-changes/approve-all', async (req, res) => {
  try {
    const filter = normalizeBulkFilter(req.body?.filter) || 'all';
    const result = await approveAllPendingPriceChanges(filter);
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('POST /api/price-changes/approve-all hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/price-changes/reject-all', async (req, res) => {
  try {
    const filter = normalizeBulkFilter(req.body?.filter) || 'all';
    const result = await rejectAllPendingPriceChanges(filter);
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('POST /api/price-changes/reject-all hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/price-changes/:id/approve', async (req, res) => {
  try {
    const alert = await approvePriceChange(Number(req.params.id));
    return res.json({ success: true, data: alert });
  } catch (error) {
    console.error('POST /api/price-changes/:id/approve hatası:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/price-changes/:id/reject', async (req, res) => {
  try {
    const alert = await rejectPriceChange(Number(req.params.id));
    return res.json({ success: true, data: alert });
  } catch (error) {
    console.error('POST /api/price-changes/:id/reject hatası:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/portfolio-valuation', async (req, res) => {
  try {
    const data = await getPortfolioValuation();
    return res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/portfolio-valuation hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
