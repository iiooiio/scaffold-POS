const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const config = require('./config');
const { getDb } = require('./db/init');
const { syncCatalog, getLocalProducts } = require('./sync/catalog-sync');
const { queueOrder, flushPendingOrders, getQueueSummary, getErroredOrders } = require('./sync/order-sync');
const { printTicket } = require('./print/printer');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  getDb(); // fuerza creación de tablas al arrancar

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: puente entre la UI (renderer) y la lógica de negocio ----

ipcMain.handle('catalog:sync-now', async () => syncCatalog());
ipcMain.handle('catalog:get-products', async (_e, { search } = {}) => getLocalProducts({ search }));

ipcMain.handle('order:checkout', async (_e, { cartItems, paymentMethod }) => {
  const total = cartItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const { localTicket } = queueOrder({ cartItems, paymentMethod });

  // Se imprime de inmediato, sin esperar a que sincronice con WooCommerce.
  try {
    await printTicket({ localTicket, cartItems, total, paymentMethod });
  } catch (err) {
    // La venta ya quedó guardada en la cola aunque falle la impresión.
    return { localTicket, total, printed: false, printError: err.message };
  }

  return { localTicket, total, printed: true };
});

ipcMain.handle('queue:sync-now', async () => flushPendingOrders());
ipcMain.handle('queue:summary', async () => getQueueSummary());
ipcMain.handle('queue:errors', async () => getErroredOrders());
