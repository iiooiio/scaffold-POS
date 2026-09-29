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
      cancelled_at TEXT,
      cancel_reason TEXT,
      refunded_total REAL NOT NULL DEFAULT 0,  -- dinero ya devuelto (parcial o total)
      customer_ref INTEGER,            -- customers.id local; el customer_id de Woo se resuelve al enviar
      -- pending | synced | error | resolved_manually
      -- cancelled_local  : cancelada sin haber llegado nunca a WooCommerce
      -- cancel_pending   : ya estaba en Woo; falta empujar la cancelación
      -- cancelled        : cancelación confirmada en WooCommerce
      status TEXT NOT NULL DEFAULT 'pending',
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
      -- id es el identificador LOCAL y nunca cambia (las órdenes lo referencian).
      -- Para clientes traídos de Woo, id == woo_id. Para clientes creados aquí sin
      -- conexión, id es negativo temporal y woo_id se llena al sincronizar.
      id INTEGER PRIMARY KEY,
      woo_id INTEGER,
      pending_sync INTEGER NOT NULL DEFAULT 0,   -- creado aquí, aún no existe en Woo
      pending_update INTEGER NOT NULL DEFAULT 0, -- editado aquí, falta empujar el cambio
      first_name TEXT,
      last_name TEXT,
      email TEXT,                      -- generado desde el nombre si no se capturó uno
      phone TEXT,
      whatsapp TEXT,                   -- para la integración futura con WAHA
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

    -- Devoluciones parciales pendientes de enviar a WooCommerce. Se encolan aparte
    -- porque en Woo una devolución parcial NO es cambiar el estado de la orden: es
    -- crear un refund sobre una orden que ya existe allá.
    CREATE TABLE IF NOT EXISTS refunds_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_local_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      items_json TEXT,                 -- [{product_id, variation_id, quantity, amount}]
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | error
      wc_refund_id INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT
    );

    -- Cupones sincronizados desde WooCommerce. Se guardan localmente para poder
    -- validarlos y calcular el descuento sin conexión.
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      discount_type TEXT,              -- percent | fixed_cart | fixed_product
      amount REAL,
      minimum_amount REAL,
      maximum_amount REAL,
      date_expires TEXT,
      usage_limit INTEGER,
      usage_count INTEGER,
      individual_use INTEGER,
      product_ids TEXT,                -- JSON array
      excluded_product_ids TEXT,       -- JSON array
      updated_at TEXT
    );

    -- Recepción de mercancía SIN orden de compra previa (entrada directa a inventario).
    -- Se encola local para que funcione sin conexión, igual que las ventas.
    CREATE TABLE IF NOT EXISTS stock_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      register_id TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | error
      error_message TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_receipt_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      variation_id INTEGER,
      name TEXT,
      sku TEXT,
      quantity REAL NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0,      -- ya se sumó en WooCommerce
      error_message TEXT
    );

    -- Pagos de cada venta. Una venta puede pagarse con varios métodos, así que el
    -- método dejó de ser una columna de la orden y pasó a ser una tabla aparte.
    CREATE TABLE IF NOT EXISTS order_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_local_id INTEGER NOT NULL,
      method TEXT NOT NULL,            -- cash | card
      amount REAL NOT NULL
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
  if (!existingCols.includes('cancelled_at')) {
    db.exec(`ALTER TABLE orders_queue ADD COLUMN cancelled_at TEXT`);
  }
  if (!existingCols.includes('cancel_reason')) {
    db.exec(`ALTER TABLE orders_queue ADD COLUMN cancel_reason TEXT`);
  }
  if (!existingCols.includes('refunded_total')) {
    db.exec(`ALTER TABLE orders_queue ADD COLUMN refunded_total REAL NOT NULL DEFAULT 0`);
    // Una venta ya cancelada equivale a devolución del 100%: así el corte la trata
    // igual que a una parcial y no hay dos caminos de cálculo distintos.
    db.exec(`
      UPDATE orders_queue SET refunded_total = COALESCE(total, 0)
      WHERE status IN ('cancelled_local', 'cancel_pending', 'cancelled')
    `);
  }

  // Ventas anteriores a los pagos divididos: se les crea su renglón de pago a partir
  // del método único que tenían. Sin esto, los cortes de turnos ya cerrados cambiarían
  // de golpe al actualizar, porque sus ventas quedarían sin ningún pago registrado.
  const payMigrated = db.prepare(`SELECT value FROM sync_meta WHERE key = 'payments_backfilled'`).get();
  if (!payMigrated) {
    const pending = db.prepare(`
      SELECT id, total, payment_method FROM orders_queue
      WHERE id NOT IN (SELECT order_local_id FROM order_payments)
    `).all();
    const insert = db.prepare(`INSERT INTO order_payments (order_local_id, method, amount) VALUES (?, ?, ?)`);
    const tx = db.transaction((rows) => {
      for (const row of rows) {
        insert.run(row.id, row.payment_method || 'cash', row.total || 0);
      }
      db.prepare(`INSERT INTO sync_meta (key, value) VALUES ('payments_backfilled', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(new Date().toISOString());
    });
    tx(pending);
  }

  const customerCols = db.prepare(`PRAGMA table_info(customers)`).all().map((c) => c.name);
  if (!customerCols.includes('woo_id')) {
    db.exec(`ALTER TABLE customers ADD COLUMN woo_id INTEGER`);
    // Los que ya estaban vinieron de Woo, así que su id ES el de Woo.
    db.exec(`UPDATE customers SET woo_id = id WHERE woo_id IS NULL`);
  }
  if (!customerCols.includes('whatsapp')) {
    db.exec(`ALTER TABLE customers ADD COLUMN whatsapp TEXT`);
  }
  if (!customerCols.includes('pending_update')) {
    db.exec(`ALTER TABLE customers ADD COLUMN pending_update INTEGER NOT NULL DEFAULT 0`);
  }
  if (!customerCols.includes('pending_sync')) {
    db.exec(`ALTER TABLE customers ADD COLUMN pending_sync INTEGER NOT NULL DEFAULT 0`);
  }
  if (!existingCols.includes('customer_ref')) {
    db.exec(`ALTER TABLE orders_queue ADD COLUMN customer_ref INTEGER`);
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

// Verifica que el esquema sea el que el código espera.
//
// POR QUÉ EXISTE: si un archivo del proyecto queda de una versión anterior, las tablas y
// columnas que introdujo nunca se crean, y el síntoma aparece disperso en veinte lugares
// distintos ("no such table", "no such column") sin que nadie relacione la causa. Esto lo
// convierte en un solo diagnóstico legible.
const REQUIRED_SCHEMA = {
  products: ['id', 'sku', 'name', 'type', 'price', 'manage_stock', 'stock_quantity', 'status', 'image_local_path'],
  product_variations: ['id', 'parent_id', 'sku', 'price', 'attributes_json', 'image_local_path'],
  customers: ['id', 'woo_id', 'pending_sync', 'pending_update', 'first_name', 'last_name', 'email', 'phone', 'whatsapp'],
  coupons: ['id', 'code', 'discount_type', 'amount', 'usage_limit', 'usage_count'],
  orders_queue: ['id', 'local_ticket', 'register_id', 'payload_json', 'display_items_json', 'total',
                 'payment_method', 'cash_session_id', 'customer_ref', 'cancelled_at', 'cancel_reason',
                 'refunded_total', 'status'],
  refunds_queue: ['id', 'order_local_id', 'amount', 'items_json', 'status'],
  order_payments: ['id', 'order_local_id', 'method', 'amount'],
  stock_receipts: ['id', 'register_id', 'status'],
  stock_receipt_lines: ['id', 'receipt_id', 'product_id', 'quantity', 'applied'],
  cash_sessions: ['id', 'register_id', 'opened_at', 'opening_float', 'status'],
  cash_movements: ['id', 'session_id', 'type', 'amount'],
  sync_meta: ['key', 'value'],
  counters: ['name', 'value'],
};

function verifySchema() {
  const db = getDb();
  const problems = [];

  const tables = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name)
  );

  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
    if (!tables.has(table)) {
      problems.push(`falta la tabla "${table}"`);
      continue;
    }
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const col of columns) {
      if (!existing.has(col)) problems.push(`falta la columna "${table}.${col}"`);
    }
  }

  return problems;
}

module.exports = { getDb, nextLocalTicket, verifySchema };
