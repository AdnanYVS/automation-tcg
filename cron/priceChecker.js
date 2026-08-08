require('dotenv').config();

const cron = require('node-cron');
const { runPriceCheck } = require('../services/priceTracking');
const { cleanupResolvedPriceAlerts } = require('../db');

const CRON_SCHEDULE = process.env.PRICE_CHECK_CRON || '0 4 * * *';
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Europe/Istanbul';
const ALERT_RETENTION_DAYS = Number(process.env.PRICE_ALERT_RETENTION_DAYS || 90);

function cleanupOldAlerts() {
  try {
    const deleted = cleanupResolvedPriceAlerts({ olderThanDays: ALERT_RETENTION_DAYS });
    if (deleted > 0) {
      console.log(`[priceChecker] ${deleted} eski alert temizlendi (>${ALERT_RETENTION_DAYS} gün).`);
    }
  } catch (error) {
    console.error('[priceChecker] Alert temizliği hatası:', error.message);
  }
}

function startPriceCheckerCron() {
  if (String(process.env.PRICE_CHECK_ENABLED).toLowerCase() === 'false') {
    return null;
  }

  console.log(`[priceChecker] Cron planlandı: ${CRON_SCHEDULE} (${CRON_TIMEZONE})`);

  return cron.schedule(
    CRON_SCHEDULE,
    () => {
      cleanupOldAlerts();
      runPriceCheck().catch((error) => {
        console.error('[priceChecker] Cron hatası:', error.message);
      });
    },
    { timezone: CRON_TIMEZONE },
  );
}

if (require.main === module) {
  if (process.argv.includes('--run-once')) {
    runPriceCheck()
      .then((summary) => {
        console.log(summary);
      })
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  } else {
    startPriceCheckerCron();
  }
}

module.exports = { startPriceCheckerCron, runPriceCheck };
