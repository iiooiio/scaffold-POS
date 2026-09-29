const { getDb, nextLocalTicket } = require('../db/init');
const { createOrder, cancelWooOrder, getOrder, createRefund, isOnline } = require('./woo-client');
const { resolveWooCustomerId } = require('./customer-sync');
const { round2, allocateProportionally, mergeByMethod } = require('../money');
const config = require('../config');

const PAYMENT_TITLES = { cash: 'Efectivo', card: 'Tarjeta' };

// Normaliza la forma de pago a una lista [{ method, amount }], venga como venga.
// Acepta también el formato viejo (paymentMethod suelto, sin monto) para no romper
// las llamadas que ya existen ni las órdenes guardadas antes de los pagos divididos.
function normalizePayments({ payments, paymentMethod, total }) {
  const expected = round2(total);

  let list = Array.isArray(payments) && payments.length > 0
    ? payments
    : [{ method: paymentMethod || 'cash', amount: expected }];

  list = list
    .map((p) => ({
      method: p.method === 'card' ? 'card' : 'cash',
      amount: round2(Number(p.amount) || 0),
    }))
    .filter((p) => p.amount > 0);

  if (list.length === 0) throw new Error('La venta no tiene ningún pago registrado');

  // Dos renglones de "efectivo" son UN solo pago en efectivo. Se fusionan aquí para que
  // el corte no cuente la misma venta dos veces en el mismo método.
  list = mergeByMethod(list);

  const sum = round2(list.reduce((s, p) => s + p.amount, 0));

  // Un centavo de tolerancia: el reparto proporcional de un descuento puede dejar medio
  // centavo colgando. Más que eso es un error de captura y debe detenerse aquí, antes de
  // que entre al corte -- una venta cuyos pagos no suman el total descuadra la caja.
  if (Math.abs(sum - expected) > 0.01) {
    throw new Error(`Los pagos suman $${sum.toFixed(2)} y el total es $${expected.toFixed(2)}`);
  }

  // Si sobró o faltó un centavo, se ajusta en el pago MÁS GRANDE (nunca en el más chico:
  // restarle un centavo a un pago de $0.01 lo dejaría en cero).
  if (sum !== expected) {
    let biggest = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].amount > list[biggest].amount) biggest = i;
    }
    list[biggest].amount = round2(list[biggest].amount + (expected - sum));
  }

  return list;
}

function describePayments(payments) {
  return payments.map((p) => `${PAYMENT_TITLES[p.method]} $${p.amount.toFixed(2)}`).join(' + ');
}

