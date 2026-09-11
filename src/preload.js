const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('pos', {
  getRegisterId: () => ipcRenderer.invoke('app:register-id'),
  toFileUrl: (localPath) => (localPath ? pathToFileURL(localPath).href : null),
  syncCatalogNow: () => ipcRenderer.invoke('catalog:sync-now'),
  getProducts: (search) => ipcRenderer.invoke('catalog:get-products', { search }),
  checkout: (cartItems, paymentMethod, cashInfo) => ipcRenderer.invoke('order:checkout', { cartItems, paymentMethod, cashInfo }),
  syncQueueNow: () => ipcRenderer.invoke('queue:sync-now'),
  getQueueSummary: () => ipcRenderer.invoke('queue:summary'),
  getQueueErrors: () => ipcRenderer.invoke('queue:errors'),
  retryOrder: (orderId) => ipcRenderer.invoke('queue:retry-order', orderId),
  resolveManually: (orderId, note) => ipcRenderer.invoke('queue:resolve-manually', { orderId, note }),
  onQueueUpdated: (callback) => ipcRenderer.on('queue:updated', (_e, data) => callback(data)),
});
