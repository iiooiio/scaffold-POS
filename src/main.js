const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const config = require('./config');
const { getDb } = require('./db/init');
const { syncCatalog, getLocalProducts, getLocalVariations } = require('./sync/catalog-sync');
const { queueOrder, flushPendingOrders, retryOrder, resolveManually, getQueueSummary, getErroredOrders } = require('./sync/order-sync');
const { syncCustomers, getLocalCustomers } = require('./sync/customer-sync');
const { printTicket, printCashReport } = require('./print/printer');
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
  // Si no hay conexión, syncCatalog/flushPendingOrders fallan/no hacen nada y ya,
  // no se cae la app.
  setInterval(async () => {
    try {
      await syncCatalog();
    } catch (err) {
      console.error('[sync catálogo] fallo (probablemente sin conexión):', err.message);
    }
    try {
      const result = await flushPendingOrders();
      if (result.attempted > 0) {
        mainWindow?.webContents.send('queue:updated', result);
      }
    } catch (err) {
      console.error('[sync órdenes] fallo:', err.message);
    }
  }, config.syncIntervalMs);

  // Intervalo aparte para clientes, más espaciado -- ver comentario en config.js.
  syncCustomers().catch((err) => console.error('[sync clientes] fallo en el arranque:', err.message));
  setInterval(() => {
    syncCustomers().catch((err) => console.error('[sync clientes] fallo:', err.message));
  }, config.customersSyncIntervalMs);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: puente entre la UI (renderer) y la lógica de negocio ----

ipcMain.handle('app:register-id', () => config.registerId);
ipcMain.handle('app:logo-url', () => toFileUrl(logoLocalPath));
ipcMain.handle('catalog:sync-now', async () => syncCatalog());
ipcMain.handle('catalog:get-products', async (_e, { search } = {}) =>
  getLocalProducts({ search }).map((p) => ({ ...p, image_url: toFileUrl(p.image_local_path) })));
ipcMain.handle('catalog:get-variations', async (_e, productId) =>
  getLocalVariations(productId).map((v) => ({ ...v, image_url: toFileUrl(v.image_local_path) })));
ipcMain.handle('customers:get', async (_e, { search } = {}) => getLocalCustomers({ search }));
ipcMain.handle('customers:sync-now', async () => syncCustomers());

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
