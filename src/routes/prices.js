const express = require('express');
const {
  runPriceCheck,
  approvePriceChange,
  rejectPriceChange,
  approveAllPendingPriceChanges,
  getPriceDashboardData,
} = require('../../services/priceTracking');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.use(requireAuth);

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

router.post('/price-changes/approve-all', async (req, res) => {
  try {
    const result = await approveAllPendingPriceChanges();
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('POST /api/price-changes/approve-all hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
