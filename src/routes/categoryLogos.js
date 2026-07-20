const express = require('express');
const {
  buildCategoryLogoPreview,
  approveCategoryLogos,
  approveAllWithImages,
  rejectCategoryLogos,
  uploadApprovedCategoryLogos,
} = require('../../services/categoryLogos');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.use(requireAuth);

router.get('/category-logos/preview', async (req, res) => {
  try {
    const data = await buildCategoryLogoPreview();
    return res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/category-logos/preview hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/category-logos/approve', async (req, res) => {
  try {
    const categoryIds = Array.isArray(req.body.categoryIds) ? req.body.categoryIds : [];

    if (req.body.approveAll) {
      const result = await approveAllWithImages();
      const data = await buildCategoryLogoPreview();
      return res.json({
        success: true,
        data: {
          approvedCount: result.approvedCount,
          preview: data,
        },
      });
    }

    if (!categoryIds.length) {
      return res.status(400).json({
        success: false,
        error: 'categoryIds boş olamaz. approveAll:true gönderebilirsiniz.',
      });
    }

    approveCategoryLogos({ categoryIds });
    const data = await buildCategoryLogoPreview();
    return res.json({ success: true, data });
  } catch (error) {
    console.error('POST /api/category-logos/approve hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/category-logos/reject', async (req, res) => {
  try {
    const categoryIds = Array.isArray(req.body.categoryIds) ? req.body.categoryIds : [];
    if (!categoryIds.length) {
      return res.status(400).json({ success: false, error: 'categoryIds zorunludur.' });
    }

    rejectCategoryLogos({ categoryIds });
    const data = await buildCategoryLogoPreview();
    return res.json({ success: true, data });
  } catch (error) {
    console.error('POST /api/category-logos/reject hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/category-logos/upload', async (req, res) => {
  try {
    const stats = await uploadApprovedCategoryLogos({
      delayMs: Number(process.env.IKAS_CATEGORY_LOGO_DELAY_MS || 400),
    });
    const data = await buildCategoryLogoPreview();
    return res.json({
      success: true,
      data: {
        stats,
        preview: data,
      },
    });
  } catch (error) {
    console.error('POST /api/category-logos/upload hatası:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