// cartItems: [{ product_id, name, price, quantity }]
// payments:  [{ method, amount }] -- uno solo o varios (pago dividido). Si no se manda,
//            se arma uno solo por el total con `paymentMethod`.
// cashInfo:  { received, change } -- solo aplica a la PARTE en efectivo.
// Construye el payload en formato WooCommerce y lo guarda en la cola local.
// Devuelve el ticket local de inmediato (no espera red) para poder imprimir ya.
function queueOrder({ cartItems, customerNote = '', paymentMethod = 'cash', payments, cashInfo, customerId, cashSessionId = null, couponCode = null }) {
  const db = getDb();
  const localTicket = nextLocalTicket(config.registerId);
  // El total sale de line_total, NO de price * quantity.
  //
  // BUG CORREGIDO: eran dos cuentas distintas. computeCart() reparte el descuento del
  // ticket entre las líneas y deja que la última absorba el redondeo, así que
  // sum(price * quantity) puede diferir en centavos de sum(line_total) -- que es lo que
  // se imprime en el ticket y lo que main.js le devuelve a la pantalla. Con pagos
  // divididos esa diferencia ya no es cosmética: haría fallar la validación de que los
  // pagos suman el total.
  const total = round2(cartItems.reduce((sum, i) => sum + (i.line_total ?? i.price * i.quantity), 0));

  const paymentList = normalizePayments({ payments, paymentMethod, total });
  const isSplit = paymentList.length > 1;
  const cashPart = paymentList.find((p) => p.method === 'cash');

  // Qué se guarda en orders_queue.payment_method:
  //   - un solo método -> 'cash' | 'card', como siempre
  //   - varios         -> 'split', y el desglose real vive en order_payments
  // La columna se conserva porque el plugin woo-admin-app y los reportes viejos la leen.
  const storedMethod = isSplit ? 'split' : paymentList[0].method;

  const metaData = [
    { key: '_pos_register_id', value: config.registerId },
    { key: '_pos_local_ticket', value: localTicket },
  ];

  // Origen de la orden. Se manda SOLO source_type, sin campos UTM.
  //
  // BUG CORREGIDO: antes se mandaba source_type='utm' junto con utm_source/utm_medium.
  // Con source_type='utm', WooCommerce intenta renderizar también utm_campaign,
  // device_type y session_page_views en los metaboxes "Order attribution" y "Customer
  // history" -- y al no existir, truena con error crítico el detalle de la orden y el
  // historial del cliente. 'mobile_app' es un valor válido del enum que no arrastra
  // campos acompañantes.
  if (config.orderAttribution && config.orderAttribution !== 'none') {
    metaData.push({ key: '_wc_order_attribution_source_type', value: config.orderAttribution });
  }
  // El código va como meta, NO como coupon_lines: si se mandaran coupon_lines,
  // WooCommerce recalcularía los totales por su cuenta e ignoraría los subtotal/total
  // explícitos, dejando el ticket y la orden con montos distintos. Ver coupon-sync.js.
  if (couponCode) {
    metaData.push({ key: '_pos_coupon_code', value: couponCode });
  }

  // WooCommerce no tiene pagos divididos: una orden lleva UN payment_method y ya.
  // Por eso el desglose va como meta. Es la única forma de que quien abra la orden en
  // wp-admin vea con qué se pagó realmente, sin inventar un plugin de pasarela falso.
  metaData.push({ key: '_pos_payments', value: JSON.stringify(paymentList) });

  if (cashPart && cashInfo) {
    metaData.push({ key: '_pos_cash_received', value: String(cashInfo.received) });
    metaData.push({ key: '_pos_cash_change', value: String(cashInfo.change) });
  }

  // Los productos temporales no existen en el catálogo, así que no pueden ir como
  // line_items (Woo exige product_id). Van como fee_lines, que aceptan nombre y monto
  // libres. Funciona offline igual, porque no dependen de que exista nada en Woo.
  //
  // tax_status: 'none' a propósito -- así el monto cobrado es exactamente el del ticket.
  // Si necesitas que Woo les calcule impuesto, cámbialo a 'taxable'.
  const catalogItems = cartItems.filter((i) => !i.custom);
  const customItems = cartItems.filter((i) => i.custom);

  const payload = {
    payment_method: isSplit ? 'pos_split' : paymentList[0].method,
    // El título SÍ lleva el desglose: es lo que se ve en la lista de pedidos de wp-admin
    // sin tener que abrir la orden ni leer metas.
    payment_method_title: isSplit
      ? `Dividido: ${describePayments(paymentList)}`
      : (PAYMENT_TITLES[paymentList[0].method] || paymentList[0].method),
    set_paid: true,
    status: 'completed',
    customer_note: customerNote,
    meta_data: metaData,
    // subtotal/total explícitos: sin esto WooCommerce recalcula con SU precio de
    // catálogo e ignoraría el ajuste porcentual, dejando el ticket impreso y la orden
    // en Woo con montos distintos.
    // subtotal = antes de descuento, total = después. Es la semántica nativa de
    // WooCommerce: la diferencia entre ambos ES el descuento, y así se ve correcto en
    // el detalle de la orden sin tener que inventar nada.
    line_items: catalogItems.map((item) => {
      const subtotal = (item.line_subtotal ?? item.price * item.quantity).toFixed(2);
      const lineTotal = (item.line_total ?? item.price * item.quantity).toFixed(2);
      return {
        product_id: item.product_id,
        ...(item.variation_id ? { variation_id: item.variation_id } : {}),
        quantity: item.quantity,
        subtotal,
        total: lineTotal,
      };
    }),
    // Solo se incluye si hay temporales: mandar un arreglo vacío no aporta nada y evita
    // sorpresas con validaciones de Woo.
    ...(customItems.length > 0 ? {
      fee_lines: customItems.map((item) => ({
        name: item.quantity > 1 ? `${item.name} (x${item.quantity})` : item.name,
        // Los fee_lines no tienen subtotal, así que el descuento ya viene aplicado.
        total: (item.line_total ?? item.price * item.quantity).toFixed(2),
        tax_status: 'none',
      })),
    } : {}),
  };

  // Se guarda product_id/variation_id además del nombre: sin eso no hay forma de decirle
  // a WooCommerce QUÉ línea devolver en una cancelación parcial (y por lo tanto tampoco
  // de que reponga el inventario correcto).
  const displayItems = cartItems.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    // price es el EFECTIVO (ya con descuento): es el que usan las devoluciones para
    // calcular cuánto dinero regresar.
    price: i.price,
    list_price: i.list_price ?? i.price,
    discount_amount: i.discount_amount ?? 0,
    product_id: i.custom ? null : i.product_id,
    variation_id: i.variation_id || null,
    custom: Boolean(i.custom),
  }));

  // La venta y sus pagos se guardan en UNA transacción. Si se guardara la orden y fallara
  // el insert de los pagos, esa venta quedaría fuera del corte: entraría dinero al cajón
  // que el sistema no contaría.
  const insertOrder = db.prepare(`
    INSERT INTO orders_queue
      (local_ticket, register_id, payload_json, display_items_json, total,
       payment_method, cash_session_id, customer_ref, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const insertPayment = db.prepare(`
    INSERT INTO order_payments (order_local_id, method, amount) VALUES (?, ?, ?)
  `);

  const save = db.transaction(() => {
    const result = insertOrder.run(
      localTicket,
      config.registerId,
      JSON.stringify(payload),
      JSON.stringify(displayItems),
      total,
      storedMethod,
      cashSessionId,
      customerId || null,
      new Date().toISOString()
    );
    for (const payment of paymentList) {
      insertPayment.run(result.lastInsertRowid, payment.method, payment.amount);
    }
    return result.lastInsertRowid;
  });

  const orderLocalId = save();

  return { localTicket, orderLocalId, payload, cartItems, payments: paymentList, total };
}

// El desglose de pagos de una venta. Sale de order_payments, no de las metas del payload:
// así también funciona para las ventas viejas, a las que la migración les creó su renglón.
function getOrderPayments(orderId) {
  const db = getDb();
  return db.prepare(`
    SELECT method, amount FROM order_payments WHERE order_local_id = ? ORDER BY id ASC
  `).all(orderId);
}

// Intenta sincronizar UNA orden puntual. Se usa tanto en el auto-sync (solo 'pending')
// como en el retry manual desde la UI (una orden en 'error' específica).
async function trySyncOrder(db, row) {
  try {
    const payload = JSON.parse(row.payload_json);

    // El customer_id de Woo se resuelve AQUÍ, no al guardar la venta: si el cliente se
    // creó sin conexión, su id de Woo no existía en ese momento.
    if (row.customer_ref) {
      const wooCustomerId = resolveWooCustomerId(row.customer_ref);
      if (!wooCustomerId) {
        throw new Error('El cliente de esta venta todavía no se ha creado en WooCommerce');
      }
      payload.customer_id = wooCustomerId;
    }

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

  if (rows.length === 0) return rows;

  // Los pagos se traen en UNA consulta, no una por venta: con 50 ventas en pantalla,
  // 50 consultas extra se notan al abrir el historial.
  const byOrder = new Map();
  const placeholders = rows.map(() => '?').join(',');
  for (const p of db.prepare(`
    SELECT order_local_id, method, amount FROM order_payments
    WHERE order_local_id IN (${placeholders}) ORDER BY id ASC
  `).all(...rows.map((r) => r.id))) {
    if (!byOrder.has(p.order_local_id)) byOrder.set(p.order_local_id, []);
    byOrder.get(p.order_local_id).push({ method: p.method, amount: p.amount });
  }

  return rows.map((r) => ({ ...r, payments: byOrder.get(r.id) || [] }));
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

  const payments = db.prepare(`
    SELECT method, amount FROM order_payments WHERE order_local_id = ? ORDER BY id ASC
  `).all(orderId);

  return {
    localTicket: row.local_ticket,
    // Órdenes viejas (anteriores a esta columna) pueden no tener items guardados.
    cartItems: JSON.parse(row.display_items_json || '[]'),
    total: row.total,
    paymentMethod: row.payment_method || payload.payment_method,
    payments,
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
    SET status = ?, cancelled_at = ?, cancel_reason = ?, refunded_total = COALESCE(total, 0)
    WHERE id = ?
  `).run(newStatus, new Date().toISOString(), reason, orderId);

  return { ...row, status: newStatus, needsSync: newStatus === 'cancel_pending' };
}

