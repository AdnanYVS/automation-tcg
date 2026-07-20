require('dotenv').config();

const axios = require('axios');
const { getAccessToken } = require('./auth');

const IMAGE_UPLOAD_URL = process.env.IKAS_IMAGE_UPLOAD_URL
  || 'https://api.myikas.com/api/v1/admin/product/upload/image';

async function uploadProductImage({ variantIds, imageUrl, order = 1, isMain = true }) {
  if (!variantIds?.length || !imageUrl) {
    throw new Error('Görsel yüklemek için variantIds ve imageUrl zorunludur.');
  }

  try {
    const accessToken = await getAccessToken();

    const response = await axios.post(
      IMAGE_UPLOAD_URL,
      {
        productImage: {
          variantIds,
          url: imageUrl,
          order,
          isMain,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 60000,
      },
    );

    return response.data;
  } catch (error) {
    const message = error.response?.data?.message
      || error.response?.data?.error
      || error.message;

    console.error('ikas görsel yükleme başarısız:', message);
    throw new Error(`ikas görsel yükleme başarısız: ${message}`);
  }
}

async function uploadCategoryImage({ categoryIds, imageUrl }) {
  if (!categoryIds?.length || !imageUrl) {
    throw new Error('Kategori görseli için categoryIds ve imageUrl zorunludur.');
  }

  try {
    const accessToken = await getAccessToken();

    const response = await axios.post(
      IMAGE_UPLOAD_URL,
      {
        categoryImage: {
          categoryIds,
          url: imageUrl,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 60000,
      },
    );

    return response.data;
  } catch (error) {
    const message = error.response?.data?.message
      || error.response?.data?.error
      || error.message;

    console.error('ikas kategori görseli yükleme başarısız:', message);
    throw new Error(`ikas kategori görseli yükleme başarısız: ${message}`);
  }
}

module.exports = {
  uploadProductImage,
  uploadCategoryImage,
};
