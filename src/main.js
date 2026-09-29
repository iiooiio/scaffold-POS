const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');
const logger = require('./logger');
const config = require('./config');
const { getDb } = require('./db/init');
const { syncCatalog, getLocalProducts, getLocalVariations, findBySku } = require('./sync/catalog-sync');
const { queueOrder, flushPendingOrders, retryOrder, resolveManually, getQueueSummary, getErroredOrders, getRecentOrders, getOrderForReprint, cancelOrder, flushPendingCancellations, refundOrderItems, getOrderRefundState, flushPendingRefunds } = require('./sync/order-sync');
const { syncCustomers, getLocalCustomers, createLocalCustomer, updateLocalCustomer, flushPendingCustomers } = require('./sync/customer-sync');
const { syncCoupons, evaluateCoupon } = require('./sync/coupon-sync');
const { queueReceipt, flushPendingReceipts, getRecentReceipts } = require('./sync/receiving');
const { ensureStoreMatches, forceFullResync, getStoreStatus } = require('./sync/store-guard');
const { printTicket, printCashReport, printCancellation, printPartialRefund } = require('./print/printer');
const { printLabels, previewLabelZpl } = require('./print/label-printer');
const cash = require('./cash/cash-session');
const { createBackup, listBackups, backupDir } = require('./db/backup');
const { cleanupCache, getCacheStats } = require('./db/cleanup');

let mainWindow;
let logoLocalPath = null;
// Si la caja apunta a una tienda distinta y hay trabajo local sin subir, el sync queda
// bloqueado hasta que el usuario lo resuelva (ver store-guard.js).
let storeBlocked = null;
// Último error de cada sincronización, para poder mostrarlo en Diagnóstico. Antes solo
// existía en console.error, que en la app empaquetada nadie ve.
const lastErrors = {};
let lastSyncAt = null;

function recordSync(step, err) {
  if (err) {
    lastErrors[step] = { message: err.message, at: new Date().toISOString() };
    console.error(`[${step}] fallo:`, err.message);
  } else {
    delete lastErrors[step];
  }
}

