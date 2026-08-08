const express = require('express');
const { getSessionUser } = require('../../services/auth');
const { getQrCardPayload, recordStoreSale, getLabelPayload } = require('../../services/qrCards');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.get('/qr/:token', async (req, res) => {
  try {
    const user = getSessionUser(req);
    const card = await getQrCardPayload(req.params.token, { isAdmin: Boolean(user) });
    if (!card) {
      return res.status(404).json({ success: false, error: 'Kart bulunamadı.' });
    }
    return res.json({ success: true, data: card });
  } catch (error) {
    console.error('GET /api/qr/:token hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/qr/:token/sell', requireAuth, async (req, res) => {
  try {
    const result = await recordStoreSale(req.params.token, {
      stockLocationId: req.body.stockLocationId,
      sellPriceTry: req.body.sellPrice,
      note: req.body.note,
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('POST /api/qr/:token/sell hatası:', error.message);
    const status = /stok|geçersiz|bulunamadı/i.test(error.message) ? 400 : 500;
    return res.status(status).json({ success: false, error: error.message });
  }
});

router.get('/qr-labels/preview', requireAuth, async (req, res) => {
  try {
    const payload = getLabelPayload({
      token: req.query.token || null,
      mappingId: req.query.mappingId ? Number(req.query.mappingId) : null,
    });
    if (!payload) {
      return res.status(404).json({ success: false, error: 'Etiket için kart bulunamadı.' });
    }
    return res.json({ success: true, data: payload });
  } catch (error) {
    console.error('GET /api/qr-labels/preview hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
