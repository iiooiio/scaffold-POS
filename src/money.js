// Aritmética de dinero, en un solo lugar.
//
// Vive aparte porque el ticket impreso, el comprobante de devolución y el corte de caja
// TIENEN que redondear igual. Cuando cada uno traía su propia cuenta, dos cubetas
// redondeadas por separado se desfasaban un centavo y el corte arrastraba la diferencia.

// Réplica exacta de Math.round(x * 100) / 100.
//
// Es la misma definición que se portó a Swift en el POS de iPad (Money.swift). No es la
// forma más "correcta" de redondear dinero -- Decimal lo sería -- pero el iPad y las
// cajas Windows venden contra la MISMA tienda: si redondearan distinto, dos cajas
// cobrarían diferente por el mismo carrito, que es peor que el error de punto flotante.
function round2(n) {
  return Math.round(n * 100) / 100;
}

// Reparte `amount` entre `payments` en proporción a lo que se cobró con cada método.
//
// Proporcional no es una preferencia estética: a una tarjeta no se le puede devolver más
// de lo que se le cargó, y el reparto proporcional lo respeta por construcción.
//
// El último renglón absorbe el redondeo, así que las partes suman EXACTO `amount`.
// Sin eso, repartir $33.33 entre dos métodos da $16.665 de cada lado, cada uno redondea
// para arriba y de la nada aparece un centavo que nadie pagó.
//
// payments: [{ method, amount }]  base: el total contra el que se calcula la proporción
function allocateProportionally(payments, base, amount) {
  if (!payments || payments.length === 0) return [];
  if (payments.length === 1) return [{ method: payments[0].method, amount: round2(amount) }];
  if (!(base > 0)) return [];

  const parts = payments.map((p) => ({
    method: p.method,
    amount: round2(amount * (p.amount / base)),
  }));

  const diff = round2(amount - parts.reduce((sum, p) => sum + p.amount, 0));
  if (diff !== 0) {
    parts[parts.length - 1].amount = round2(parts[parts.length - 1].amount + diff);
  }

  return parts;
}

// Agrupa renglones de pago por método. Las ventas nuevas ya llegan fusionadas, pero las
// que migró init.js pueden traer más de un renglón del mismo método.
function mergeByMethod(payments) {
  const merged = new Map();
  for (const p of payments || []) {
    merged.set(p.method, round2((merged.get(p.method) || 0) + (p.amount || 0)));
  }
  return [...merged].map(([method, amount]) => ({ method, amount }));
}

module.exports = { round2, allocateProportionally, mergeByMethod };