// Descarga el logo una sola vez (no depende del sync de catálogo, es un archivo aparte).
// Si LOGO_URL no está configurado en .env, no hace nada y la UI simplemente no muestra logo.
async function downloadLogoIfConfigured() {
  if (!config.logoUrl) return;
  try {
    const res = await fetch(config.logoUrl, { headers: { 'User-Agent': 'pos-electron/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ext = path.extname(new URL(config.logoUrl).pathname) || '.png';
    const filePath = path.join(app.getPath('userData'), `logo${ext}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    logoLocalPath = filePath;
  } catch (err) {
    console.error('[logo] fallo al descargar:', err.message);
  }
}

function createWindow() {
  // Quita la barra de menú (File, Edit, View...) por completo en toda la app.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    fullscreen: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // En desarrollo (npm start) abre DevTools automáticamente: sin esto, un error del
  // renderer falla en silencio y la UI simplemente no hace nada.
  if (!app.isPackaged) mainWindow.webContents.openDevTools();
}

// Aplica el ajuste global de precios (config.priceAdjustmentPercent). Se hace aquí, en
// un solo lugar, para que catálogo, variaciones, escaneo y carrito usen exactamente el
// mismo precio y no haya forma de que el ticket y la orden difieran.
function adjustPrice(price) {
  if (price === null || price === undefined) return price;
  const pct = config.priceAdjustmentPercent || 0;
  if (!pct) return price;
  return Math.round(price * (1 + pct / 100) * 100) / 100;
}

// Convierte una ruta local a file:// para que el renderer pueda mostrarla.
// Vive aquí y no en el preload porque el preload corre sandboxed (ver preload.js).
function toFileUrl(localPath) {
  return localPath ? pathToFileURL(localPath).href : null;
}

// Si ya se descargó en una corrida anterior, usarlo de inmediato (offline-friendly).
// No sabemos la extensión de antemano, así que se busca por prefijo en el directorio.
function findCachedLogo() {
  const dir = app.getPath('userData');
  try {
    const match = fs.readdirSync(dir).find((f) => f.startsWith('logo.'));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

app.whenReady().then(async () => {
  logger.install();
  getDb(); // fuerza creación de tablas al arrancar

  // Respaldo al arrancar: es el momento con menos escritura en curso y garantiza al
  // menos un punto de retorno por sesión de trabajo.
  createBackup('arranque').catch((err) => console.error('[respaldo] fallo al arrancar:', err.message));
  // Y uno cada 6 horas, para turnos largos.
  setInterval(() => {
    createBackup('auto').catch((err) => console.error('[respaldo] fallo periódico:', err.message));
  }, 6 * 60 * 60 * 1000);

  logoLocalPath = findCachedLogo();
  if (logoLocalPath) {
    // Ya hay uno cacheado: no bloquea el arranque, se refresca en segundo plano.
    downloadLogoIfConfigured();
  } else {
    // Primera vez: sí esperamos, para que se vea desde el primer arranque.
    await downloadLogoIfConfigured();
  }

  // ANTES de cualquier sync: verificar que la caja siga apuntando a la misma tienda.
  // Si cambió, se limpia la caché local; si hay trabajo pendiente de la tienda anterior,
  // se bloquea el sync en vez de mandarlo al sitio equivocado.
  try {
    const store = await ensureStoreMatches();
    if (store.blocked) {
      storeBlocked = store;
      console.error('[tienda] cambio de tienda bloqueado: hay trabajo local sin subir');
    } else if (store.changed) {
      console.log('[tienda] cambió de tienda, caché local limpiada');
    }
  } catch (err) {
    console.error('[tienda] fallo al verificar la tienda:', err.message);
  }

  createWindow();

  // Loop de sincronización en background: catálogo + cola de órdenes.
  // Si no hay conexión o falta configuración, no hace nada y no se cae la app.
  setInterval(async () => {
    if (!config.isConfigured()) return;
    if (storeBlocked) return; // apunta a otra tienda y hay trabajo local sin subir
    lastSyncAt = new Date().toISOString();
    try {
      await syncCatalog();
      recordSync('catalogo', null);
    } catch (err) {
      recordSync('catalogo', err);
    }
    // Los clientes creados sin conexión van PRIMERO: una orden que referencia un
    // cliente aún inexistente en Woo falla al enviarse.
    try {
      await flushPendingCustomers();
      recordSync('clientes-pendientes', null);
    } catch (err) {
      recordSync('clientes-pendientes', err);
    }
    try {
      const result = await flushPendingOrders();
      if (result.attempted > 0) {
        mainWindow?.webContents.send('queue:updated', result);
      }
      recordSync('ordenes', null);
    } catch (err) {
      recordSync('ordenes', err);
    }
    try {
      await flushPendingCancellations();
    } catch (err) {
      console.error('[sync cancelaciones] fallo:', err.message);
    }
    try {
      await flushPendingRefunds();
    } catch (err) {
      console.error('[sync devoluciones] fallo:', err.message);
    }
    try {
      await flushPendingReceipts();
    } catch (err) {
      console.error('[sync recepciones] fallo:', err.message);
    }
  }, config.syncIntervalMs);

  // Intervalo aparte para clientes, más espaciado -- ver comentario en config.js.
  const runCustomerSync = () => {
    if (!config.isConfigured()) return;
    if (storeBlocked) return;
    syncCustomers().catch((err) => console.error('[sync clientes] fallo:', err.message));
    // Los cupones cambian poco; van en el mismo intervalo espaciado que los clientes.
    syncCoupons().catch((err) => console.error('[sync cupones] fallo:', err.message));
  };
  runCustomerSync();
  setInterval(runCustomerSync, config.customersSyncIntervalMs);

  // Auto-update: solo en la app empaquetada (en desarrollo no aplica). Busca al
  // arrancar y luego cada 4 horas. Requiere que el build se haya publicado como
  // release de GitHub -- ver README.
  if (app.isPackaged) {
    const checkUpdates = () => {
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        console.error('[auto-update] fallo al buscar actualizaciones:', err.message);
      });
    };
    checkUpdates();
    setInterval(checkUpdates, 4 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: puente entre la UI (renderer) y la lógica de negocio ----

ipcMain.handle('app:register-id', () => config.registerId);
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('config:get', () => ({
  values: config.getEditableConfig(),
  isConfigured: config.isConfigured(),
  path: config.configPath(),
}));
ipcMain.handle('config:save', (_e, values) => {
  config.saveConfig(values);
  return { values: config.getEditableConfig(), isConfigured: config.isConfigured() };
});
ipcMain.handle('catalog:find-by-sku', (_e, sku) => {
  const match = findBySku(sku);
  return match ? { ...match, price: adjustPrice(match.price) } : null;
});
ipcMain.handle('app:price-adjustment', () => config.priceAdjustmentPercent);
ipcMain.handle('app:logo-url', () => toFileUrl(logoLocalPath));
ipcMain.handle('catalog:sync-now', async () => syncCatalog());
ipcMain.handle('catalog:get-products', async (_e, { search } = {}) =>
  getLocalProducts({ search }).map((p) => ({
    ...p,
    price: adjustPrice(p.price),
    image_url: toFileUrl(p.image_local_path),
  })));
ipcMain.handle('catalog:get-variations', async (_e, productId) =>
  getLocalVariations(productId).map((v) => ({
    ...v,
    price: adjustPrice(v.price),
    image_url: toFileUrl(v.image_local_path),
  })));
ipcMain.handle('customers:get', async (_e, { search } = {}) => getLocalCustomers({ search }));
ipcMain.handle('customers:sync-now', async () => syncCustomers());
ipcMain.handle('customers:create', async (_e, data) => createLocalCustomer(data));
ipcMain.handle('customers:update', async (_e, { id, data }) => updateLocalCustomer(id, data));
ipcMain.handle('coupons:evaluate', (_e, { code, cartLines }) => evaluateCoupon(code, cartLines));
ipcMain.handle('coupons:sync-now', async () => syncCoupons());

ipcMain.handle('order:checkout', async (_e, { cartItems, paymentMethod, cashInfo, note, customerId, couponCode }) => {
  // El corte de caja solo sirve si TODA venta queda ligada a un turno. Sin sesión
  // abierta no se cobra -- si no, el efectivo del cajón nunca cuadraría.
  const session = cash.getOpenSession();
  if (!session) throw new Error('No hay caja abierta. Abre la caja antes de cobrar.');

  // line_total ya trae el descuento aplicado (lo calcula computeCart en el renderer).
  const total = cartItems.reduce((sum, i) => sum + (i.line_total ?? i.price * i.quantity), 0);
  const { localTicket } = queueOrder({
    cartItems, paymentMethod, cashInfo, customerNote: note || '', customerId,
    cashSessionId: session.id, couponCode,
  });

  // Se imprime de inmediato, sin esperar a que sincronice con WooCommerce.
  try {
    await printTicket({ localTicket, cartItems, total, paymentMethod, cashInfo, note });
  } catch (err) {
    // La venta ya quedó guardada en la cola aunque falle la impresión.
    return { localTicket, total, printed: false, printError: err.message };
  }

  return { localTicket, total, printed: true };
});

// ---- Control de efectivo ----
ipcMain.handle('cash:current', () => cash.getCurrentSummary());
ipcMain.handle('cash:open', (_e, openingFloat) => cash.openSession(openingFloat));
ipcMain.handle('cash:add-movement', (_e, movement) => cash.addMovement(movement));
ipcMain.handle('cash:movements', () => {
  const session = cash.getOpenSession();
  return session ? cash.getMovements(session.id) : [];
});
ipcMain.handle('cash:close', async (_e, countedAmount) => {
  const summary = cash.closeSession(countedAmount);
  try {
    await printCashReport(summary);
    return { ...summary, printed: true };
  } catch (err) {
    // El corte YA quedó guardado aunque falle la impresión.
    return { ...summary, printed: false, printError: err.message };
  }
});

ipcMain.handle('maintenance:stats', () => ({
  cache: getCacheStats(),
  backups: listBackups().slice(0, 5),
  backupDir: backupDir(),
}));
ipcMain.handle('maintenance:backup-now', async () => createBackup('manual'));
ipcMain.handle('maintenance:cleanup', async () => cleanupCache());
ipcMain.handle('maintenance:open-backups', async () => shell.openPath(backupDir()));
ipcMain.handle('maintenance:store-status', () => ({ ...getStoreStatus(), blocked: storeBlocked }));
ipcMain.handle('maintenance:diagnostics', () => {
  // Cada bloque va en su propio try: si uno truena, los demás siguen informando. Un
  // diagnóstico que se cae por un solo dato roto no sirve para nada.
  const out = { lastSyncAt, lastErrors, logPath: logger.getLogPath() };

  try {
    out.config = { configured: config.isConfigured(), storeURL: config.wcBaseUrl, registerID: config.registerId };
  } catch (err) { out.configError = err.message; }

  try {
    out.store = { ...getStoreStatus(), blocked: Boolean(storeBlocked) };
  } catch (err) { out.storeError = err.message; }

  try {
    const db = getDb();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
    out.tables = tables;
    out.counts = {};
    for (const t of ['products', 'product_variations', 'customers', 'coupons', 'orders_queue']) {
      try { out.counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
      catch (err) { out.counts[t] = `ERROR: ${err.message}`; }
    }
    const cursor = db.prepare(`SELECT value FROM sync_meta WHERE key = 'products_last_sync'`).get();
    out.syncCursor = cursor ? cursor.value : null;
  } catch (err) { out.dbError = err.message; }

  out.log = logger.getRecentLines(60);
  return out;
});
ipcMain.handle('maintenance:open-logs', async () => shell.openPath(logger.logDir()));
ipcMain.handle('maintenance:force-resync', async () => {
  const result = await forceFullResync();
  // Tras el reset, se sincroniza de inmediato para no dejar el catálogo vacío.
  await syncCatalog();
  return result;
});

ipcMain.handle('receiving:queue', (_e, data) => queueReceipt(data));
ipcMain.handle('receiving:recent', () => getRecentReceipts());
ipcMain.handle('receiving:sync-now', async () => flushPendingReceipts());
ipcMain.handle('print:labels', async (_e, data) => printLabels(data));
// Devuelve el ZPL sin imprimir, para pegarlo en labelary.com/viewer.html y revisar el
// diseño de la etiqueta sin tener la impresora enfrente.
ipcMain.handle('print:label-preview', (_e, sample) => previewLabelZpl(sample));

ipcMain.handle('app:toggle-fullscreen', () => {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

ipcMain.handle('queue:sync-now', async () => flushPendingOrders());
ipcMain.handle('queue:summary', async () => getQueueSummary());
ipcMain.handle('queue:errors', async () => getErroredOrders());
ipcMain.handle('queue:retry-order', async (_e, orderId) => retryOrder(orderId));
ipcMain.handle('queue:resolve-manually', async (_e, { orderId, note }) => resolveManually(orderId, note));

ipcMain.handle('order:recent', () => getRecentOrders());

ipcMain.handle('order:refund-state', (_e, orderId) => getOrderRefundState(orderId));

ipcMain.handle('order:refund', async (_e, { orderId, items, reason }) => {
  // Misma restricción que la cancelación total: solo del turno abierto, para no alterar
  // un corte ya cerrado.
  const session = cash.getOpenSession();
  if (!session) throw new Error('No hay caja abierta');

  const order = getRecentOrders(200).find((o) => o.id === orderId);
  if (!order) throw new Error('Venta no encontrada');
  if (!order.cash_session_id) {
    throw new Error('Esta venta es anterior al control de efectivo y no tiene turno asignado, así que no se puede devolver sin descuadrar el corte. Registra un retiro en el panel de Caja.');
  }
  if (order.cash_session_id !== session.id) {
    throw new Error('Solo se pueden devolver ventas del turno actual. Para ventas de turnos anteriores, registra un retiro en el panel de Caja.');
  }

  const result = refundOrderItems(orderId, items, reason);

  try {
    if (result.fullCancellation) {
      await printCancellation({
        localTicket: result.local_ticket,
        total: result.amount,
        reason,
        paymentMethod: result.payment_method,
      });
    } else {
      await printPartialRefund({
        localTicket: result.local_ticket,
        items: result.items,
        amount: result.amount,
        reason,
        paymentMethod: result.payment_method,
      });
    }
    return { ...result, printed: true };
  } catch (err) {
    // La devolución ya quedó registrada aunque falle la impresión.
    return { ...result, printed: false, printError: err.message };
  }
});

ipcMain.handle('order:cancel', async (_e, { orderId, reason }) => {
  // Solo se cancelan ventas del turno ABIERTO. Cancelar una de un turno ya cerrado
  // cambiaría retroactivamente un corte firmado, y el efectivo devuelto saldría de la
  // caja de hoy, no de la de ese día. Para esos casos se registra un retiro manual.
  const session = cash.getOpenSession();
  if (!session) throw new Error('No hay caja abierta');

  const order = getRecentOrders(200).find((o) => o.id === orderId);
  if (!order) throw new Error('Venta no encontrada');
  if (!order.cash_session_id) {
    throw new Error('Esta venta es anterior al control de efectivo y no tiene turno asignado, así que no se puede cancelar sin descuadrar el corte. Registra un retiro en el panel de Caja.');
  }
  if (order.cash_session_id !== session.id) {
    throw new Error('Solo se pueden cancelar ventas del turno actual. Para ventas de turnos anteriores, registra un retiro en el panel de Caja.');
  }

  const result = cancelOrder(orderId, reason);

  try {
    await printCancellation({
      localTicket: result.local_ticket,
      total: result.total,
      reason,
      paymentMethod: result.payment_method,
    });
    return { ok: true, needsSync: result.needsSync, printed: true };
  } catch (err) {
    // La cancelación ya quedó registrada aunque falle la impresión.
    return { ok: true, needsSync: result.needsSync, printed: false, printError: err.message };
  }
});
ipcMain.handle('order:reprint', async (_e, orderId) => {
  const data = getOrderForReprint(orderId);
  if (data.cartItems.length === 0) {
    throw new Error('Esta venta no tiene el detalle guardado (es anterior a esta función)');
  }
  await printTicket({ ...data, isReprint: true });
  return { ok: true, localTicket: data.localTicket };
});
