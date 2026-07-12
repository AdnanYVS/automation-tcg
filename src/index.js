require('dotenv').config();

const path = require('path');
const express = require('express');
const { initDatabase } = require('../db');
const { getSetCodeRegistry } = require('../services/kartfiyat/setRegistry');
const { getOnePieceSetCodeRegistry } = require('../services/kartfiyat/onepieceSetRegistry');
const cardsRouter = require('./routes/cards');
const pricesRouter = require('./routes/prices');
const inventoryRouter = require('./routes/inventory');
const categoryLogosRouter = require('./routes/categoryLogos');
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
app.use('/api', inventoryRouter);
app.use('/api', categoryLogosRouter);

app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/index.html', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/prices.html', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'prices.html')));
app.get('/inventory.html', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'inventory.html')));
app.get('/category-logos.html', requireAuthPage, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'category-logos.html')));

app.use(express.static(PUBLIC_DIR, { index: false }));

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, error: 'Endpoint bulunamadı.' });
  }
  return res.status(404).send('Sayfa bulunamadı.');
});

initDatabase();
seedAdminUsersFromEnv();

Promise.all([getSetCodeRegistry(), getOnePieceSetCodeRegistry()])
  .then(([pokemonRegistry, onepieceRegistry]) => {
    console.log(`Pokemon set kodları: ${pokemonRegistry.totalCodes || Object.keys(pokemonRegistry.codes || {}).length}`);
    console.log(`One Piece set kodları: ${onepieceRegistry.totalCodes || Object.keys(onepieceRegistry.codes || {}).length}`);
  })
  .catch((error) => {
    console.error('Set kodları yüklenemedi:', error.message);
  });

app.listen(PORT, () => {
  console.log(`API sunucusu çalışıyor: http://localhost:${PORT}`);
  startPriceCheckerCron();
});
module.exports = app;
