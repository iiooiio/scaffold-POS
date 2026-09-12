const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');
const config = require('./config');
const { getDb } = require('./db/init');
const { syncCatalog, getLocalProducts, getLocalVariations, findBySku } = require('./sync/catalog-sync');
const { queueOrder, flushPendingOrders, retryOrder, resolveManually, getQueueSummary, getErroredOrders, getRecentOrders, getOrderForReprint, cancelOrder, flushPendingCancellations, refundOrderItems, getOrderRefundState, flushPendingRefunds } = require('./sync/order-sync');
const { syncCustomers, getLocalCustomers, createLocalCustomer, flushPendingCustomers } = require('./sync/customer-sync');
const { printTicket, printCashReport, printCancellation, printPartialRefund } = require('./print/printer');
const cash = require('./cash/cash-session');

let mainWindow;
let logoLocalPath = null;

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
  getDb(); // fuerza creación de tablas al arrancar

  logoLocalPath = findCachedLogo();
  if (logoLocalPath) {
    // Ya hay uno cacheado: no bloquea el arranque, se refresca en segundo plano.
    downloadLogoIfConfigured();
  } else {
    // Primera vez: sí esperamos, para que se vea desde el primer arranque.
    await downloadLogoIfConfigured();
  }

  createWindow();

  // Loop de sincronización en background: catálogo + cola de órdenes.
  // Si no hay conexión o falta configuración, no hace nada y no se cae la app.
  setInterval(async () => {
    if (!config.isConfigured()) return;
    try {
      await syncCatalog();
    } catch (err) {
      console.error('[sync catálogo] fallo (probablemente sin conexión):', err.message);
    }
    // Los clientes creados sin conexión van PRIMERO: una orden que referencia un
    // cliente aún inexistente en Woo falla al enviarse.
    try {
      await flushPendingCustomers();
    } catch (err) {
      console.error('[sync clientes pendientes] fallo:', err.message);
    }
    try {
      const result = await flushPendingOrders();
      if (result.attempted > 0) {
        mainWindow?.webContents.send('queue:updated', result);
      }
    } catch (err) {
      console.error('[sync órdenes] fallo:', err.message);
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
  }, config.syncIntervalMs);

  // Intervalo aparte para clientes, más espaciado -- ver comentario en config.js.
  const runCustomerSync = () => {
    if (!config.isConfigured()) return;
    syncCustomers().catch((err) => console.error('[sync clientes] fallo:', err.message));
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

ipcMain.handle('order:checkout', async (_e, { cartItems, paymentMethod, cashInfo, note, customerId }) => {
  // El corte de caja solo sirve si TODA venta queda ligada a un turno. Sin sesión
  // abierta no se cobra -- si no, el efectivo del cajón nunca cuadraría.
  const session = cash.getOpenSession();
  if (!session) throw new Error('No hay caja abierta. Abre la caja antes de cobrar.');

  const total = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const { localTicket } = queueOrder({
    cartItems, paymentMethod, cashInfo, customerNote: note || '', customerId,
    cashSessionId: session.id,
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
