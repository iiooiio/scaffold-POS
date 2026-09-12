const { getDb } = require('../db/init');
const config = require('../config');

// Sesión de caja = un turno. Solo puede haber UNA abierta por caja a la vez.
// Todo vive en SQLite local: el corte funciona igual sin internet, que es el punto
// del proyecto. No se sincroniza a WooCommerce (Woo no tiene concepto de corte de caja).

function getOpenSession() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM cash_sessions
    WHERE register_id = ? AND status = 'open'
    ORDER BY id DESC LIMIT 1
  `).get(config.registerId) || null;
}

function openSession(openingFloat = 0) {
  const db = getDb();
  if (getOpenSession()) throw new Error('Ya hay una caja abierta en esta terminal');

  const result = db.prepare(`
    INSERT INTO cash_sessions (register_id, opened_at, opening_float, status)
    VALUES (?, ?, ?, 'open')
  `).run(config.registerId, new Date().toISOString(), openingFloat);

  return getSessionSummary(result.lastInsertRowid);
}

// type: 'in' (ingreso de efectivo) | 'out' (retiro, gasto, pago a proveedor)
function addMovement({ type, amount, reason = '' }) {
  const db = getDb();
  const session = getOpenSession();
  if (!session) throw new Error('No hay caja abierta');
  if (!['in', 'out'].includes(type)) throw new Error(`Tipo inválido: ${type}`);
  if (!(amount > 0)) throw new Error('El monto debe ser mayor a cero');

  db.prepare(`
    INSERT INTO cash_movements (session_id, type, amount, reason, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(session.id, type, amount, reason, new Date().toISOString());

  return getSessionSummary(session.id);
}

// Calcula el estado de una sesión. Solo cuenta ventas en EFECTIVO para el cálculo de
// cajón -- las de tarjeta se reportan aparte pero no afectan el efectivo esperado.
// Incluye ventas en cualquier estado de sincronización (pending/synced/error/resuelta):
// el dinero entró al cajón sin importar si ya subió a WooCommerce.
function getSessionSummary(sessionId) {
  const db = getDb();
  const session = db.prepare(`SELECT * FROM cash_sessions WHERE id = ?`).get(sessionId);
  if (!session) throw new Error(`Sesión ${sessionId} no encontrada`);

  // Las canceladas NO cuentan: el dinero se le devolvió al cliente, así que no está
  // en el cajón. Se excluyen en cualquier etapa de la cancelación (local o ya en Woo).
  const notCancelled = `status NOT IN ('cancelled_local', 'cancel_pending', 'cancelled')`;

  // NETO de devoluciones parciales: si se devolvieron $200 de una venta de $500, en el
  // cajón quedan $300. Restarlo aquí es lo que hace que el corte cuadre.
  const cashSales = db.prepare(`
    SELECT COALESCE(SUM(total - COALESCE(refunded_total, 0)), 0) AS total, COUNT(*) AS count
    FROM orders_queue
    WHERE cash_session_id = ? AND payment_method = 'cash' AND ${notCancelled}
  `).get(sessionId);

  const cashRefunds = db.prepare(`
    SELECT COALESCE(SUM(refunded_total), 0) AS total
    FROM orders_queue
    WHERE cash_session_id = ? AND payment_method = 'cash' AND ${notCancelled}
  `).get(sessionId);

  const cardSales = db.prepare(`
    SELECT COALESCE(SUM(total - COALESCE(refunded_total, 0)), 0) AS total, COUNT(*) AS count
    FROM orders_queue
    WHERE cash_session_id = ? AND payment_method = 'card' AND ${notCancelled}
  `).get(sessionId);

  const cancelled = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS count
    FROM orders_queue
    WHERE cash_session_id = ? AND status IN ('cancelled_local', 'cancel_pending', 'cancelled')
  `).get(sessionId);

  const movements = db.prepare(`
    SELECT type, COALESCE(SUM(amount), 0) AS total
    FROM cash_movements WHERE session_id = ? GROUP BY type
  `).all(sessionId);

  const cashIn = movements.find((m) => m.type === 'in')?.total || 0;
  const cashOut = movements.find((m) => m.type === 'out')?.total || 0;

  const expected = session.opening_float + cashSales.total + cashIn - cashOut;

  return {
    ...session,
    cashSalesTotal: cashSales.total,
    cashSalesCount: cashSales.count,
    cardSalesTotal: cardSales.total,
    cardSalesCount: cardSales.count,
    cancelledTotal: cancelled.total,
    cancelledCount: cancelled.count,
    partialRefundsTotal: cashRefunds.total,
    cashIn,
    cashOut,
    expected,
  };
}

function getCurrentSummary() {
  const session = getOpenSession();
  return session ? getSessionSummary(session.id) : null;
}

function getMovements(sessionId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM cash_movements WHERE session_id = ? ORDER BY id DESC
  `).all(sessionId);
}

// Cierra el turno. countedAmount = lo que el cajero contó físicamente en el cajón.
// La diferencia queda guardada aunque no cuadre -- ocultarla haría inútil el corte.
function closeSession(countedAmount) {
  const db = getDb();
  const session = getOpenSession();
  if (!session) throw new Error('No hay caja abierta');

  const summary = getSessionSummary(session.id);
  const difference = countedAmount - summary.expected;

  db.prepare(`
    UPDATE cash_sessions
    SET closed_at = ?, counted_amount = ?, expected_amount = ?, difference = ?, status = 'closed'
    WHERE id = ?
  `).run(new Date().toISOString(), countedAmount, summary.expected, difference, session.id);

  return { ...summary, counted_amount: countedAmount, difference, closed_at: new Date().toISOString() };
}

module.exports = {
  getOpenSession,
  openSession,
  addMovement,
  getSessionSummary,
  getCurrentSummary,
  getMovements,
  closeSession,
};
