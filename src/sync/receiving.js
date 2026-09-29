const { getDb } = require('../db/init');
const { getProductStock, setProductStock, isOnline } = require('./woo-client');
const config = require('../config');

// Recepción de mercancía SIN orden de compra previa: entrada directa a inventario.
//
// Igual que las ventas, se guarda local primero y se empuja a WooCommerce después, para
// que el almacenista pueda recibir sin conexión.

// lines: [{ product_id, variation_id, name, sku, quantity }]
function queueReceipt({ lines, note = '' }) {
  const db = getDb();
  if (!lines || lines.length === 0) throw new Error('No hay nada que recibir');

  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO stock_receipts (register_id, note, status, created_at)
      VALUES (?, ?, 'pending', ?)
    `).run(config.registerId, note, new Date().toISOString());

    const insertLine = db.prepare(`
      INSERT INTO stock_receipt_lines (receipt_id, product_id, variation_id, name, sku, quantity)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const line of lines) {
      if (!(line.quantity > 0)) continue;
      insertLine.run(
        result.lastInsertRowid,
        line.product_id,
        line.variation_id || null,
        line.name || null,
        line.sku || null,
        line.quantity
      );

      // Se refleja de una vez en la caché local para que el catálogo muestre el stock
      // nuevo aunque todavía no haya subido a Woo.
      if (line.variation_id) {
        db.prepare(`
          UPDATE product_variations
          SET stock_quantity = COALESCE(stock_quantity, 0) + ?
          WHERE id = ? AND manage_stock = 1
        `).run(line.quantity, line.variation_id);
      } else {
        db.prepare(`
          UPDATE products
          SET stock_quantity = COALESCE(stock_quantity, 0) + ?
          WHERE id = ? AND manage_stock = 1
        `).run(line.quantity, line.product_id);
      }
    }

    return result.lastInsertRowid;
  });

  return { id: tx(), lines: lines.length };
}

// Sube las recepciones pendientes.
//
// LIMITACIÓN CONOCIDA: la REST API de WooCommerce no tiene "sumar N al stock", solo
// permite escribir el valor absoluto. Así que se lee el stock actual y se escribe la
// suma. Si otra caja o la tienda en línea vende ese producto entre la lectura y la
// escritura, ese movimiento se pierde. La ventana es de milisegundos, pero existe.
// Por eso cada línea se marca `applied` por separado: un reintento nunca vuelve a sumar
// una línea que ya se aplicó.
async function flushPendingReceipts() {
  const db = getDb();
  if (!await isOnline()) return { attempted: 0, synced: 0, failed: 0 };

  const pending = db.prepare(`
    SELECT * FROM stock_receipts WHERE status IN ('pending', 'error') ORDER BY id ASC
  `).all();

  let synced = 0;
  let failed = 0;

  for (const receipt of pending) {
    const lines = db.prepare(`
      SELECT * FROM stock_receipt_lines WHERE receipt_id = ? AND applied = 0
    `).all(receipt.id);

    let lineErrors = 0;

    for (const line of lines) {
      try {
        const current = await getProductStock(line.product_id, line.variation_id);
        if (!current.manage_stock) {
          throw new Error('El producto no maneja inventario en WooCommerce');
        }
        const nuevo = (current.stock_quantity || 0) + line.quantity;
        await setProductStock(line.product_id, line.variation_id, nuevo);

        db.prepare(`UPDATE stock_receipt_lines SET applied = 1, error_message = NULL WHERE id = ?`)
          .run(line.id);
      } catch (err) {
        db.prepare(`UPDATE stock_receipt_lines SET error_message = ? WHERE id = ?`)
          .run(err.message, line.id);
        console.error(`[recepción] línea ${line.id} falló:`, err.message);
        lineErrors += 1;
      }
    }

    if (lineErrors === 0) {
      db.prepare(`
        UPDATE stock_receipts SET status = 'synced', synced_at = ?, error_message = NULL WHERE id = ?
      `).run(new Date().toISOString(), receipt.id);
      synced += 1;
    } else {
      db.prepare(`
        UPDATE stock_receipts SET status = 'error', error_message = ? WHERE id = ?
      `).run(`${lineErrors} línea(s) con error`, receipt.id);
      failed += 1;
    }
  }

  return { attempted: pending.length, synced, failed };
}

function getRecentReceipts(limit = 30) {
  const db = getDb();
  const receipts = db.prepare(`
    SELECT * FROM stock_receipts WHERE register_id = ? ORDER BY id DESC LIMIT ?
  `).all(config.registerId, limit);

  return receipts.map((r) => ({
    ...r,
    lines: db.prepare(`SELECT * FROM stock_receipt_lines WHERE receipt_id = ?`).all(r.id),
  }));
}

module.exports = { queueReceipt, flushPendingReceipts, getRecentReceipts };
