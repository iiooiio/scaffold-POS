require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}

module.exports = {
  wcBaseUrl: required('WC_BASE_URL').replace(/\/+$/, ''),
  wcConsumerKey: required('WC_CONSUMER_KEY'),
  wcConsumerSecret: required('WC_CONSUMER_SECRET'),
  registerId: process.env.REGISTER_ID || 'CAJA1',
  printerInterface: process.env.PRINTER_INTERFACE || 'printer:auto',
  syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '30000', 10),
};
