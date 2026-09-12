const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getDb } = require('./init');
const { fetchAllIds, isOnline } = require('../sync/woo-client');
const { createBackup } = require('./backup');

const IMAGES_DIR = () => path.join(app.getPath('userData'), 'product-images');

// Limpia de la caché local lo que ya no existe en WooCommerce.
//
// SIEMPRE hace un respaldo antes de borrar nada: si algo sale mal (una respuesta
// incompleta de Woo, por ejemplo) se puede volver atrás.
//
// NO toca las órdenes: son el historial de ventas de esta caja, incluye reimpresiones y
// cortes, y nada de eso se puede recuperar de Woo.
async function cleanupCache() {
  if (!await isOnline()) {
    throw new Error('Se necesita conexión: hay que preguntarle a WooCommerce qué sigue existiendo');
  }

  const backup = await createBackup('pre-limpieza');
  const db = getDb();
  const result = { backup: backup.path, products: 0, variations: 0, customers: 0, images: 0 };

  // --- Productos ---
  const wooProductIds = await fetchAllIds('products');
  if (wooProductIds.size === 0) {
    // Un catálogo vacío es casi siempre una respuesta rara, no una tienda sin productos.
    // Borrar todo por una lectura mala sería peor que no limpiar.
    throw new Error('WooCommerce no devolvió ningún producto. Se abortó la limpieza por seguridad.');
  }

  const localProducts = db.prepare(`SELECT id FROM products`).all();
  const deleteProduct = db.prepare(`DELETE FROM products WHERE id = ?`);
  const deleteVariationsOf = db.prepare(`DELETE FROM product_variations WHERE parent_id = ?`);

  const txProducts = db.transaction(() => {
    for (const row of localProducts) {
      if (!wooProductIds.has(row.id)) {
        deleteVariationsOf.run(row.id);
        deleteProduct.run(row.id);
        result.products += 1;
      }
    }
  });
  txProducts();

  // Variaciones cuyo producto padre ya no está localmente (por si quedó algo suelto).
  result.variations = db.prepare(`
    DELETE FROM product_variations
    WHERE parent_id NOT IN (SELECT id FROM products)
  `).run().changes;

  // --- Clientes ---
  const wooCustomerIds = await fetchAllIds('customers');
  // No se borra:
  //   - pending_sync = 1  -> todavía no existe en Woo, se crearía de nuevo
  //   - referenciado por una venta que aún no sube -> la venta fallaría al sincronizar
  const localCustomers = db.prepare(`
    SELECT c.id, c.woo_id FROM customers c
    WHERE c.pending_sync = 0
      AND c.id NOT IN (
        SELECT customer_ref FROM orders_queue
        WHERE customer_ref IS NOT NULL AND status IN ('pending', 'error')
      )
  `).all();

  const deleteCustomer = db.prepare(`DELETE FROM customers WHERE id = ?`);
  const txCustomers = db.transaction(() => {
    for (const row of localCustomers) {
      if (row.woo_id && !wooCustomerIds.has(row.woo_id)) {
        deleteCustomer.run(row.id);
        result.customers += 1;
      }
    }
  });
  txCustomers();

  // --- Imágenes huérfanas en disco ---
  result.images = deleteOrphanImages(db);

  return result;
}

// Borra archivos de imagen que ya no corresponden a ningún registro. Sin esto, la
// carpeta crece con cada producto eliminado o con cada cambio de extensión.
function deleteOrphanImages(db) {
  const dir = IMAGES_DIR();
  let deleted = 0;

  const inUse = new Set();
  for (const row of db.prepare(`SELECT image_local_path FROM products WHERE image_local_path IS NOT NULL`).all()) {
    inUse.add(row.image_local_path);
  }
  for (const row of db.prepare(`SELECT image_local_path FROM product_variations WHERE image_local_path IS NOT NULL`).all()) {
    inUse.add(row.image_local_path);
  }

  try {
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file);
      if (!inUse.has(full)) {
        fs.unlinkSync(full);
        deleted += 1;
      }
    }
  } catch (err) {
    console.error('[limpieza] no se pudieron revisar las imágenes:', err.message);
  }

  return deleted;
}

// Cuánto ocupa cada cosa, para decidir si vale la pena limpiar.
function getCacheStats() {
  const db = getDb();
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  let imagesBytes = 0;
  let imagesCount = 0;
  try {
    for (const file of fs.readdirSync(IMAGES_DIR())) {
      imagesBytes += fs.statSync(path.join(IMAGES_DIR(), file)).size;
      imagesCount += 1;
    }
  } catch { /* la carpeta puede no existir todavía */ }

  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(path.join(app.getPath('userData'), 'pos-local.db')).size;
  } catch { /* ignorar */ }

  return {
    products: count('products'),
    variations: count('product_variations'),
    customers: count('customers'),
    orders: count('orders_queue'),
    imagesCount,
    imagesBytes,
    dbBytes,
  };
}

module.exports = { cleanupCache, getCacheStats };
