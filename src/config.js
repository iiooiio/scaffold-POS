const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Dos fuentes de configuración, en este orden de prioridad:
//   1. config.json en userData -- lo escribe la pantalla de Ajustes de la app.
//      Es la vía normal de distribución: instalas el .exe y configuras desde la UI,
//      sin andar copiando .env a mano en cada caja.
//   2. .env -- para desarrollo (npm start) o si prefieres provisionar por archivo.
//
// IMPORTANTE: este módulo NUNCA lanza excepción por configuración faltante. Antes sí
// lo hacía y la app moría con un diálogo de error antes de abrir ventana, sin forma de
// arreglarlo desde la interfaz. Ahora arranca igual y la UI pide los datos.

const CONFIG_FILENAME = 'config.json';

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

function loadDotEnv() {
  const envPath = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), '.env')
    : path.join(__dirname, '..', '.env');
  try {
    if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
  } catch (err) {
    console.error('[config] no se pudo leer .env:', err.message);
  }
}

function loadJsonConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

// El objeto exportado se MUTA en reload() en vez de reemplazarse, para que los módulos
// que ya hicieron require('./config') vean los valores nuevos sin reiniciar.
const config = {};

function reload() {
  loadDotEnv();
  const json = loadJsonConfig();
  const get = (key, fallback = null) => {
    const value = json[key] !== undefined && json[key] !== '' ? json[key] : process.env[key];
    return value === undefined || value === '' ? fallback : value;
  };

  config.wcBaseUrl = String(get('WC_BASE_URL', '')).replace(/\/+$/, '');
  config.wcConsumerKey = get('WC_CONSUMER_KEY', '');
  config.wcConsumerSecret = get('WC_CONSUMER_SECRET', '');
  config.registerId = get('REGISTER_ID', 'CAJA1');
  config.logoUrl = get('LOGO_URL', null);
  config.printerInterface = get('PRINTER_INTERFACE', 'printer:auto');
  // Ajuste global de precios en %, aplicado sobre el precio que viene de WooCommerce.
  // Positivo = recargo (ej. 10 sube todo 10%), negativo = descuento (ej. -5 baja 5%).
  // Dominio de los correos que se generan para clientes creados en el POS. WooCommerce
  // exige email único por cliente, pero en mostrador nadie lo pide.
  // Cómo se marca el origen de la orden en WooCommerce.
  //   'mobile_app' -> source type válido del enum de Woo, sin campos acompañantes.
  //   'admin'      -> alternativa válida (creada desde el panel).
  //   'none'       -> no manda nada de atribución (lo más seguro si algo se rompe).
  // NO usar 'utm': hace que Woo intente renderizar utm_campaign/device_type/
  // session_page_views y truena el detalle de la orden y el historial del cliente.
  config.orderAttribution = get('ORDER_ATTRIBUTION', 'mobile_app');
  config.posEmailDomain = get('POS_EMAIL_DOMAIN', 'pos.com');
  config.priceAdjustmentPercent = parseFloat(get('PRICE_ADJUSTMENT_PERCENT', '0')) || 0;
  config.syncIntervalMs = parseInt(get('SYNC_INTERVAL_MS', '30000'), 10);
  config.customersSyncIntervalMs = parseInt(get('CUSTOMERS_SYNC_INTERVAL_MS', '600000'), 10);
  return config;
}

// Sin estos tres no hay forma de hablar con WooCommerce.
function isConfigured() {
  return Boolean(config.wcBaseUrl && config.wcConsumerKey && config.wcConsumerSecret);
}

// Devuelve lo que la pantalla de Ajustes necesita mostrar/editar.
function getEditableConfig() {
  return {
    WC_BASE_URL: config.wcBaseUrl,
    WC_CONSUMER_KEY: config.wcConsumerKey,
    WC_CONSUMER_SECRET: config.wcConsumerSecret,
    REGISTER_ID: config.registerId,
    LOGO_URL: config.logoUrl || '',
    PRINTER_INTERFACE: config.printerInterface,
    PRICE_ADJUSTMENT_PERCENT: String(config.priceAdjustmentPercent),
  };
}

function saveConfig(values) {
  const current = loadJsonConfig();
  const merged = { ...current, ...values };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8');
  reload();
  return getEditableConfig();
}

reload();

config.isConfigured = isConfigured;
config.getEditableConfig = getEditableConfig;
config.saveConfig = saveConfig;
config.reload = reload;
config.configPath = configPath;

module.exports = config;
