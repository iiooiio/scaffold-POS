const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getDb } = require('../db/init');
const { createBackup } = require('../db/backup');
const config = require('../config');

// Detecta que la caja se apuntó a OTRA tienda WooCommerce (dev -> producción, por
// ejemplo) y limpia la caché local.
//
// POR QUÉ HACE FALTA: el sync de catálogo es incremental (`modified_after`) y el cursor
// vive en la base local. Al cambiar de tienda, ese cursor sigue apuntando a la fecha del
// último sync de la tienda ANTERIOR, así que la tienda nueva solo devuelve lo modificado
// después de esa fecha -- casi nada. Y los productos de la tienda vieja se quedan ahí
// para siempre, porque nada los borra.

const SITE_KEY = 'site_url';
const IMAGES_DIR = () => path.join(app.getPath('userData'), 'product-images');

function getStoredSite(db) {
  const row = db.prepare(`SELECT value FROM sync_meta WHERE key = ?`).get(SITE_KEY);
  return row ? row.value : null;
}

function setStoredSite(db, url) {
  db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SITE_KEY, url);
}

// Trabajo local que todavía pertenece a la tienda ANTERIOR.
//
// Solo BLOQUEA lo transaccional -- ventas, cancelaciones, devoluciones y recepciones --
// porque mandarlo a la tienda equivocada mueve dinero o inventario real.
//
// Los clientes pendientes NO bloquean: un registro de contacto no es una transacción, y
// frenar un cambio de tienda legítimo por eso sería excesivo. Se conservan y terminarán
// creándose en la tienda nueva; el resultado reporta cuántos son para que no sea una
// sorpresa.
function pendingWorkSummary(db) {
  // Cada conteo va en su propio try. Si una tabla o columna no existe (base creada por
  // una versión anterior, archivo sin actualizar), devuelve 0 en vez de lanzar: esta
  // función alimenta el panel de Mantenimiento, y una excepción aquí lo dejaba pegado en
  // "Cargando..." sin decir por qué.
  const one = (sql) => {
    try {
      return db.prepare(sql).get().n;
    } catch (err) {
      console.error('[tienda] no se pudo contar pendientes:', err.message);
      return 0;
    }
  };

  const orders = one(`SELECT COUNT(*) AS n FROM orders_queue WHERE status IN ('pending', 'error')`);
  const cancellations = one(`SELECT COUNT(*) AS n FROM orders_queue WHERE status = 'cancel_pending'`);
  const refunds = one(`SELECT COUNT(*) AS n FROM refunds_queue WHERE status IN ('pending', 'error')`);
  const receipts = one(`SELECT COUNT(*) AS n FROM stock_receipts WHERE status IN ('pending', 'error')`);
  const customers = one(`SELECT COUNT(*) AS n FROM customers WHERE pending_sync = 1 OR pending_update = 1`);

  return {
    orders, cancellations, refunds, receipts, customers,
    // 'customers' queda fuera del total a propósito: informa, no bloquea.
    total: orders + cancellations + refunds + receipts,
  };
}

function deleteAllImages() {
  let deleted = 0;
  try {
    for (const file of fs.readdirSync(IMAGES_DIR())) {
      fs.unlinkSync(path.join(IMAGES_DIR(), file));
      deleted += 1;
    }
  } catch { /* la carpeta puede no existir */ }
  return deleted;
}

// Borra TODO lo que es espejo de la tienda: catálogo, variaciones, clientes, cupones,
// imágenes y el cursor de sync.
//
// NO toca ventas, turnos ni cortes: son el historial de esta caja y no se pueden
// recuperar de ningún Woo.
function wipeStoreCache(db) {
  const result = {};
  const tx = db.transaction(() => {
    result.variations = db.prepare(`DELETE FROM product_variations`).run().changes;
    result.products = db.prepare(`DELETE FROM products`).run().changes;
    result.customers = db.prepare(`DELETE FROM customers WHERE pending_sync = 0 AND pending_update = 0`).run().changes;
    result.coupons = db.prepare(`DELETE FROM coupons`).run().changes;
    // El cursor se borra para que el próximo sync traiga el catálogo COMPLETO.
    db.prepare(`DELETE FROM sync_meta WHERE key != ?`).run(SITE_KEY);
  });
  tx();
  result.images = deleteAllImages();
  return result;
}

// Resincronización completa forzada, sin cambiar de tienda. Es la salida para cuando la
// caché quedó desfasada por cualquier motivo.
async function forceFullResync() {
  const db = getDb();
  const backup = await createBackup('pre-resync');
  const result = wipeStoreCache(db);
  return { ...result, backup: backup.path };
}

// Se llama al arrancar, ANTES del primer sync.
async function ensureStoreMatches() {
  const db = getDb();
  const current = config.wcBaseUrl;
  if (!current) return { changed: false, configured: false };

  const stored = getStoredSite(db);

  // Primera vez que se registra la tienda: puede ser una base nueva (nada que hacer) o
  // una base que YA traía datos de una tienda anterior, creada antes de que existiera
  // esta verificación. En el segundo caso no hay forma de saber de qué tienda es ese
  // catálogo, y dejarlo tal cual es justo lo que hacía que la caja siguiera mostrando
  // productos de dev con un cursor viejo que impedía traer los de producción.
  //
  // Se limpia. El catálogo, los clientes y los cupones se pueden volver a traer de la
  // tienda; las ventas no se tocan.
  if (!stored) {
    const hasData = db.prepare(`SELECT COUNT(*) AS n FROM products`).get().n > 0;
    const hasCursor = db.prepare(`SELECT 1 FROM sync_meta WHERE key = 'products_last_sync'`).get();

    if (hasData || hasCursor) {
      const backup = await createBackup('tienda-desconocida');
      const result = wipeStoreCache(db);
      setStoredSite(db, current);
      console.log('[tienda] caché de origen desconocido: se limpió y se forzó sync completo');
      return { changed: true, blocked: false, recovered: true, current, backup: backup.path, ...result };
    }

    setStoredSite(db, current);
    return { changed: false, initialized: true };
  }

  if (stored === current) return { changed: false };

  const pending = pendingWorkSummary(db);
  if (pending.total > 0) {
    // No se limpia ni se sincroniza: hay trabajo local que pertenece a la tienda
    // anterior y se subiría a la equivocada.
    return { changed: true, blocked: true, stored, current, pending };
  }

  const backup = await createBackup('cambio-de-tienda');
  const result = wipeStoreCache(db);
  setStoredSite(db, current);
  return { changed: true, blocked: false, stored, current, backup: backup.path, ...result };
}

function getStoreStatus() {
  const db = getDb();
  return {
    stored: getStoredSite(db),
    current: config.wcBaseUrl,
    pending: pendingWorkSummary(db),
  };
}

module.exports = { ensureStoreMatches, forceFullResync, getStoreStatus, wipeStoreCache };
