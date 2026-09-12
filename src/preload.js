const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('pos', {
  getRegisterId: () => ipcRenderer.invoke('app:register-id'),
  getLogoPath: () => ipcRenderer.invoke('app:logo-path'),
  toFileUrl: (localPath) => (localPath ? pathToFileURL(localPath).href : null),
  syncCatalogNow: () => ipcRenderer.invoke('catalog:sync-now'),
  getProducts: (search) => ipcRenderer.invoke('catalog:get-products', { search }),
  getVariations: (productId) => ipcRenderer.invoke('catalog:get-variations', productId),
  getCustomers: (search) => ipcRenderer.invoke('customers:get', { search }),
  syncCustomersNow: () => ipcRenderer.invoke('customers:sync-now'),
  checkout: (cartItems, paymentMethod, cashInfo, note, customerId) =>
    ipcRenderer.invoke('order:checkout', { cartItems, paymentMethod, cashInfo, note, customerId }),
  syncQueueNow: () => ipcRenderer.invoke('queue:sync-now'),
  getQueueSummary: () => ipcRenderer.invoke('queue:summary'),
  getQueueErrors: () => ipcRenderer.invoke('queue:errors'),
  retryOrder: (orderId) => ipcRenderer.invoke('queue:retry-order', orderId),
  resolveManually: (orderId, note) => ipcRenderer.invoke('queue:resolve-manually', { orderId, note }),
  onQueueUpdated: (callback) => ipcRenderer.on('queue:updated', (_e, data) => callback(data)),
});
