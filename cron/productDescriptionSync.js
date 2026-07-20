require('dotenv').config();

const cron = require('node-cron');
const { syncAllProductSeriesDescriptions } = require('../services/productDescriptions');

const CRON_SCHEDULE = process.env.PRODUCT_DESCRIPTION_SYNC_CRON || '0 5 * * *';
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Europe/Istanbul';

function startProductDescriptionSyncCron() {
  if (String(process.env.PRODUCT_DESCRIPTION_SYNC_ENABLED).toLowerCase() === 'false') {
    return null;
  }

  console.log(`[productDescriptionSync] Cron planlandı: ${CRON_SCHEDULE} (${CRON_TIMEZONE})`);

  return cron.schedule(
    CRON_SCHEDULE,
    () => {
      syncAllProductSeriesDescriptions({ dryRun: false, skipIfUnchanged: true })
        .then((summary) => {
          console.log('[productDescriptionSync] Tamamlandı:', summary);
        })
        .catch((error) => {
          console.error('[productDescriptionSync] Cron hatası:', error.message);
        });
    },
    { timezone: CRON_TIMEZONE },
  );
}

if (require.main === module) {
  syncAllProductSeriesDescriptions({ dryRun: false, skipIfUnchanged: true })
    .then((summary) => {
      console.log(summary);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { startProductDescriptionSyncCron, syncAllProductSeriesDescriptions };
