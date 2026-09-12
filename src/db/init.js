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
      updated_at TEXT,                 -- date_modified_gmt de Woo
      image_local_path TEXT            -- ruta local al archivo ya descargado (para verla offline)
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
      display_items_json TEXT,         -- [{name, quantity, price}] para mostrar en UI de errores
      total REAL,
      payment_method TEXT,             -- cash | card (para el corte de caja)
      cash_session_id INTEGER,         -- sesión de caja a la que pertenece la venta
      status TEXT NOT NULL DEFAULT 'pending', -- pending | synced | error | resolved_manually
      wc_order_id INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS product_variations (
      id INTEGER PRIMARY KEY,          -- id de la variación en WooCommerce
      parent_id INTEGER NOT NULL,      -- id del producto variable padre
      sku TEXT,
      price REAL,
      regular_price REAL,
      sale_price REAL,
      manage_stock INTEGER,
      stock_quantity REAL,
      attributes_json TEXT,            -- [{name:"Talla", option:"M"}, ...]
      image_local_path TEXT,
      raw_json TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY,          -- id de WooCommerce
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      phone TEXT,
      raw_json TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cash_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      register_id TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      opening_float REAL NOT NULL DEFAULT 0,  -- fondo de caja inicial
      closed_at TEXT,
      counted_amount REAL,                    -- lo que el cajero contó físicamente
      expected_amount REAL,                   -- lo que el sistema calculó que debía haber
      difference REAL,                        -- contado - esperado (negativo = faltante)
      status TEXT NOT NULL DEFAULT 'open'     -- open | closed
    );

    CREATE TABLE IF NOT EXISTS cash_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      type TEXT NOT NULL,                     -- in | out
      amount REAL NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Migración simple para DBs creadas antes de agregar estas columnas.
  const existingCols = db.prepare(`PRAGMA table_info(orders_queue)`).all().map((c) => c.name);
  if (!existingCols.includes('display_items_json')) {
    db.exec(`ALTER TABLE orders_queue ADD COLUMN display_items_json TEXT`);
  }
  if (!existingCols.includes('total')) {
    db.exec(`ALTER TABLE orders_queue ADD COLUMN total REAL`);
  }
  // Necesarias para el corte de caja: saber qué ventas fueron en efectivo y a qué
  // sesión pertenecen, sin tener que parsear payload_json en cada consulta.
  if (!existingCols.includes('payment_method')) {
    db.exec(`ALTER TABLE orders_queue ADD COLUMN payment_method TEXT`);
  }
  if (!existingCols.includes('cash_session_id')) {
    db.exec(`ALTER TABLE orders_queue ADD COLUMN cash_session_id INTEGER`);
  }

  const productCols = db.prepare(`PRAGMA table_info(products)`).all().map((c) => c.name);
  if (!productCols.includes('image_local_path')) {
    db.exec(`ALTER TABLE products ADD COLUMN image_local_path TEXT`);
  }

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
