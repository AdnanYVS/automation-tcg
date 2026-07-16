require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'automation-tcg.db');

function ensureDataDirectory() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

const MAPPING_EXTRA_COLUMNS = [
  { name: 'card_name', ddl: 'TEXT' },
  { name: 'last_usd_price', ddl: 'REAL' },
  { name: 'last_try_price', ddl: 'REAL' },
  { name: 'last_price_checked_at', ddl: 'TEXT' },
  { name: 'barcode', ddl: 'TEXT' },
  { name: 'price_manual', ddl: 'INTEGER DEFAULT 0' },
  { name: 'price_label', ddl: 'TEXT' },
];

function ensureMappingExtraColumns(db) {
  const columns = db.prepare('PRAGMA table_info(card_mappings)').all().map((col) => col.name);
  for (const column of MAPPING_EXTRA_COLUMNS) {
    if (!columns.includes(column.name)) {
      db.exec(`ALTER TABLE card_mappings ADD COLUMN ${column.name} ${column.ddl}`);
    }
  }
}

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ikas_variant_id TEXT NOT NULL UNIQUE,
      ikas_product_id TEXT,
      kartfiyat_card_id TEXT NOT NULL UNIQUE,
      card_name TEXT,
      last_usd_price REAL,
      last_try_price REAL,
      last_price_checked_at TEXT,
      barcode TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_card_mappings_kartfiyat_card_id
      ON card_mappings(kartfiyat_card_id);

    CREATE INDEX IF NOT EXISTS idx_card_mappings_ikas_product_id
      ON card_mappings(ikas_product_id);

    CREATE TABLE IF NOT EXISTS price_change_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mapping_id INTEGER NOT NULL,
      kartfiyat_card_id TEXT NOT NULL,
      card_name TEXT,
      old_usd_price REAL NOT NULL,
      new_usd_price REAL NOT NULL,
      old_try_price REAL NOT NULL,
      new_try_price REAL NOT NULL,
      change_percent REAL NOT NULL,
      usd_try_rate REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      FOREIGN KEY (mapping_id) REFERENCES card_mappings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_price_change_alerts_status
      ON price_change_alerts(status);

    CREATE INDEX IF NOT EXISTS idx_price_change_alerts_mapping_id
      ON price_change_alerts(mapping_id);

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES admin_users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_id
      ON admin_sessions(user_id);

    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
      ON admin_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS inventory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mapping_id INTEGER,
      kartfiyat_card_id TEXT,
      ikas_variant_id TEXT,
      stock_location_id TEXT,
      quantity INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      order_id TEXT,
      order_number TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (mapping_id) REFERENCES card_mappings(id)
    );

    CREATE INDEX IF NOT EXISTS idx_inventory_events_mapping_id
      ON inventory_events(mapping_id);

    CREATE INDEX IF NOT EXISTS idx_inventory_events_location_id
      ON inventory_events(stock_location_id);

    CREATE INDEX IF NOT EXISTS idx_inventory_events_event_type
      ON inventory_events(event_type);
  `);

  ensureMappingExtraColumns(db);
}

function initDatabase() {
  ensureDataDirectory();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables(db);
  console.log(`SQLite veritabanı hazır: ${DB_PATH}`);
  return db;
}

function getDatabase() {
  ensureDataDirectory();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables(db);
  return db;
}

function insertMapping({
  ikasVariantId,
  kartfiyatCardId,
  ikasProductId = null,
  barcode = null,
  priceManual = false,
  priceLabel = null,
}) {
  const db = getDatabase();
  try {
    const result = db.prepare(`
      INSERT INTO card_mappings (
        ikas_variant_id,
        ikas_product_id,
        kartfiyat_card_id,
        barcode,
        price_manual,
        price_label
      )
      VALUES (
        @ikasVariantId,
        @ikasProductId,
        @kartfiyatCardId,
        @barcode,
        @priceManual,
        @priceLabel
      )
    `).run({
      ikasVariantId,
      ikasProductId,
      kartfiyatCardId,
      barcode,
      priceManual: priceManual ? 1 : 0,
      priceLabel: priceLabel || null,
    });
    return { id: result.lastInsertRowid };
  } finally {
    db.close();
  }
}

function findByKartfiyatCardId(kartfiyatCardId, { priceLabel = null } = {}) {
  const db = getDatabase();
  try {
    if (priceLabel === undefined) {
      return db.prepare('SELECT * FROM card_mappings WHERE kartfiyat_card_id = ?').get(kartfiyatCardId);
    }

    return db.prepare(`
      SELECT * FROM card_mappings
      WHERE kartfiyat_card_id = ?
        AND COALESCE(price_label, '') = COALESCE(?, '')
    `).get(kartfiyatCardId, priceLabel || null);
  } finally {
    db.close();
  }
}

function findByIkasVariantId(ikasVariantId) {
  const db = getDatabase();
  try {
    return db.prepare('SELECT * FROM card_mappings WHERE ikas_variant_id = ?').get(ikasVariantId);
  } finally {
    db.close();
  }
}

function getAllMappings() {
  const db = getDatabase();
  try {
    return db.prepare('SELECT * FROM card_mappings ORDER BY created_at DESC').all();
  } finally {
    db.close();
  }
}

function getAutoTrackedMappings() {
  const db = getDatabase();
  try {
    return db.prepare(`
      SELECT * FROM card_mappings
      WHERE COALESCE(price_manual, 0) = 0
      ORDER BY created_at DESC
    `).all();
  } finally {
    db.close();
  }
}

function findMappingById(id) {
  const db = getDatabase();
  try {
    return db.prepare('SELECT * FROM card_mappings WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

function updateMappingPriceSnapshot({
  mappingId,
  cardName,
  usdPrice,
  tryPrice,
  checkedAt = new Date().toISOString(),
}) {
  const db = getDatabase();
  try {
    db.prepare(`
      UPDATE card_mappings
      SET card_name = COALESCE(@cardName, card_name),
          last_usd_price = @usdPrice,
          last_try_price = @tryPrice,
          last_price_checked_at = @checkedAt,
          updated_at = datetime('now')
      WHERE id = @mappingId
    `).run({ mappingId, cardName, usdPrice, tryPrice, checkedAt });
  } finally {
    db.close();
  }
}

function updateMappingIkasIds({ mappingId, ikasProductId = null, ikasVariantId = null }) {
  const db = getDatabase();
  try {
    db.prepare(`
      UPDATE card_mappings
      SET ikas_product_id = COALESCE(@ikasProductId, ikas_product_id),
          ikas_variant_id = COALESCE(@ikasVariantId, ikas_variant_id),
          updated_at = datetime('now')
      WHERE id = @mappingId
    `).run({ mappingId, ikasProductId, ikasVariantId });
  } finally {
    db.close();
  }
}

function upsertPendingPriceAlert({
  mappingId,
  kartfiyatCardId,
  cardName,
  oldUsdPrice,
  newUsdPrice,
  oldTryPrice,
  newTryPrice,
  changePercent,
  usdTryRate,
}) {
  const db = getDatabase();
  try {
    const existing = db.prepare(`
      SELECT id FROM price_change_alerts
      WHERE mapping_id = ? AND status = 'pending'
      LIMIT 1
    `).get(mappingId);

    if (existing) {
      db.prepare(`
        UPDATE price_change_alerts
        SET card_name = @cardName,
            old_usd_price = @oldUsdPrice,
            new_usd_price = @newUsdPrice,
            old_try_price = @oldTryPrice,
            new_try_price = @newTryPrice,
            change_percent = @changePercent,
            usd_try_rate = @usdTryRate,
            detected_at = datetime('now')
        WHERE id = @id
      `).run({
        id: existing.id,
        cardName,
        oldUsdPrice,
        newUsdPrice,
        oldTryPrice,
        newTryPrice,
        changePercent,
        usdTryRate,
      });
      return { id: existing.id, updated: true };
    }

    const result = db.prepare(`
      INSERT INTO price_change_alerts (
        mapping_id, kartfiyat_card_id, card_name,
        old_usd_price, new_usd_price, old_try_price, new_try_price,
        change_percent, usd_try_rate, status
      ) VALUES (
        @mappingId, @kartfiyatCardId, @cardName,
        @oldUsdPrice, @newUsdPrice, @oldTryPrice, @newTryPrice,
        @changePercent, @usdTryRate, 'pending'
      )
    `).run({
      mappingId,
      kartfiyatCardId,
      cardName,
      oldUsdPrice,
      newUsdPrice,
      oldTryPrice,
      newTryPrice,
      changePercent,
      usdTryRate,
    });

    return { id: result.lastInsertRowid, updated: false };
  } finally {
    db.close();
  }
}

function getPriceChangeAlerts({ status } = {}) {
  const db = getDatabase();
  try {
    if (status) {
      return db.prepare(`
        SELECT a.*, m.ikas_variant_id, m.ikas_product_id, m.barcode, m.price_label
        FROM price_change_alerts a
        JOIN card_mappings m ON m.id = a.mapping_id
        WHERE a.status = ?
        ORDER BY a.detected_at DESC
      `).all(status);
    }

    return db.prepare(`
      SELECT a.*, m.ikas_variant_id, m.ikas_product_id, m.barcode, m.price_label
      FROM price_change_alerts a
      JOIN card_mappings m ON m.id = a.mapping_id
      ORDER BY a.detected_at DESC
    `).all();
  } finally {
    db.close();
  }
}

function getPriceChangeAlertById(id) {
  const db = getDatabase();
  try {
    return db.prepare(`
      SELECT a.*, m.ikas_variant_id, m.ikas_product_id, m.barcode, m.price_label
      FROM price_change_alerts a
      JOIN card_mappings m ON m.id = a.mapping_id
      WHERE a.id = ?
    `).get(id);
  } finally {
    db.close();
  }
}

function resolvePriceChangeAlert(id, status) {
  const db = getDatabase();
  try {
    const result = db.prepare(`
      UPDATE price_change_alerts
      SET status = @status, resolved_at = datetime('now')
      WHERE id = @id AND status = 'pending'
    `).run({ id, status });

    if (!result.changes) return null;
    return getPriceChangeAlertById(id);
  } finally {
    db.close();
  }
}

function countPendingPriceAlerts() {
  const db = getDatabase();
  try {
    return db.prepare(`
      SELECT COUNT(*) AS count FROM price_change_alerts WHERE status = 'pending'
    `).get().count;
  } finally {
    db.close();
  }
}

function getLatestPriceCheckSummary() {
  const db = getDatabase();
  try {
    return db.prepare(`
      SELECT
        COUNT(*) AS total_mappings,
        SUM(CASE WHEN last_try_price IS NOT NULL THEN 1 ELSE 0 END) AS tracked_mappings,
        MAX(last_price_checked_at) AS last_checked_at
      FROM card_mappings
    `).get();
  } finally {
    db.close();
  }
}

function countAdminUsers() {
  const db = getDatabase();
  try {
    return db.prepare('SELECT COUNT(*) AS count FROM admin_users').get().count;
  } finally {
    db.close();
  }
}

function findAdminUserByUsername(username) {
  const db = getDatabase();
  try {
    return db.prepare(`
      SELECT id, username, password_hash, display_name, is_active
      FROM admin_users
      WHERE username = ? COLLATE NOCASE
    `).get(username);
  } finally {
    db.close();
  }
}

function findAdminUserById(id) {
  const db = getDatabase();
  try {
    return db.prepare(`
      SELECT id, username, display_name, is_active
      FROM admin_users
      WHERE id = ?
    `).get(id);
  } finally {
    db.close();
  }
}

function createAdminUser({ username, passwordHash, displayName = null }) {
  const db = getDatabase();
  try {
    const result = db.prepare(`
      INSERT INTO admin_users (username, password_hash, display_name)
      VALUES (@username, @passwordHash, @displayName)
    `).run({ username, passwordHash, displayName });
    return findAdminUserById(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

function updateAdminUserPassword(userId, passwordHash) {
  const db = getDatabase();
  try {
    db.prepare(`
      UPDATE admin_users
      SET password_hash = @passwordHash
      WHERE id = @userId
    `).run({ userId, passwordHash });
    db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(userId);
  } finally {
    db.close();
  }
}

function createAdminSession({ token, userId, expiresAt }) {
  const db = getDatabase();
  try {
    db.prepare(`
      INSERT INTO admin_sessions (token, user_id, expires_at)
      VALUES (@token, @userId, @expiresAt)
    `).run({ token, userId, expiresAt });
  } finally {
    db.close();
  }
}

function findAdminSession(token) {
  const db = getDatabase();
  try {
    return db.prepare(`
      SELECT s.token, s.user_id, s.expires_at, u.username, u.display_name, u.is_active
      FROM admin_sessions s
      JOIN admin_users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);
  } finally {
    db.close();
  }
}

