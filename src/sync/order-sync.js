const { getDb, nextLocalTicket } = require('../db/init');
const { createOrder, cancelWooOrder, isOnline } = require('./woo-client');
const config = require('../config');

// cartItems: [{ product_id, name, price, quantity }]
// cashInfo: { received, change } -- solo relevante si paymentMethod === 'cash'
// Construye el payload en formato WooCommerce y lo guarda en la cola local.
// Devuelve el ticket local de inmediato (no espera red) para poder imprimir ya.
function queueOrder({ cartItems, customerNote = '', paymentMethod = 'cash', cashInfo, customerId, cashSessionId = null }) {
  const db = getDb();
  const localTicket = nextLocalTicket(config.registerId);
  const total = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

  const paymentTitles = { cash: 'Efectivo', card: 'Tarjeta' };
  const metaData = [
    { key: '_pos_register_id', value: config.registerId },
    { key: '_pos_local_ticket', value: localTicket },
    // Para que la columna Origin/Atribución de WooCommerce no marque estas órdenes
    // como "Online" -- basado en la documentación de meta keys de Order Attribution
    // (_wc_order_attribution_*), no verificado contra un sitio real.
    { key: '_wc_order_attribution_source_type', value: 'utm' },
    { key: '_wc_order_attribution_utm_source', value: `pos-${config.registerId}` },
    { key: '_wc_order_attribution_utm_medium', value: 'pos' },
  ];
  if (paymentMethod === 'cash' && cashInfo) {
    metaData.push({ key: '_pos_cash_received', value: String(cashInfo.received) });
    metaData.push({ key: '_pos_cash_change', value: String(cashInfo.change) });
  }

  const payload = {
    payment_method: paymentMethod,
    payment_method_title: paymentTitles[paymentMethod] || paymentMethod,
    set_paid: true,
    status: 'completed',
    customer_note: customerNote,
    ...(customerId ? { customer_id: customerId } : {}),
    meta_data: metaData,
    // subtotal/total explícitos: sin esto WooCommerce recalcula con SU precio de
    // catálogo e ignoraría el ajuste porcentual, dejando el ticket impreso y la orden
    // en Woo con montos distintos.
    line_items: cartItems.map((item) => {
      const lineTotal = (item.price * item.quantity).toFixed(2);
      return {
        product_id: item.product_id,
        ...(item.variation_id ? { variation_id: item.variation_id } : {}),
        quantity: item.quantity,
        subtotal: lineTotal,
        total: lineTotal,
      };
    }),
  };

  const displayItems = cartItems.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price }));

  db.prepare(`
    INSERT INTO orders_queue
      (local_ticket, register_id, payload_json, display_items_json, total,
       payment_method, cash_session_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    localTicket,
    config.registerId,
    JSON.stringify(payload),
    JSON.stringify(displayItems),
    total,
    paymentMethod,
    cashSessionId,
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

// Ventas recientes de ESTA caja, para reimprimir tickets. Incluye cualquier estado de
// sincronización: el ticket existe aunque la orden no haya subido a WooCommerce.
function getRecentOrders(limit = 50) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, local_ticket, total, payment_method, status, created_at,
           cash_session_id, cancelled_at, cancel_reason
    FROM orders_queue WHERE register_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(config.registerId, limit);
  return rows;
}

// Reconstruye los datos que printTicket necesita a partir de lo guardado en la cola.
// Los items salen de display_items_json; la nota y el efectivo recibido/cambio viven
// dentro de payload_json (customer_note y meta_data), no en columnas propias.
function getOrderForReprint(orderId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM orders_queue WHERE id = ?`).get(orderId);
  if (!row) throw new Error(`Venta ${orderId} no encontrada`);

  const payload = JSON.parse(row.payload_json);
  const meta = payload.meta_data || [];
  const metaValue = (key) => meta.find((m) => m.key === key)?.value;

  const received = metaValue('_pos_cash_received');
  const change = metaValue('_pos_cash_change');

  return {
    localTicket: row.local_ticket,
    // Órdenes viejas (anteriores a esta columna) pueden no tener items guardados.
    cartItems: JSON.parse(row.display_items_json || '[]'),
    total: row.total,
    paymentMethod: row.payment_method || payload.payment_method,
    cashInfo: received !== undefined
      ? { received: parseFloat(received), change: parseFloat(change) }
      : null,
    note: payload.customer_note || '',
  };
}

const CANCELLED_STATUSES = ['cancelled_local', 'cancel_pending', 'cancelled'];

// Cancela una venta. Qué pasa depende de si ya llegó a WooCommerce o no:
//   - nunca llegó (pending/error/resuelta manual) -> 'cancelled_local', nada que avisar
//   - ya está en Woo ('synced')                   -> 'cancel_pending', se empuja al sincronizar
// El dinero se devuelve al cliente en el momento; el efecto en el corte es inmediato
// porque getSessionSummary excluye las canceladas (ver cash-session.js).
function cancelOrder(orderId, reason = '') {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM orders_queue WHERE id = ?`).get(orderId);
  if (!row) throw new Error(`Venta ${orderId} no encontrada`);
  if (CANCELLED_STATUSES.includes(row.status)) throw new Error('Esta venta ya está cancelada');

  const newStatus = row.status === 'synced' ? 'cancel_pending' : 'cancelled_local';

  db.prepare(`
    UPDATE orders_queue
    SET status = ?, cancelled_at = ?, cancel_reason = ?
    WHERE id = ?
  `).run(newStatus, new Date().toISOString(), reason, orderId);

  return { ...row, status: newStatus, needsSync: newStatus === 'cancel_pending' };
}

// Empuja a WooCommerce las cancelaciones de órdenes que ya existían allá.
async function flushPendingCancellations() {
  const db = getDb();
  const pending = db.prepare(`
    SELECT * FROM orders_queue WHERE status = 'cancel_pending' AND wc_order_id IS NOT NULL
  `).all();

  let cancelled = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      await cancelWooOrder(row.wc_order_id);
      db.prepare(`UPDATE orders_queue SET status = 'cancelled' WHERE id = ?`).run(row.id);
      cancelled += 1;
    } catch (err) {
      // Se queda en 'cancel_pending' y se reintenta en el siguiente ciclo: la
      // cancelación local ya es válida para el corte aunque Woo no responda.
      console.error(`[cancelación] fallo en orden ${row.id}:`, err.message);
      failed += 1;
    }
  }

  return { attempted: pending.length, cancelled, failed };
}

module.exports = {
  queueOrder,
  flushPendingOrders,
  retryOrder,
  resolveManually,
  getQueueSummary,
  getErroredOrders,
  getRecentOrders,
  getOrderForReprint,
  cancelOrder,
  flushPendingCancellations,
};
