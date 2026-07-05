require('dotenv').config();

const { syncSetCodes } = require('../services/kartfiyat/setRegistry');

syncSetCodes({ force: true })
  .then((registry) => {
    console.log(`Toplam ${registry.totalCodes} set kodu kaydedildi.`);
    console.log(`Kategori kapsamı: ${registry.coveredCategories}/${registry.totalCategories}`);
    if (registry.sources) {
      console.log('Kaynaklar:', registry.sources);
    }
    if (registry.unmatched?.length) {
      console.log(`Eşleşmeyen ${registry.unmatched.length} kayıt atlandı.`);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error('Set kodu senkronizasyonu başarısız:', error.message);
    process.exit(1);
  });
