const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pos', {
  getRegisterId: () => ipcRenderer.invoke('app:register-id'),
  syncCatalogNow: () => ipcRenderer.invoke('catalog:sync-now'),
  getProducts: (search) => ipcRenderer.invoke('catalog:get-products', { search }),
  checkout: (cartItems, paymentMethod) => ipcRenderer.invoke('order:checkout', { cartItems, paymentMethod }),
  syncQueueNow: () => ipcRenderer.invoke('queue:sync-now'),
  getQueueSummary: () => ipcRenderer.invoke('queue:summary'),
  getQueueErrors: () => ipcRenderer.invoke('queue:errors'),
  retryOrder: (orderId) => ipcRenderer.invoke('queue:retry-order', orderId),
  resolveManually: (orderId, note) => ipcRenderer.invoke('queue:resolve-manually', { orderId, note }),
  onQueueUpdated: (callback) => ipcRenderer.on('queue:updated', (_e, data) => callback(data)),
});