// Devolución PARCIAL. items: [{ index, quantity }] donde index apunta a la posición en
// display_items de la orden. Devuelve el resumen para imprimir el comprobante.
//
// Si la devolución cubre el total de la venta, se trata como cancelación completa
// (cancelOrder) en vez de refund: cancelar es más limpio que devolver el 100%.
function refundOrderItems(orderId, items, reason = '') {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM orders_queue WHERE id = ?`).get(orderId);
  if (!row) throw new Error(`Venta ${orderId} no encontrada`);
  if (CANCELLED_STATUSES.includes(row.status)) throw new Error('Esta venta ya está cancelada');

  const displayItems = JSON.parse(row.display_items_json || '[]');
  if (displayItems.length === 0) {
    throw new Error('Esta venta no tiene el detalle guardado (es anterior a esta función)');
  }

  const refundItems = [];
  let amount = 0;

  for (const sel of items) {
    const item = displayItems[sel.index];
    if (!item) throw new Error(`Línea ${sel.index} no existe en esta venta`);
    const qty = Number(sel.quantity) || 0;
    if (qty <= 0) continue;

    const alreadyRefunded = getRefundedQuantity(db, orderId, sel.index);
    if (qty + alreadyRefunded > item.quantity) {
      throw new Error(`No puedes devolver ${qty} de "${item.name}": solo quedan ${item.quantity - alreadyRefunded}`);
    }

    const lineAmount = Math.round(item.price * qty * 100) / 100;
    amount += lineAmount;
    refundItems.push({
      index: sel.index,
      product_id: item.product_id,
      variation_id: item.variation_id,
      quantity: qty,
      amount: lineAmount,
      name: item.name,
      custom: Boolean(item.custom),
    });
  }

  if (refundItems.length === 0) throw new Error('No seleccionaste nada para devolver');

  amount = Math.round(amount * 100) / 100;
  const pendingTotal = Math.round(((row.total || 0) - (row.refunded_total || 0)) * 100) / 100;

  const orderPayments = db.prepare(`
    SELECT method, amount FROM order_payments WHERE order_local_id = ? ORDER BY id ASC
  `).all(orderId);

  if (amount >= pendingTotal) {
    // Devolver todo lo que queda = cancelar la venta completa.
    const result = cancelOrder(orderId, reason || 'Devolución total');
    return {
      ...result,
      amount: pendingTotal,
      items: refundItems,
      payments: splitAcrossPayments(orderPayments, row.total || 0, pendingTotal),
      fullCancellation: true,
    };
  }

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO refunds_queue (order_local_id, amount, items_json, reason, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(orderId, amount, JSON.stringify(refundItems), reason, new Date().toISOString());

    db.prepare(`
      UPDATE orders_queue SET refunded_total = COALESCE(refunded_total, 0) + ? WHERE id = ?
    `).run(amount, orderId);
  });
  tx();

  return {
    local_ticket: row.local_ticket,
    payment_method: row.payment_method,
    amount,
    items: refundItems,
    payments: splitAcrossPayments(orderPayments, row.total || 0, amount),
    fullCancellation: false,
  };
}

// Cuánto se le devuelve a cada método. Usa EXACTAMENTE la misma función que el corte de
// caja (money.js), no una copia parecida: si el comprobante impreso y el corte usaran dos
// repartos distintos, el papel que se lleva el cliente diría una cosa y la caja otra.
function splitAcrossPayments(payments, orderTotal, amount) {
  return allocateProportionally(mergeByMethod(payments), orderTotal, amount)
    .filter((p) => p.amount !== 0);
}

// Cuánto se ha devuelto ya de una línea concreta, para no permitir devolver de más.
function getRefundedQuantity(db, orderId, index) {
  const rows = db.prepare(`
    SELECT items_json FROM refunds_queue WHERE order_local_id = ? AND status != 'error'
  `).all(orderId);

  let total = 0;
  for (const r of rows) {
    for (const item of JSON.parse(r.items_json || '[]')) {
      if (item.index === index) total += item.quantity;
    }
  }
  return total;
}

// Devuelve el detalle de una venta con lo ya devuelto por línea, para pintar la UI.
function getOrderRefundState(orderId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM orders_queue WHERE id = ?`).get(orderId);
  if (!row) throw new Error(`Venta ${orderId} no encontrada`);

  const displayItems = JSON.parse(row.display_items_json || '[]');
  return {
    id: row.id,
    local_ticket: row.local_ticket,
    total: row.total,
    refunded_total: row.refunded_total || 0,
    items: displayItems.map((item, index) => ({
      ...item,
      index,
      refunded: getRefundedQuantity(db, orderId, index),
      available: item.quantity - getRefundedQuantity(db, orderId, index),
    })),
  };
}

