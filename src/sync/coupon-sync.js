const { getDb } = require('../db/init');
const { fetchAllCoupons } = require('./woo-client');

// DECISIÓN DE DISEÑO IMPORTANTE
//
// El descuento del cupón se calcula AQUÍ, no en WooCommerce, y la orden NO lleva
// `coupon_lines`. El código del cupón viaja como meta (`_pos_coupon_code`).
//
// Por qué: si se mandaran coupon_lines, WooCommerce recalcularía los totales por su
// cuenta e ignoraría los subtotal/total explícitos que enviamos. El ticket impreso y la
// orden dejarían de coincidir -- justo el problema que este proyecto lleva evitando en
// todo lo demás. Y offline sería imposible saber cuánto cobrar.
//
// Lo que se pierde con esta decisión, y hay que tenerlo claro:
//   - El contador de usos del cupón NO se incrementa en WooCommerce.
//   - Los límites (usage_limit) se validan contra el conteo de la ÚLTIMA sincronización,
//     así que un cupón de un solo uso podría aceptarse en dos cajas a la vez.
//   - Restricciones que WooCommerce valida server-side (por cliente, por rol, etc.) no
//     se replican aquí.
// Para cupones de marketing masivo esto es aceptable; para cupones únicos de alto valor
// conviene no usarlos en el POS.

function upsertCoupon(db, c) {
  db.prepare(`
    INSERT INTO coupons (id, code, discount_type, amount, minimum_amount, maximum_amount,
                          date_expires, usage_limit, usage_count, individual_use,
                          product_ids, excluded_product_ids, updated_at)
    VALUES (@id, @code, @discount_type, @amount, @minimum_amount, @maximum_amount,
            @date_expires, @usage_limit, @usage_count, @individual_use,
            @product_ids, @excluded_product_ids, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      code = excluded.code,
      discount_type = excluded.discount_type,
      amount = excluded.amount,
      minimum_amount = excluded.minimum_amount,
      maximum_amount = excluded.maximum_amount,
      date_expires = excluded.date_expires,
      usage_limit = excluded.usage_limit,
      usage_count = excluded.usage_count,
      individual_use = excluded.individual_use,
      product_ids = excluded.product_ids,
      excluded_product_ids = excluded.excluded_product_ids,
      updated_at = excluded.updated_at
  `).run({
    id: c.id,
    code: (c.code || '').toLowerCase(),
    discount_type: c.discount_type,
    amount: parseFloat(c.amount) || 0,
    minimum_amount: parseFloat(c.minimum_amount) || 0,
    maximum_amount: parseFloat(c.maximum_amount) || 0,
    date_expires: c.date_expires || null,
    usage_limit: c.usage_limit ?? null,
    usage_count: c.usage_count ?? 0,
    individual_use: c.individual_use ? 1 : 0,
    product_ids: JSON.stringify(c.product_ids || []),
    excluded_product_ids: JSON.stringify(c.excluded_product_ids || []),
    updated_at: c.date_modified_gmt || new Date().toISOString(),
  });
}

async function syncCoupons() {
  const db = getDb();
  const coupons = await fetchAllCoupons();

  const tx = db.transaction((items) => {
    // Reemplazo completo: un cupón borrado en Woo debe dejar de funcionar aquí.
    db.prepare(`DELETE FROM coupons`).run();
    for (const c of items) upsertCoupon(db, c);
  });
  tx(coupons);

  return { count: coupons.length, syncedAt: new Date().toISOString() };
}

// Busca y valida un cupón contra el carrito. Devuelve el descuento ya calculado o un
// error legible para el cajero.
//
// cartLines: [{ product_id, variation_id, quantity, amount }] con el importe de cada
// línea DESPUÉS de descuentos de línea (es la base sobre la que aplica el cupón).
function evaluateCoupon(code, cartLines) {
  const db = getDb();
  const clean = (code || '').trim().toLowerCase();
  if (!clean) throw new Error('Captura un código');

  const coupon = db.prepare(`SELECT * FROM coupons WHERE code = ?`).get(clean);
  if (!coupon) throw new Error(`El cupón "${code}" no existe o no se ha sincronizado`);

  if (coupon.date_expires) {
    // Woo guarda la fecha sin hora; se considera válido durante todo ese día.
    const expires = new Date(`${coupon.date_expires.slice(0, 10)}T23:59:59`);
    if (new Date() > expires) throw new Error('Este cupón ya venció');
  }

  if (coupon.usage_limit !== null && coupon.usage_count >= coupon.usage_limit) {
    throw new Error('Este cupón ya llegó a su límite de usos');
  }

  const included = JSON.parse(coupon.product_ids || '[]');
  const excluded = JSON.parse(coupon.excluded_product_ids || '[]');

  // Base elegible: si el cupón limita a ciertos productos, solo esos cuentan.
  const eligible = cartLines.filter((l) => {
    if (l.custom || !l.product_id) return included.length === 0;
    if (excluded.includes(l.product_id)) return false;
    if (included.length > 0 && !included.includes(l.product_id)) return false;
    return true;
  });

  const eligibleBase = round2(eligible.reduce((sum, l) => sum + l.amount, 0));
  const cartBase = round2(cartLines.reduce((sum, l) => sum + l.amount, 0));

  if (eligibleBase <= 0) throw new Error('Ningún producto del carrito aplica para este cupón');
  if (coupon.minimum_amount > 0 && cartBase < coupon.minimum_amount) {
    throw new Error(`Este cupón requiere una compra mínima de $${coupon.minimum_amount.toFixed(2)}`);
  }
  if (coupon.maximum_amount > 0 && cartBase > coupon.maximum_amount) {
    throw new Error(`Este cupón solo aplica en compras de hasta $${coupon.maximum_amount.toFixed(2)}`);
  }

  let discount;
  if (coupon.discount_type === 'percent') {
    discount = round2(eligibleBase * coupon.amount / 100);
  } else if (coupon.discount_type === 'fixed_product') {
    // Monto fijo por PIEZA de los productos elegibles.
    const units = eligible.reduce((sum, l) => sum + l.quantity, 0);
    discount = round2(coupon.amount * units);
  } else {
    // fixed_cart y cualquier otro tipo: monto fijo sobre el carrito.
    discount = round2(coupon.amount);
  }

  discount = Math.min(discount, eligibleBase); // nunca más que la base elegible

  return {
    code: coupon.code,
    discount_type: coupon.discount_type,
    amount: coupon.amount,
    discount,
    eligibleBase,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { syncCoupons, evaluateCoupon };
