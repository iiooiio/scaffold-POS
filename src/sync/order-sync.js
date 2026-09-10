const { getDb, nextLocalTicket } = require('../db/init');
const { createOrder, isOnline } = require('./woo-client');
const config = require('../config');

// cartItems: [{ product_id, quantity, price }]
// Construye el payload en formato WooCommerce y lo guarda en la cola local.
// Devuelve el ticket local de inmediato (no espera red) para poder imprimir ya.
function queueOrder({ cartItems, customerNote = '', paymentMethod = 'cash' }) {
  const db = getDb();
  const localTicket = nextLocalTicket(config.registerId);

  const payload = {
    payment_method: paymentMethod,
    payment_method_title: paymentMethod === 'cash' ? 'Efectivo' : paymentMethod,
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

  db.prepare(`
    INSERT INTO orders_queue (local_ticket, register_id, payload_json, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(localTicket, config.registerId, JSON.stringify(payload), new Date().toISOString());

  return { localTicket, payload, cartItems };
}

// Intenta subir todas las órdenes pendientes/en error. Se llama en el intervalo de sync
// y también se puede invocar manualmente desde la UI ("reintentar ahora").
async function flushPendingOrders() {
  const db = getDb();
  const online = await isOnline();
  if (!online) return { attempted: 0, synced: 0, failed: 0 };

  const pending = db.prepare(`
    SELECT * FROM orders_queue WHERE status IN ('pending', 'error') ORDER BY id ASC
  `).all();

  let synced = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const payload = JSON.parse(row.payload_json);
      const wcOrder = await createOrder(payload);
      db.prepare(`
        UPDATE orders_queue
        SET status = 'synced', wc_order_id = ?, synced_at = ?, error_message = NULL
        WHERE id = ?
      `).run(wcOrder.id, new Date().toISOString(), row.id);
      synced += 1;
    } catch (err) {
      // Caso importante: si Woo rechaza por falta de stock u otro motivo de negocio,
      // NO reintentar en silencio infinito -- se marca 'error' y queda visible en UI
      // para resolución manual (ver README, sección "Conflictos de stock").
      db.prepare(`
        UPDATE orders_queue SET status = 'error', error_message = ? WHERE id = ?
      `).run(err.message, row.id);
      failed += 1;
    }
  }

  return { attempted: pending.length, synced, failed };
}

function getQueueSummary() {
  const db = getDb();
  return db.prepare(`
    SELECT status, COUNT(*) as count FROM orders_queue GROUP BY status
  `).all();
}

function getErroredOrders() {
  const db = getDb();
  return db.prepare(`SELECT * FROM orders_queue WHERE status = 'error' ORDER BY id DESC`).all();
}

module.exports = { queueOrder, flushPendingOrders, getQueueSummary, getErroredOrders };
