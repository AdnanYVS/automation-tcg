require('dotenv').config();

const path = require('path');
const express = require('express');
const { initDatabase } = require('../db');
const { getSetCodeRegistry } = require('../services/kartfiyat/setRegistry');
const cardsRouter = require('./routes/cards');
const pricesRouter = require('./routes/prices');
const authRouter = require('./routes/auth');
const { requireAuthPage } = require('./middleware/requireAuth');
const { startPriceCheckerCron } = require('../cron/priceChecker');
const { seedAdminUsersFromEnv } = require('../services/auth');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '../public');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.get('/health', (req, res) => res.json({ success: true, status: 'ok' }));
app.use('/api', authRouter);
app.use('/api', cardsRouter);
app.use('/api', pricesRouter);

app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/index.html', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/prices.html', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'prices.html')));

app.use(express.static(PUBLIC_DIR, { index: false }));

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, error: 'Endpoint bulunamadı.' });
  }
  return res.status(404).send('Sayfa bulunamadı.');
});

initDatabase();
seedAdminUsersFromEnv();

getSetCodeRegistry()
  .then((registry) => {
    console.log(`Set kodları hazır: ${registry.totalCodes || Object.keys(registry.codes || {}).length} eşleşme`);
  })
  .catch((error) => {
    console.error('Set kodları yüklenemedi:', error.message);
  });

app.listen(PORT, () => {
  console.log(`API sunucusu çalışıyor: http://localhost:${PORT}`);
  startPriceCheckerCron();
});
module.exports = app;
