require('dotenv').config();

const cron = require('node-cron');
const { runPriceCheck } = require('../services/priceTracking');

const CRON_SCHEDULE = process.env.PRICE_CHECK_CRON || '0 4 * * *';
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Europe/Istanbul';

function startPriceCheckerCron() {
  if (String(process.env.PRICE_CHECK_ENABLED).toLowerCase() === 'false') {
    return null;
  }

  console.log(`[priceChecker] Cron planlandı: ${CRON_SCHEDULE} (${CRON_TIMEZONE})`);

  return cron.schedule(
    CRON_SCHEDULE,
    () => {
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
