const { getDb } = require('../db/init');
const config = require('../config');
const { fetchAllCustomers, createCustomer, isOnline } = require('./woo-client');

function upsertCustomer(db, c) {
  db.prepare(`
    INSERT INTO customers (id, woo_id, pending_sync, first_name, last_name, email, phone, whatsapp, raw_json, updated_at)
    VALUES (@id, @id, 0, @first_name, @last_name, @email, @phone, @whatsapp, @raw_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      woo_id = excluded.woo_id,
      pending_sync = 0,
      whatsapp = excluded.whatsapp,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      email = excluded.email,
      phone = excluded.phone,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `).run({
    id: c.id,
    first_name: c.first_name || null,
    last_name: c.last_name || null,
    email: c.email || null,
    phone: (c.billing && c.billing.phone) || null,
    whatsapp: (c.meta_data || []).find((m) => m.key === '_pos_whatsapp')?.value || null,
    raw_json: JSON.stringify(c),
    updated_at: c.date_modified_gmt,
  });
}

// Full sync -- Woo no soporta modified_after en /customers, así que siempre trae todo.
// Se llama en un intervalo aparte y más espaciado (ver CUSTOMERS_SYNC_INTERVAL_MS),
// no en cada tick del sync de catálogo/órdenes.
async function syncCustomers() {
  const db = getDb();
  const customers = await fetchAllCustomers();

  const tx = db.transaction((items) => {
    for (const c of items) upsertCustomer(db, c);
  });
  tx(customers);

  return { count: customers.length, syncedAt: new Date().toISOString() };
}

function getLocalCustomers({ search } = {}) {
  const db = getDb();
  if (search) {
    return db.prepare(`
      SELECT * FROM customers
      WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ?
         OR phone LIKE ? OR whatsapp LIKE ?
      ORDER BY first_name ASC
      LIMIT 30
    `).all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  return db.prepare(`SELECT * FROM customers ORDER BY first_name ASC LIMIT 30`).all();
}

function slugify(text) {
  return (text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// WooCommerce exige un email único por cliente, pero en mostrador nadie lo pide. Se
// genera uno a partir del nombre y se le agrega un sufijo si ya existe.
function generateEmail(db, first_name, last_name) {
  const base = slugify([first_name, last_name].filter(Boolean).join(' ')) || `cliente-${Date.now()}`;
  const domain = config.posEmailDomain;

  let candidate = `${base}@${domain}`;
  let n = 1;
  while (db.prepare(`SELECT 1 FROM customers WHERE email = ?`).get(candidate)) {
    n += 1;
    candidate = `${base}-${n}@${domain}`;
  }
  return candidate;
}

// Crea un cliente. El email NO se pide: se genera desde el nombre.
//
// Con conexión: se crea en Woo y se guarda con su id real.
// Sin conexión: se guarda con un id LOCAL negativo y pending_sync=1, para no bloquear
// la venta. El id local nunca cambia -- las órdenes lo referencian y el id de Woo se
// resuelve al momento de enviarlas (ver order-sync.js).
async function createLocalCustomer({ first_name = '', last_name = '', phone = '', whatsapp = '', email }) {
  const db = getDb();

  if (!first_name.trim() && !last_name.trim()) {
    throw new Error('Captura al menos un nombre');
  }

  // Se acepta un email explícito por si algún día se quiere capturar, pero no se pide.
  const cleanEmail = (email || '').trim() || generateEmail(db, first_name, last_name);

  // Ya no se captura teléfono aparte: el WhatsApp se usa también como teléfono de
  // facturación, para que el cliente no quede en Woo sin ningún número de contacto.
  const contactPhone = (phone || '').trim() || whatsapp.trim();

  if (db.prepare(`SELECT 1 FROM customers WHERE email = ?`).get(cleanEmail)) {
    throw new Error('Ya existe un cliente con ese correo');
  }

  const payload = {
    email: cleanEmail,
    first_name,
    last_name,
    billing: { first_name, last_name, email: cleanEmail, phone: contactPhone },
    meta_data: whatsapp.trim() ? [{ key: '_pos_whatsapp', value: whatsapp.trim() }] : [],
  };

  const online = await isOnline();

  if (online) {
    try {
      const created = await createCustomer(payload);
      upsertCustomer(db, created);
      return { ...db.prepare(`SELECT * FROM customers WHERE id = ?`).get(created.id), created_in_woo: true };
    } catch (err) {
      // Un rechazo de Woo (email duplicado, correo inválido) NO debe convertirse en un
      // cliente local pendiente: se reintentaría en vano para siempre.
      throw new Error(`WooCommerce rechazó el cliente: ${err.message}`);
    }
  }

  const localId = -Date.now();
  db.prepare(`
    INSERT INTO customers (id, woo_id, pending_sync, first_name, last_name, email, phone, whatsapp, raw_json, updated_at)
    VALUES (?, NULL, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(localId, first_name, last_name, cleanEmail, contactPhone || null, whatsapp.trim() || null,
         JSON.stringify(payload), new Date().toISOString());

  return { ...db.prepare(`SELECT * FROM customers WHERE id = ?`).get(localId), created_in_woo: false };
}

// Sube a Woo los clientes creados sin conexión. El id local se conserva; solo se llena
// woo_id, así que las órdenes que ya lo referencian siguen apuntando bien.
async function flushPendingCustomers() {
  const db = getDb();
  const pending = db.prepare(`SELECT * FROM customers WHERE pending_sync = 1`).all();

  let synced = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const created = await createCustomer({
        email: row.email,
        first_name: row.first_name || '',
        last_name: row.last_name || '',
        billing: {
          first_name: row.first_name || '',
          last_name: row.last_name || '',
          email: row.email,
          phone: row.phone || '',
        },
        meta_data: row.whatsapp ? [{ key: '_pos_whatsapp', value: row.whatsapp }] : [],
      });
      db.prepare(`UPDATE customers SET woo_id = ?, pending_sync = 0 WHERE id = ?`).run(created.id, row.id);
      synced += 1;
    } catch (err) {
      console.error(`[clientes] fallo al crear ${row.email}:`, err.message);
      failed += 1;
    }
  }

  return { attempted: pending.length, synced, failed };
}

// Resuelve el id de WooCommerce de un cliente local. Devuelve null si todavía está
// pendiente de crearse allá.
function resolveWooCustomerId(localId) {
  if (!localId) return null;
  const db = getDb();
  const row = db.prepare(`SELECT woo_id FROM customers WHERE id = ?`).get(localId);
  return row ? row.woo_id : null;
}

module.exports = {
  syncCustomers,
  getLocalCustomers,
  createLocalCustomer,
  flushPendingCustomers,
  resolveWooCustomerId,
};