function deleteAdminSession(token) {
  const db = getDatabase();
  try {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  } finally {
    db.close();
  }
}

function deleteExpiredAdminSessions() {
  const db = getDatabase();
  try {
    db.prepare(`DELETE FROM admin_sessions WHERE expires_at <= datetime('now')`).run();
  } finally {
    db.close();
  }
}

function insertInventoryEvent({
  mappingId = null,
  kartfiyatCardId = null,
  ikasVariantId = null,
  stockLocationId,
  quantity,
  eventType,
  orderId = null,
  orderNumber = null,
  note = null,
}) {
  const db = getDatabase();
  try {
    const result = db.prepare(`
      INSERT INTO inventory_events (
        mapping_id,
        kartfiyat_card_id,
        ikas_variant_id,
        stock_location_id,
        quantity,
        event_type,
        order_id,
        order_number,
        note
      ) VALUES (
        @mappingId,
        @kartfiyatCardId,
        @ikasVariantId,
        @stockLocationId,
        @quantity,
        @eventType,
        @orderId,
        @orderNumber,
        @note
      )
    `).run({
      mappingId,
      kartfiyatCardId,
      ikasVariantId,
      stockLocationId,
      quantity,
      eventType,
      orderId,
      orderNumber,
      note,
    });
    return { id: result.lastInsertRowid };
  } finally {
    db.close();
  }
}

