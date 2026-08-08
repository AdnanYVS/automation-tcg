require('dotenv').config();

const cron = require('node-cron');
const { syncWebSales } = require('../services/webSalesSync');

const CRON_SCHEDULE = process.env.WEB_SALES_SYNC_CRON || '*/15 * * * *';
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'Europe/Istanbul';
const STARTUP_DELAY_MS = Number(process.env.WEB_SALES_SYNC_STARTUP_DELAY_MS || 30_000);

let running = false;

async function runSyncSafely(trigger = 'cron') {
  if (running) {
    console.log(`[webSales] Önceki senkron sürüyor, ${trigger} tetiklemesi atlandı.`);
    return null;
  }
  running = true;
  try {
    const stats = await syncWebSales();
    if (stats.recorded || stats.cancelled) {
      console.log(`[webSales] Senkron (${trigger}):`, stats);
    }
    return stats;
  } catch (error) {
    console.error(`[webSales] Senkron hatası (${trigger}):`, error.message);
    return null;
  } finally {
    running = false;
  }
}

function startWebSalesSyncCron() {
  if (String(process.env.WEB_SALES_SYNC_ENABLED).toLowerCase() === 'false') {
    return null;
  }

  console.log(`[webSales] Cron planlandı: ${CRON_SCHEDULE} (${CRON_TIMEZONE})`);

  // Açılıştan kısa süre sonra ilk senkron — deploy sonrası 15 dk beklememek için.
  setTimeout(() => { runSyncSafely('startup'); }, STARTUP_DELAY_MS);

  return cron.schedule(
    CRON_SCHEDULE,
    () => { runSyncSafely('cron'); },
    { timezone: CRON_TIMEZONE },
  );
}

if (require.main === module) {
  runSyncSafely('manual')
    .then((stats) => {
      console.log(stats || 'Senkron çalıştırılamadı.');
      process.exit(stats ? 0 : 1);
    });
}

module.exports = { startWebSalesSyncCron, runSyncSafely };
