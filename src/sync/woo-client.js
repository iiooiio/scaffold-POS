const config = require('../config');

// Requiere Node >= 18 (fetch global). Electron 31 trae Node 20+, así que está cubierto.

function buildUrl(pathname, params = {}) {
  const url = new URL(`${config.wcBaseUrl}/wp-json/wc/v3${pathname}`);
  url.searchParams.set('consumer_key', config.wcConsumerKey);
  url.searchParams.set('consumer_secret', config.wcConsumerSecret);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return url.toString();
}

async function wcGet(pathname, params) {
  const res = await fetch(buildUrl(pathname, params));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WC GET ${pathname} -> ${res.status}: ${text}`);
  }
  return res.json();
}

async function wcPost(pathname, body) {
  const res = await fetch(buildUrl(pathname), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && data.message ? data.message : `HTTP ${res.status}`;
    const err = new Error(`WC POST ${pathname} -> ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Trae todos los productos, paginando. Usa modified_after para pulls incrementales.
async function fetchAllProducts({ modifiedAfter } = {}) {
  const perPage = 100;
  let page = 1;
  const all = [];

  while (true) {
    const params = { per_page: perPage, page, orderby: 'modified', order: 'asc' };
    if (modifiedAfter) params.modified_after = modifiedAfter;

    const batch = await wcGet('/products', params);
    all.push(...batch);

    if (batch.length < perPage) break;
    page += 1;
  }

  return all;
}

// Trae TODAS las variaciones de un producto variable. A diferencia de fetchAllProducts,
// no usa modified_after -- no verifiqué si el sub-endpoint de variaciones lo soporta
// igual que /products, así que por seguridad se re-trae completo cada sync. Si tienes
// productos con muchísimas variaciones esto puede ser lento; no lo medí.
async function fetchProductVariations(productId) {
  const perPage = 100;
  let page = 1;
  const all = [];

  while (true) {
    const batch = await wcGet(`/products/${productId}/variations`, { per_page: perPage, page });
    all.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }

  return all;
}

// Trae TODOS los clientes. Sin modified_after -- Woo NO soporta sync incremental en este
// endpoint (confirmado: es un feature request abierto desde hace años, nunca lo
// agregaron). Por eso esto se llama en un intervalo aparte y más espaciado que el de
// catálogo, no en cada tick del sync normal.
async function fetchAllCustomers() {
  const perPage = 100;
  let page = 1;
  const all = [];

  while (true) {
    const batch = await wcGet('/customers', { per_page: perPage, page, orderby: 'id', order: 'asc' });
    all.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }

  return all;
}

async function wcPut(pathname, body) {
  const res = await fetch(buildUrl(pathname), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && data.message ? data.message : `HTTP ${res.status}`;
    const err = new Error(`WC PUT ${pathname} -> ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// WooCommerce devuelve el stock al cambiar una orden a 'cancelled', así que no hay que
// reponer inventario a mano.
async function cancelWooOrder(wcOrderId) {
  return wcPut(`/orders/${wcOrderId}`, { status: 'cancelled' });
}

// Se necesita para las devoluciones parciales: los ids de línea de una orden los asigna
// WooCommerce, así que hay que leerlos de allá para decirle qué línea devolver.
async function getOrder(wcOrderId) {
  return wcGet(`/orders/${wcOrderId}`);
}

async function createRefund(wcOrderId, refundPayload) {
  return wcPost(`/orders/${wcOrderId}/refunds`, refundPayload);
}

async function createCustomer(customerPayload) {
  return wcPost('/customers', customerPayload);
}

async function createOrder(orderPayload) {
  return wcPost('/orders', orderPayload);
}

// Chequeo simple de conectividad contra el propio sitio (no depende de internet en general,
// solo de que el sitio WooCommerce responda).
async function isOnline() {
  try {
    const res = await fetch(buildUrl('/system_status'), { method: 'GET' });
    return res.ok || res.status === 401 || res.status === 403; // responde = hay red hacia el sitio
  } catch {
    return false;
  }
}

module.exports = { fetchAllProducts, fetchProductVariations, fetchAllCustomers, createCustomer, createOrder, cancelWooOrder, getOrder, createRefund, isOnline };
