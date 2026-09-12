const path = require('path');
const { app } = require('electron');

// dotenv por default busca .env en process.cwd(), que al abrir el .exe desde un acceso
// directo NO es la carpeta de instalación. Forzamos la ruta correcta:
//   - App empaquetada: junto al .exe (un nivel arriba de resources/app.asar)
//   - Desarrollo (npm start): raíz del proyecto
const envPath = app.isPackaged
  ? path.join(path.dirname(app.getPath('exe')), '.env')
  : path.join(__dirname, '..', '.env');

require('dotenv').config({ path: envPath });

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name} (buscando .env en: ${envPath})`);
  return v;
}

module.exports = {
  wcBaseUrl: required('WC_BASE_URL').replace(/\/+$/, ''),
  wcConsumerKey: required('WC_CONSUMER_KEY'),
  wcConsumerSecret: required('WC_CONSUMER_SECRET'),
  registerId: process.env.REGISTER_ID || 'CAJA1',
  logoUrl: process.env.LOGO_URL || null,
  printerInterface: process.env.PRINTER_INTERFACE || 'printer:auto',
  syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '30000', 10),
  // Más espaciado que el de catálogo a propósito -- /customers no soporta sync
  // incremental, así que cada corrida re-trae TODOS los clientes.
  customersSyncIntervalMs: parseInt(process.env.CUSTOMERS_SYNC_INTERVAL_MS || '600000', 10),
};
