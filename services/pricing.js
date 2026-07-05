function calculateFinalPriceTry(usdPrice, usdTryRate, multiplier = 1.86) {
  const rawPrice = Number(usdPrice) * Number(usdTryRate) * Number(multiplier);
  return Math.round(rawPrice * 100) / 100;
}

module.exports = { calculateFinalPriceTry };
