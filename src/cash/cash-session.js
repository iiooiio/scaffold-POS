const { getDb } = require('../db/init');
const { round2, allocateProportionally, mergeByMethod } = require('../money');
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
  const CANCELLED = ['cancelled_local', 'cancel_pending', 'cancelled'];

  // El cálculo se hace en JS, no en SQL, porque con pagos divididos deja de ser una suma
  // directa: hay que repartir la devolución entre los métodos de cada venta.
  const orders = db.prepare(`
    SELECT id, total, refunded_total, status FROM orders_queue
    WHERE cash_session_id = ? ORDER BY id ASC
  `).all(sessionId);

  // ORDER BY p.id no es cosmético: el reparto de devoluciones deja el redondeo en el
  // ÚLTIMO renglón, así que un orden distinto movería un centavo de cubeta. Sin el ORDER
  // BY, SQLite no garantiza ningún orden y el mismo corte podría dar dos resultados.
  // El iPad ordena igual (POSStore.salesForSession) porque venden contra la misma tienda.
  const paymentsByOrder = new Map();
  for (const row of db.prepare(`
    SELECT p.order_local_id, p.method, p.amount
    FROM order_payments p
    JOIN orders_queue o ON o.id = p.order_local_id
    WHERE o.cash_session_id = ?
    ORDER BY p.id ASC
  `).all(sessionId)) {
    if (!paymentsByOrder.has(row.order_local_id)) paymentsByOrder.set(row.order_local_id, []);
    paymentsByOrder.get(row.order_local_id).push(row);
  }

  let cashNet = 0, cardNet = 0, cashRefunded = 0;
  let cashCount = 0, cardCount = 0;
  let cancelledTotal = 0, cancelledCount = 0;

  for (const order of orders) {
    if (CANCELLED.includes(order.status)) {
      cancelledTotal += order.total || 0;
      cancelledCount += 1;
      continue;
    }

    const payments = mergeByMethod(paymentsByOrder.get(order.id) || []);
    const total = order.total || 0;
    const refunded = order.refunded_total || 0;

    // Se reparte lo DEVUELTO y de ahí se resta, en vez de multiplicar cada método por un
    // factor. Suena equivalente y no lo es:
    //
    //   - multiplicando, cada cubeta redondea por su cuenta y las dos juntas pueden sumar
    //     un centavo más (o menos) de lo que realmente se vendió. En el corte eso aparece
    //     como un descuadre fantasma que nadie puede explicar.
    //   - repartiendo, las partes suman exacto y lo retenido es "lo cobrado menos lo
    //     devuelto", que por construcción cuadra.
    //
    // Además usa LA MISMA función que imprime el comprobante de devolución, así que el
    // papel que se lleva el cliente y el efectivo que falta en el cajón dicen lo mismo.
    const refundParts = allocateProportionally(payments, total, refunded);
    const refundByMethod = new Map(refundParts.map((p) => [p.method, p.amount]));

    for (const payment of payments) {
      const givenBack = refundByMethod.get(payment.method) || 0;
      const retained = round2(payment.amount - givenBack);
      if (payment.method === 'card') {
        cardNet += retained;
        cardCount += 1;
      } else {
        cashNet += retained;
        cashRefunded += givenBack;
        cashCount += 1;
      }
    }
  }

  const cashSales = { total: round2(cashNet), count: cashCount };
  const cardSales = { total: round2(cardNet), count: cardCount };
  const cashRefunds = { total: round2(cashRefunded) };
  const cancelled = { total: round2(cancelledTotal), count: cancelledCount };

  const movements = db.prepare(`
    SELECT type, COALESCE(SUM(amount), 0) AS total
    FROM cash_movements WHERE session_id = ? GROUP BY type
  `).all(sessionId);

  const cashIn = movements.find((m) => m.type === 'in')?.total || 0;
  const cashOut = movements.find((m) => m.type === 'out')?.total || 0;

  const expected = round2(session.opening_float + cashSales.total + cashIn - cashOut);

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
