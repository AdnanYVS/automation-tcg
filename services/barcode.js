const DEFAULT_EAN_PREFIX = '8680001';

function calculateEan13CheckDigit(digits12) {
  const digits = String(digits12).replace(/\D/g, '');
  if (digits.length !== 12) {
    throw new Error('EAN-13 için 12 haneli taban gerekli.');
  }

  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const value = Number(digits[i]);
    sum += i % 2 === 0 ? value : value * 3;
  }

  const remainder = sum % 10;
  return remainder === 0 ? 0 : 10 - remainder;
}

function cardIdToProductCode(cardId) {
  const str = String(cardId);
  let hash = 0;

  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }

  return String(hash % 100000).padStart(5, '0');
}

function generateEan13Barcode(kartfiyatCardId) {
  const prefix = String(process.env.BARCODE_EAN_PREFIX || DEFAULT_EAN_PREFIX).replace(/\D/g, '');
  if (prefix.length !== 7) {
    throw new Error('BARCODE_EAN_PREFIX 7 haneli olmalıdır (ör. 8680001).');
  }

  const productCode = cardIdToProductCode(kartfiyatCardId);
  const base12 = `${prefix}${productCode}`;
  const checkDigit = calculateEan13CheckDigit(base12);

  return `${base12}${checkDigit}`;
}

function generateProductBarcode(kartfiyatCardId) {
  return generateEan13Barcode(kartfiyatCardId);
}

module.exports = {
  generateProductBarcode,
  generateEan13Barcode,
  calculateEan13CheckDigit,
};
