const { getDb } = require('../db/init');
const { fetchAllCustomers } = require('./woo-client');

function upsertCustomer(db, c) {
  db.prepare(`
    INSERT INTO customers (id, first_name, last_name, email, phone, raw_json, updated_at)
    VALUES (@id, @first_name, @last_name, @email, @phone, @raw_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
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
      WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?
      ORDER BY first_name ASC
      LIMIT 30
    `).all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  return db.prepare(`SELECT * FROM customers ORDER BY first_name ASC LIMIT 30`).all();
}

module.exports = { syncCustomers, getLocalCustomers };
