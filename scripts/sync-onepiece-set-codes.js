#!/usr/bin/env node
require('dotenv').config();

const { syncOnePieceSetCodes } = require('../services/kartfiyat/onepieceSetRegistry');

syncOnePieceSetCodes({ force: true })
  .then((registry) => {
    console.log(`Toplam ${registry.totalCodes} One Piece set kodu kaydedildi.`);
    console.log(`EN kapsam: ${registry.coveredEnglishCategories}/${registry.totalEnglishCategories}`);
    console.log(`JA kapsam: ${registry.coveredJapaneseCategories}/${registry.totalJapaneseCategories}`);
    if (registry.sources) {
      console.log('Kaynaklar:', registry.sources);
    }
    if (registry.unmatched?.length) {
      console.log(`Eşleşmeyen ${registry.unmatched.length} kayıt:`);
      registry.unmatched.forEach((entry) => console.log(`  - ${entry.setCode}: ${entry.reason}`));
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error('One Piece set kodu senkronizasyonu başarısız:', error.message);
    process.exit(1);
  });
