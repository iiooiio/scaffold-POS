const { getDb, nextLocalTicket } = require('../db/init');
const { createOrder, isOnline } = require('./woo-client');
const config = require('../config');

// cartItems: [{ product_id, name, price, quantity }]
// Construye el payload en formato WooCommerce y lo guarda en la cola local.
// Devuelve el ticket local de inmediato (no espera red) para poder imprimir ya.
function queueOrder({ cartItems, customerNote = '', paymentMethod = 'cash' }) {
  const db = getDb();
  const localTicket = nextLocalTicket(config.registerId);
  const total = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

  const paymentTitles = { cash: 'Efectivo', card: 'Tarjeta' };
  const payload = {
    payment_method: paymentMethod,
    payment_method_title: paymentTitles[paymentMethod] || paymentMethod,
    set_paid: true,
    status: 'completed',
    customer_note: customerNote,
    meta_data: [
      { key: '_pos_register_id', value: config.registerId },
      { key: '_pos_local_ticket', value: localTicket },
    ],
    line_items: cartItems.map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity,
    })),
  };

  const displayItems = cartItems.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price }));

  db.prepare(`
    INSERT INTO orders_queue
      (local_ticket, register_id, payload_json, display_items_json, total, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    localTicket,
    config.registerId,
    JSON.stringify(payload),
    JSON.stringify(displayItems),
    total,
    new Date().toISOString()
  );

  return { localTicket, payload, cartItems };
}

// Intenta sincronizar UNA orden puntual. Se usa tanto en el auto-sync (solo 'pending')
// como en el retry manual desde la UI (una orden en 'error' específica).
async function trySyncOrder(db, row) {
  try {
    const payload = JSON.parse(row.payload_json);
    const wcOrder = await createOrder(payload);
    db.prepare(`
      UPDATE orders_queue
      SET status = 'synced', wc_order_id = ?, synced_at = ?, error_message = NULL
      WHERE id = ?
    `).run(wcOrder.id, new Date().toISOString(), row.id);
    return { ok: true };
  } catch (err) {
    db.prepare(`
      UPDATE orders_queue SET status = 'error', error_message = ? WHERE id = ?
    `).run(err.message, row.id);
    return { ok: false, error: err.message };
  }
}

// Auto-sync en el intervalo de fondo: SOLO toca 'pending'. Las que ya están en 'error'
// no se reintentan solas -- eso es intencional (ver política de stock: sin buffer,
// sobreventa se resuelve manual). El cajero decide cuándo reintentar una orden en error.
async function flushPendingOrders() {
  const db = getDb();
  const online = await isOnline();
  if (!online) return { attempted: 0, synced: 0, failed: 0 };

  const pending = db.prepare(`
    SELECT * FROM orders_queue WHERE status = 'pending' ORDER BY id ASC
  `).all();

  let synced = 0;
  let failed = 0;

  for (const row of pending) {
    const result = await trySyncOrder(db, row);
    if (result.ok) synced += 1;
    else failed += 1;
  }

  return { attempted: pending.length, synced, failed };
}

// Reintento manual de UNA orden en error, disparado por el cajero desde la pantalla
// de errores (ej. después de ajustar stock en wp-admin).
async function retryOrder(orderId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM orders_queue WHERE id = ?`).get(orderId);
  if (!row) throw new Error(`Orden ${orderId} no encontrada`);

  const online = await isOnline();
  if (!online) throw new Error('Sin conexión al sitio, no se puede reintentar ahora');

  return trySyncOrder(db, row);
}

// Marca una orden en error como resuelta SIN crearla en WooCommerce -- para el caso
// donde el cajero ya la resolvió por fuera (ej. la capturó a mano en wp-admin, o anuló
// la venta y devolvió el efectivo). Queda auditada en local, no se vuelve a tocar.
function resolveManually(orderId, note = '') {
  const db = getDb();
  const result = db.prepare(`
    UPDATE orders_queue
    SET status = 'resolved_manually', error_message = ?
    WHERE id = ? AND status = 'error'
  `).run(note ? `Resuelto manual: ${note}` : 'Resuelto manual', orderId);

  if (result.changes === 0) throw new Error(`Orden ${orderId} no está en estado 'error'`);
  return { ok: true };
}

function getQueueSummary() {
  const db = getDb();
  return db.prepare(`
    SELECT status, COUNT(*) as count FROM orders_queue GROUP BY status
  `).all();
}

function getErroredOrders() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM orders_queue WHERE status = 'error' ORDER BY id DESC`).all();
  return rows.map((r) => ({ ...r, display_items: JSON.parse(r.display_items_json || '[]') }));
}

module.exports = {
  queueOrder,
  flushPendingOrders,
  retryOrder,
  resolveManually,
  getQueueSummary,
  getErroredOrders,
};
