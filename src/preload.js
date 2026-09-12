const { contextBridge, ipcRenderer } = require('electron');

// NO usar require() de módulos de Node aquí (ni 'url', ni 'path', ni 'fs').
// Desde Electron 20 el preload corre sandboxed por default y solo expone un subconjunto
// de módulos; un require no soportado tumba el preload entero, window.pos queda
// undefined, y la UI falla sin mensaje visible. Toda conversión de rutas a file://
// se hace en main.js, que sí tiene Node completo.
contextBridge.exposeInMainWorld('pos', {
  getRegisterId: () => ipcRenderer.invoke('app:register-id'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (values) => ipcRenderer.invoke('config:save', values),
  findBySku: (sku) => ipcRenderer.invoke('catalog:find-by-sku', sku),
  getPriceAdjustment: () => ipcRenderer.invoke('app:price-adjustment'),
  getLogoUrl: () => ipcRenderer.invoke('app:logo-url'),
  syncCatalogNow: () => ipcRenderer.invoke('catalog:sync-now'),
  getProducts: (search) => ipcRenderer.invoke('catalog:get-products', { search }),
  getVariations: (productId) => ipcRenderer.invoke('catalog:get-variations', productId),
  getCustomers: (search) => ipcRenderer.invoke('customers:get', { search }),
  syncCustomersNow: () => ipcRenderer.invoke('customers:sync-now'),
  createCustomer: (data) => ipcRenderer.invoke('customers:create', data),
  checkout: (cartItems, paymentMethod, cashInfo, note, customerId) =>
    ipcRenderer.invoke('order:checkout', { cartItems, paymentMethod, cashInfo, note, customerId }),
  syncQueueNow: () => ipcRenderer.invoke('queue:sync-now'),
  getQueueSummary: () => ipcRenderer.invoke('queue:summary'),
  getQueueErrors: () => ipcRenderer.invoke('queue:errors'),
  retryOrder: (orderId) => ipcRenderer.invoke('queue:retry-order', orderId),
  resolveManually: (orderId, note) => ipcRenderer.invoke('queue:resolve-manually', { orderId, note }),
  onQueueUpdated: (callback) => ipcRenderer.on('queue:updated', (_e, data) => callback(data)),
  getCashSession: () => ipcRenderer.invoke('cash:current'),
  openCashSession: (openingFloat) => ipcRenderer.invoke('cash:open', openingFloat),
  addCashMovement: (movement) => ipcRenderer.invoke('cash:add-movement', movement),
  getCashMovements: () => ipcRenderer.invoke('cash:movements'),
  closeCashSession: (countedAmount) => ipcRenderer.invoke('cash:close', countedAmount),
  getRecentOrders: () => ipcRenderer.invoke('order:recent'),
  reprintOrder: (orderId) => ipcRenderer.invoke('order:reprint', orderId),
  cancelOrder: (orderId, reason) => ipcRenderer.invoke('order:cancel', { orderId, reason }),
  getRefundState: (orderId) => ipcRenderer.invoke('order:refund-state', orderId),
  refundOrder: (orderId, items, reason) => ipcRenderer.invoke('order:refund', { orderId, items, reason }),
  toggleFullscreen: () => ipcRenderer.invoke('app:toggle-fullscreen'),
});