// Empuja a WooCommerce las devoluciones parciales pendientes.
//
// Los ids de línea los asigna Woo, así que hay que leer la orden de allá y emparejar por
// product_id/variation_id. Si el emparejamiento falla (o la línea era un producto
// temporal, que en Woo es un fee_line), se manda una devolución SOLO por monto: el
// dinero queda correcto, pero Woo no repone inventario de esa línea.
async function flushPendingRefunds() {
  const db = getDb();
  const pending = db.prepare(`
    SELECT r.*, o.wc_order_id
    FROM refunds_queue r
    JOIN orders_queue o ON o.id = r.order_local_id
    WHERE r.status = 'pending' AND o.wc_order_id IS NOT NULL
  `).all();

  let done = 0;
  let failed = 0;

  for (const refund of pending) {
    try {
      const items = JSON.parse(refund.items_json || '[]');
      const payload = {
        amount: refund.amount.toFixed(2),
        reason: refund.reason || 'Devolución parcial desde POS',
        api_restock: true,
      };

      try {
        const wcOrder = await getOrder(refund.wc_order_id);
        const lineItems = [];

        for (const item of items) {
          if (item.custom || !item.product_id) continue; // fee_line: solo monto
          const match = (wcOrder.line_items || []).find(
            (li) => li.product_id === item.product_id
              && (item.variation_id ? li.variation_id === item.variation_id : true)
          );
          if (!match) continue;
          lineItems.push({
            id: match.id,
            quantity: item.quantity,
            refund_total: item.amount.toFixed(2),
          });
        }

        if (lineItems.length > 0) payload.line_items = lineItems;
      } catch (err) {
        console.error(`[devolución] no se pudo leer la orden ${refund.wc_order_id}, se devuelve solo monto:`, err.message);
      }

      const created = await createRefund(refund.wc_order_id, payload);
      db.prepare(`
        UPDATE refunds_queue SET status = 'done', wc_refund_id = ?, synced_at = ?, error_message = NULL
        WHERE id = ?
      `).run(created.id, new Date().toISOString(), refund.id);
      done += 1;
    } catch (err) {
      db.prepare(`UPDATE refunds_queue SET status = 'error', error_message = ? WHERE id = ?`)
        .run(err.message, refund.id);
      console.error(`[devolución] fallo en la devolución ${refund.id}:`, err.message);
      failed += 1;
    }
  }

  return { attempted: pending.length, done, failed };
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
  getOrderPayments,
  normalizePayments,
  splitAcrossPayments,
  flushPendingOrders,
  retryOrder,
  resolveManually,
  getQueueSummary,
  getErroredOrders,
  getRecentOrders,
  getOrderForReprint,
  cancelOrder,
  flushPendingCancellations,
  refundOrderItems,
  getOrderRefundState,
  flushPendingRefunds,
};
