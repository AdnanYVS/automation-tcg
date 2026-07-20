const fs = require('fs');
const path = require('path');
const { listCategories: listKartfiyatCategories } = require('./kartfiyat/categories');
const { listCategories: listIkasCategories } = require('./ikas/categories');
const { uploadCategoryImage } = require('./ikas/images');

const APPROVALS_PATH = process.env.CATEGORY_LOGO_APPROVALS_PATH
  || path.join(__dirname, '../data/category-logo-approvals.json');

const ROOT_CATEGORY_NAMES = new Set(['pokemon']);

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDataDir() {
  const dir = path.dirname(APPROVALS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadApprovals() {
  ensureDataDir();
  if (!fs.existsSync(APPROVALS_PATH)) {
    return { updatedAt: null, items: {} };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(APPROVALS_PATH, 'utf8'));
    return {
      updatedAt: raw.updatedAt || null,
      items: raw.items || {},
    };
  } catch {
    return { updatedAt: null, items: {} };
  }
}

function saveApprovals(data) {
  ensureDataDir();
  const payload = {
    updatedAt: new Date().toISOString(),
    items: data.items || {},
  };
  fs.writeFileSync(APPROVALS_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

function isLeafIkasCategory(category) {
  if (!category?.name) return false;
  if (ROOT_CATEGORY_NAMES.has(normalizeName(category.name))) return false;
  return Boolean(category.parentId);
}

async function buildCategoryLogoPreview({ refreshKartfiyat = false } = {}) {
  const [kartfiyatCategories, ikasCategories, approvals] = await Promise.all([
    listKartfiyatCategories(),
    listIkasCategories({ refresh: true }),
    Promise.resolve(loadApprovals()),
  ]);

  const kartfiyatByName = new Map();
  for (const category of kartfiyatCategories) {
    if (!category?.image) continue;
    kartfiyatByName.set(normalizeName(category.name), category);
  }

  const items = [];
  const leafCategories = ikasCategories.filter(isLeafIkasCategory);

  for (const ikasCategory of leafCategories) {
    const kartfiyatCategory = kartfiyatByName.get(normalizeName(ikasCategory.name));
    const approval = approvals.items[ikasCategory.id] || {};
    const hasImage = Boolean(kartfiyatCategory?.image);

    items.push({
      ikasCategoryId: ikasCategory.id,
      ikasCategoryName: ikasCategory.name,
      ikasParentId: ikasCategory.parentId,
      kartfiyatCategoryId: kartfiyatCategory?.id || null,
      kartfiyatCategoryName: kartfiyatCategory?.name || null,
      imageUrl: kartfiyatCategory?.image || null,
      hasImage,
      status: approval.status || (hasImage ? 'pending' : 'missing'),
      approvedAt: approval.approvedAt || null,
      uploadedAt: approval.uploadedAt || null,
      uploadError: approval.uploadError || null,
      rejectedAt: approval.rejectedAt || null,
    });
  }

  items.sort((left, right) => left.ikasCategoryName.localeCompare(right.ikasCategoryName, 'tr'));

  const summary = {
    totalIkasSets: items.length,
    withKartfiyatImage: items.filter((item) => item.hasImage).length,
    missingKartfiyatImage: items.filter((item) => !item.hasImage).length,
    pending: items.filter((item) => item.status === 'pending').length,
    approved: items.filter((item) => item.status === 'approved').length,
    rejected: items.filter((item) => item.status === 'rejected').length,
    uploaded: items.filter((item) => item.status === 'uploaded').length,
    failed: items.filter((item) => item.status === 'failed').length,
  };

  return {
    generatedAt: new Date().toISOString(),
    approvalsUpdatedAt: approvals.updatedAt,
    summary,
    items,
  };
}

function setApprovalStatus(ikasCategoryId, status, extra = {}) {
  const approvals = loadApprovals();
  approvals.items[ikasCategoryId] = {
    status,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  return saveApprovals(approvals);
}

function approveCategoryLogos({ categoryIds = [], approveAll = false } = {}) {
  const approvals = loadApprovals();

  if (approveAll) {
    // Will be merged with preview data in route - here we just mark pattern
    return approvals;
  }

  for (const categoryId of categoryIds) {
    approvals.items[categoryId] = {
      status: 'approved',
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return saveApprovals(approvals);
}

async function approveAllWithImages() {
  const preview = await buildCategoryLogoPreview();
  const approvals = loadApprovals();

  for (const item of preview.items) {
    if (!item.hasImage) continue;
    if (item.status === 'uploaded') continue;

    approvals.items[item.ikasCategoryId] = {
      status: 'approved',
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    saved: saveApprovals(approvals),
    approvedCount: preview.items.filter((item) => item.hasImage && item.status !== 'uploaded').length,
  };
}

function rejectCategoryLogos({ categoryIds = [] } = {}) {
  const approvals = loadApprovals();

  for (const categoryId of categoryIds) {
    approvals.items[categoryId] = {
      status: 'rejected',
      rejectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return saveApprovals(approvals);
}

async function uploadApprovedCategoryLogos({ delayMs = 400 } = {}) {
  const preview = await buildCategoryLogoPreview();
  const toUpload = preview.items.filter((item) =>
    item.hasImage && (item.status === 'approved' || item.status === 'failed'),
  );

  const stats = {
    total: toUpload.length,
    uploaded: 0,
    failed: 0,
    skipped: preview.items.length - toUpload.length,
    failures: [],
  };

  for (const item of toUpload) {
    try {
      await uploadCategoryImage({
        categoryIds: [item.ikasCategoryId],
        imageUrl: item.imageUrl,
      });

      setApprovalStatus(item.ikasCategoryId, 'uploaded', {
        uploadedAt: new Date().toISOString(),
        uploadError: null,
        imageUrl: item.imageUrl,
      });
      stats.uploaded += 1;
    } catch (error) {
      setApprovalStatus(item.ikasCategoryId, 'failed', {
        uploadError: error.message,
        imageUrl: item.imageUrl,
      });
      stats.failed += 1;
      stats.failures.push({
        ikasCategoryId: item.ikasCategoryId,
        ikasCategoryName: item.ikasCategoryName,
        reason: error.message,
      });
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  return stats;
}

module.exports = {
  APPROVALS_PATH,
  buildCategoryLogoPreview,
  approveCategoryLogos,
  approveAllWithImages,
  rejectCategoryLogos,
  uploadApprovedCategoryLogos,
  loadApprovals,
};
