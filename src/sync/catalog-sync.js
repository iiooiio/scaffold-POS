const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { getDb } = require('../db/init');
const { fetchAllProducts, fetchProductVariations } = require('./woo-client');

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

// Descarga una imagen a disco y actualiza image_local_path en la tabla indicada.
// Genérica porque la usan tanto products como product_variations.
// Manda un User-Agent explícito -- algunos hosts/CDNs de WordPress (Wordfence,
// Cloudflare, etc.) bloquean requests sin uno.
// NOTA: descarga secuencial, sin reintentos ni límite de concurrencia -- en un catálogo
// grande con muchas imágenes nuevas, el primer sync puede tardar. No lo he medido.
async function downloadImage(db, { table, id, imageSrc }) {
  if (!imageSrc) return false;

  try {
    const res = await fetch(imageSrc, { headers: { 'User-Agent': 'pos-electron/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ext = path.extname(new URL(imageSrc).pathname) || '.jpg';
    const filePath = path.join(IMAGES_DIR, `${table}-${id}${ext}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    db.prepare(`UPDATE ${table} SET image_local_path = ? WHERE id = ?`).run(filePath, id);
    return true;
  } catch (err) {
    // No tumba el sync completo por una imagen que falló -- el registro se sincroniza
    // igual, solo se queda sin imagen local esta vez.
    console.error(`[imagen] fallo al descargar ${table} ${id}:`, err.message);
    return false;
  }
}

// BUG REAL que encontramos: el sync es incremental (modified_after), así que un producto
// que no cambió nunca vuelve a pasar por downloadImage(). Esto revisa TODA la tabla en
// busca de registros con imagen conocida (raw_json) pero sin image_local_path, y
// reintenta -- corre en cada sync, así que también se auto-repara de fallos de red
// puntuales, no solo del bug original.
async function backfillMissingImages(db) {
  let ok = 0;
  let failed = 0;

  const missingProducts = db.prepare(`
    SELECT id, raw_json FROM products WHERE image_local_path IS NULL AND raw_json IS NOT NULL
  `).all();
  for (const row of missingProducts) {
    const raw = JSON.parse(row.raw_json);
    const src = raw.images && raw.images[0] && raw.images[0].src;
    if (!src) continue;
    const success = await downloadImage(db, { table: 'products', id: row.id, imageSrc: src });
    success ? ok++ : failed++;
  }

  const missingVariations = db.prepare(`
    SELECT id, raw_json FROM product_variations WHERE image_local_path IS NULL AND raw_json IS NOT NULL
  `).all();
  for (const row of missingVariations) {
    const raw = JSON.parse(row.raw_json);
    const src = raw.image && raw.image.src;
    if (!src) continue;
    const success = await downloadImage(db, { table: 'product_variations', id: row.id, imageSrc: src });
    success ? ok++ : failed++;
  }

  return { ok, failed };
}

function upsertVariation(db, v) {
  db.prepare(`
    INSERT INTO product_variations (id, parent_id, sku, price, regular_price, sale_price,
                                     manage_stock, stock_quantity, attributes_json, raw_json, updated_at)
    VALUES (@id, @parent_id, @sku, @price, @regular_price, @sale_price,
            @manage_stock, @stock_quantity, @attributes_json, @raw_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      sku = excluded.sku,
      price = excluded.price,
      regular_price = excluded.regular_price,
      sale_price = excluded.sale_price,
      manage_stock = excluded.manage_stock,
      stock_quantity = excluded.stock_quantity,
      attributes_json = excluded.attributes_json,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `).run({
    id: v.id,
    parent_id: v.parent_id,
    sku: v.sku || null,
    price: v.price ? parseFloat(v.price) : null,
    regular_price: v.regular_price ? parseFloat(v.regular_price) : null,
    sale_price: v.sale_price ? parseFloat(v.sale_price) : null,
    manage_stock: v.manage_stock ? 1 : 0,
    stock_quantity: v.stock_quantity,
    attributes_json: JSON.stringify(v.attributes || []),
    raw_json: JSON.stringify(v),
    updated_at: v.date_modified_gmt,
  });
}

// Trae y guarda TODAS las variaciones de un producto variable, con sus imágenes.
async function syncVariationsForProduct(db, productId) {
  const variations = await fetchProductVariations(productId);

  const tx = db.transaction((items) => {
    for (const v of items) upsertVariation(db, { ...v, parent_id: productId });
  });
  tx(variations);

  for (const v of variations) {
    await downloadImage(db, {
      table: 'product_variations',
      id: v.id,
      imageSrc: v.image && v.image.src,
    });
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
    await downloadImage(db, {
      table: 'products',
      id: p.id,
      imageSrc: p.images && p.images[0] && p.images[0].src,
    });

    if (p.type === 'variable') {
      await syncVariationsForProduct(db, p.id);
    }
  }

  // Backfill SIEMPRE, no solo para los productos que cambiaron en este pase --
  // ver comentario en backfillMissingImages sobre el bug del filtro incremental.
  const imageResult = await backfillMissingImages(db);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(META_KEY, now);

  return { count: products.length, syncedAt: now, imagesOk: imageResult.ok, imagesFailed: imageResult.failed };
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

function getLocalVariations(parentId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM product_variations WHERE parent_id = ? ORDER BY id ASC
  `).all(parentId);
  return rows.map((r) => ({ ...r, attributes: JSON.parse(r.attributes_json || '[]') }));
}

module.exports = { syncCatalog, getLocalProducts, getLocalVariations };
