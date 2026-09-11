const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getDb } = require('../db/init');
const { fetchAllProducts } = require('./woo-client');

const META_KEY = 'products_last_sync';
const IMAGES_DIR = path.join(app.getPath('userData'), 'product-images');

function ensureImagesDir() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

function upsertProduct(db, p) {
  db.prepare(`
    INSERT INTO products (id, sku, name, type, price, regular_price, sale_price,
                           manage_stock, stock_quantity, status, raw_json, updated_at)
    VALUES (@id, @sku, @name, @type, @price, @regular_price, @sale_price,
            @manage_stock, @stock_quantity, @status, @raw_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      sku = excluded.sku,
      name = excluded.name,
      type = excluded.type,
      price = excluded.price,
      regular_price = excluded.regular_price,
      sale_price = excluded.sale_price,
      manage_stock = excluded.manage_stock,
      stock_quantity = excluded.stock_quantity,
      status = excluded.status,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `).run({
    id: p.id,
    sku: p.sku || null,
    name: p.name,
    type: p.type,
    price: p.price ? parseFloat(p.price) : null,
    regular_price: p.regular_price ? parseFloat(p.regular_price) : null,
    sale_price: p.sale_price ? parseFloat(p.sale_price) : null,
    manage_stock: p.manage_stock ? 1 : 0,
    stock_quantity: p.stock_quantity,
    status: p.status,
    raw_json: JSON.stringify(p),
    updated_at: p.date_modified_gmt,
  });
}

// Descarga la primera imagen del producto a disco, para que se vea aunque no haya
// internet después. Se llama solo para productos que cambiaron en este sync
// (ya vienen filtrados por modified_after), así que no vuelve a bajar todo cada vez.
// NOTA: descarga secuencial, sin reintentos ni límite de concurrencia -- en un catálogo
// grande con muchas imágenes nuevas, el primer sync puede tardar. No lo he medido.
async function downloadProductImage(db, p) {
  const image = p.images && p.images[0];
  if (!image || !image.src) return;

  try {
    const res = await fetch(image.src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ext = path.extname(new URL(image.src).pathname) || '.jpg';
    const filePath = path.join(IMAGES_DIR, `${p.id}${ext}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    db.prepare(`UPDATE products SET image_local_path = ? WHERE id = ?`).run(filePath, p.id);
  } catch (err) {
    // No tumba el sync completo por una imagen que falló -- el producto se sincroniza
    // igual, solo se queda sin imagen local esta vez.
    console.error(`[imagen] fallo al descargar producto ${p.id}:`, err.message);
  }
}

// Sincroniza catálogo completo la primera vez, luego incremental por modified_after.
// NOTA: no maneja variaciones de productos variables todavía (queda pendiente si las usas).
async function syncCatalog() {
  ensureImagesDir();

  const db = getDb();
  const metaRow = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(META_KEY);
  const modifiedAfter = metaRow ? metaRow.value : undefined;

  const products = await fetchAllProducts({ modifiedAfter });

  const tx = db.transaction((items) => {
    for (const p of items) upsertProduct(db, p);
  });
  tx(products);

  // Fuera de la transacción porque son operaciones async (better-sqlite3 es síncrono).
  for (const p of products) {
    await downloadProductImage(db, p);
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(META_KEY, now);

  return { count: products.length, syncedAt: now };
}

function getLocalProducts({ search } = {}) {
  const db = getDb();
  if (search) {
    return db.prepare(`
      SELECT * FROM products
      WHERE status = 'publish' AND (name LIKE ? OR sku LIKE ?)
      ORDER BY name ASC
    `).all(`%${search}%`, `%${search}%`);
  }
  return db.prepare(`SELECT * FROM products WHERE status = 'publish' ORDER BY name ASC`).all();
}

module.exports = { syncCatalog, getLocalProducts };
