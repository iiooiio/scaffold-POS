const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pos', {
  syncCatalogNow: () => ipcRenderer.invoke('catalog:sync-now'),
  getProducts: (search) => ipcRenderer.invoke('catalog:get-products', { search }),
  checkout: (cartItems, paymentMethod) => ipcRenderer.invoke('order:checkout', { cartItems, paymentMethod }),
  syncQueueNow: () => ipcRenderer.invoke('queue:sync-now'),
  getQueueSummary: () => ipcRenderer.invoke('queue:summary'),
  getQueueErrors: () => ipcRenderer.invoke('queue:errors'),
  onQueueUpdated: (callback) => ipcRenderer.on('queue:updated', (_e, data) => callback(data)),
});
