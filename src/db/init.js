const path = require('path');
const Database = require('better-sqlite3');
const { app } = require('electron');

let db;

function getDb() {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'pos-local.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,          -- id de WooCommerce
      sku TEXT,
      name TEXT NOT NULL,
      type TEXT,                       -- simple, variable, etc.
      price REAL,
      regular_price REAL,
      sale_price REAL,
      manage_stock INTEGER,            -- 0/1
      stock_quantity REAL,
      status TEXT,                     -- publish, draft, etc.
      raw_json TEXT,                   -- respuesta completa de Woo por si hace falta luego
      updated_at TEXT                  -- date_modified_gmt de Woo
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS orders_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_ticket TEXT NOT NULL,      -- ej. CAJA1-000042
      register_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,      -- body listo para POST /orders de Woo
      status TEXT NOT NULL DEFAULT 'pending', -- pending | synced | error
      wc_order_id INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

function nextLocalTicket(registerId) {
  const database = getDb();
  const tx = database.transaction(() => {
    database
      .prepare(`INSERT INTO counters (name, value) VALUES (?, 1)
                ON CONFLICT(name) DO UPDATE SET value = value + 1`)
      .run(registerId);
    const row = database.prepare('SELECT value FROM counters WHERE name = ?').get(registerId);
    return row.value;
  });
  const n = tx();
  return `${registerId}-${String(n).padStart(6, '0')}`;
}

module.exports = { getDb, nextLocalTicket };