function getInventoryEvents({ eventType, stockLocationId, limit = 100 } = {}) {
  const db = getDatabase();
  try {
    const conditions = [];
    const params = { limit };

    if (eventType) {
      conditions.push('event_type = @eventType');
      params.eventType = eventType;
    }
    if (stockLocationId) {
      conditions.push('stock_location_id = @stockLocationId');
      params.stockLocationId = stockLocationId;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    return db.prepare(`
      SELECT e.*, m.card_name, m.barcode
      FROM inventory_events e
      LEFT JOIN card_mappings m ON m.id = e.mapping_id
      ${whereClause}
      ORDER BY e.created_at DESC
      LIMIT @limit
    `).all(params);
  } finally {
    db.close();
  }
}

function getInventoryEventSummary() {
  const db = getDatabase();
  try {
    return db.prepare(`
      SELECT
        event_type,
        stock_location_id,
        SUM(quantity) AS total_quantity,
        COUNT(*) AS event_count
      FROM inventory_events
      GROUP BY event_type, stock_location_id
      ORDER BY event_type ASC, stock_location_id ASC
    `).all();
  } finally {
    db.close();
  }
}

function listAdminUsers() {
  const db = getDatabase();
  try {
    return db.prepare(`
      SELECT id, username, display_name, is_active, created_at
      FROM admin_users
      ORDER BY username ASC
    `).all();
  } finally {
    db.close();
  }
}

if (require.main === module) {
  initDatabase();
}

module.exports = {
  DB_PATH,
  initDatabase,
  getDatabase,
  insertMapping,
  findByKartfiyatCardId,
  findByIkasVariantId,
  findMappingById,
  getAllMappings,
  getAutoTrackedMappings,
  updateMappingPriceSnapshot,
  updateMappingIkasIds,
  upsertPendingPriceAlert,
  getPriceChangeAlerts,
  getPriceChangeAlertById,
  resolvePriceChangeAlert,
  countPendingPriceAlerts,
  getLatestPriceCheckSummary,
  countAdminUsers,
  findAdminUserByUsername,
  findAdminUserById,
  createAdminUser,
  updateAdminUserPassword,
  createAdminSession,
  findAdminSession,
  deleteAdminSession,
  deleteExpiredAdminSessions,
  getInventoryEvents,
  getInventoryEventSummary,
  insertInventoryEvent,
  listAdminUsers,
};
