let cart = []; // { product_id, variation_id (null si es simple), name, price, quantity, manage_stock, stock_quantity }
let selectedCategory = 'all';
let paymentMethod = 'cash';
let selectedCustomer = null; // { id, first_name, last_name, email, phone }
let allProducts = []; // cache local para filtrar categorías sin volver a pedir a la DB

// ---------- Utilidades ----------

function money(n) {
  return `$${(n || 0).toFixed(2)}`;
}

function variationLabel(attributes) {
  return (attributes || []).map((a) => a.option).filter(Boolean).join(', ');
}

// Sugiere montos de efectivo según el total: el exacto, más los billetes comunes en MXN
// que alcanzan a cubrirlo, más un par de redondeos (a 50/100/500) para totales grandes.
function quickCashAmounts(total) {
  if (total <= 0) return [];
  const bills = [20, 50, 100, 200, 500, 1000];
  const roundUp = (n, step) => Math.ceil(n / step) * step;

  const options = new Set([Math.ceil(total)]);
  for (const bill of bills) {
    if (bill >= total) options.add(bill);
  }
  options.add(roundUp(total, 50));
  options.add(roundUp(total, 100));

  return [...options].filter((a) => a >= total).sort((a, b) => a - b).slice(0, 5);
}

function showToast(message, isWarn = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('warn', isWarn);
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 3500);
}

// Extrae categorías de Woo desde raw_json (no está en columnas propias del schema).
function extractCategories(product) {
  try {
    const raw = JSON.parse(product.raw_json);
    return (raw.categories || []).map((c) => c.name);
  } catch {
    return [];
  }
}

// ---------- Conectividad (aproximada) ----------
// navigator.onLine solo dice si el SO tiene una interfaz de red activa, NO si el sitio
// WooCommerce responde. Es un indicador aproximado para la UI; el chequeo real que
// decide si se sincroniza vive en isOnline() del proceso principal.
function updateConnDot() {
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connLabel');
  const online = navigator.onLine;
  dot.className = `dot ${online ? 'online' : 'offline'}`;
  label.textContent = online ? 'Con red' : 'Sin red';
}
window.addEventListener('online', updateConnDot);
window.addEventListener('offline', updateConnDot);

// ---------- Catálogo ----------

async function loadProducts(search) {
  allProducts = await window.pos.getProducts(search);
  renderCategoryTabs();
  renderProductGrid();
}

function renderCategoryTabs() {
  const cats = new Set();
  allProducts.forEach((p) => extractCategories(p).forEach((c) => cats.add(c)));

  const container = document.getElementById('categoryTabs');
  container.innerHTML = '';

  const allTab = document.createElement('button');
  allTab.className = `cat-tab ${selectedCategory === 'all' ? 'active' : ''}`;
  allTab.textContent = 'Todos';
  allTab.onclick = () => { selectedCategory = 'all'; renderCategoryTabs(); renderProductGrid(); };
  container.appendChild(allTab);

  for (const cat of cats) {
    const tab = document.createElement('button');
    tab.className = `cat-tab ${selectedCategory === cat ? 'active' : ''}`;
    tab.textContent = cat;
    tab.onclick = () => { selectedCategory = cat; renderCategoryTabs(); renderProductGrid(); };
    container.appendChild(tab);
  }
}

function renderProductGrid() {
  const grid = document.getElementById('productGrid');
  grid.innerHTML = '';

  const filtered = selectedCategory === 'all'
    ? allProducts
    : allProducts.filter((p) => extractCategories(p).includes(selectedCategory));

  if (filtered.length === 0) {
    grid.innerHTML = '<div id="emptyState">Sin productos en esta categoría.</div>';
    return;
  }

  for (const p of filtered) {
    const outOfStock = p.type !== 'variable' && p.manage_stock && p.stock_quantity <= 0;
    const cartQty = cart.filter((i) => i.product_id === p.id).reduce((sum, i) => sum + i.quantity, 0);

    const tile = document.createElement('button');
    tile.className = `product-tile ${outOfStock ? 'no-stock' : ''}`;
    tile.disabled = outOfStock;

    const imgHtml = p.image_url
      ? `<img class="p-image" src="${p.image_url}" alt="" onerror="this.style.display='none'" />`
      : `<div class="p-image p-image-placeholder"></div>`;

    tile.innerHTML = `
      ${cartQty > 0 ? `
        <div class="tile-badge">
          <span class="tb-qty">${cartQty}</span>
          <span class="tb-remove" title="Quitar del carrito">×</span>
        </div>
      ` : ''}
      ${imgHtml}
      <div class="p-name">${p.name}</div>
      <div>
        ${p.type === 'variable'
          ? '<div class="p-price p-variable-hint">Varias opciones</div>'
          : `<div class="p-price">${money(p.price)}</div>`}
        ${p.type !== 'variable' && p.manage_stock ? `<div class="p-stock">${p.stock_quantity} disp.</div>` : ''}
      </div>
    `;

    // Producto variable: abre selector de variación. Simple: agrega/incrementa directo.
    tile.onclick = () => (p.type === 'variable' ? openVariationPicker(p) : addToCart(p));

    // Click en la × del badge = quitar del carrito. Para variables, quita TODAS sus
    // variaciones de un jalón (simplificación -- para quitar solo una, usar el carrito).
    const removeBtn = tile.querySelector('.tb-remove');
    if (removeBtn) {
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        cart = cart.filter((i) => i.product_id !== p.id);
        renderCart();
      };
    }

    grid.appendChild(tile);
  }
}

// ---------- Carrito ----------

function addToCart(p) {
  const existing = cart.find((i) => i.product_id === p.id && !i.variation_id);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      product_id: p.id,
      variation_id: null,
      name: p.name,
      price: p.price || 0,
      quantity: 1,
      manage_stock: p.manage_stock,
      stock_quantity: p.stock_quantity,
    });
  }
  renderCart();
}

function addVariationToCart(parent, variation) {
  const existing = cart.find((i) => i.variation_id === variation.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      product_id: parent.id,
      variation_id: variation.id,
      name: `${parent.name} — ${variationLabel(variation.attributes)}`,
      price: variation.price || parent.price || 0,
      quantity: 1,
      manage_stock: variation.manage_stock,
      stock_quantity: variation.stock_quantity,
    });
  }
  renderCart();
}

function changeQty(productId, variationId, delta) {
  const item = cart.find((i) => i.product_id === productId && i.variation_id == variationId);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) {
    cart = cart.filter((i) => i !== item);
  }
  renderCart();
}

function removeFromCart(productId, variationId) {
  cart = cart.filter((i) => !(i.product_id === productId && i.variation_id == variationId));
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cartItems');
  const empty = document.getElementById('cartEmpty');
  container.innerHTML = '';

  if (cart.length === 0) {
    container.appendChild(empty);
  } else {
    for (const item of cart) {
      const line = document.createElement('div');
      line.className = 'cart-line';
      line.innerHTML = `
        <span class="cl-name">${item.name}</span>
        <span class="cl-qty">
          <button data-action="dec">−</button>
          <span>${item.quantity}</span>
          <button data-action="inc">+</button>
        </span>
        <span class="cl-subtotal">${money(item.price * item.quantity)}</span>
        <button class="cl-remove" data-action="remove">×</button>
      `;
      line.querySelector('[data-action="dec"]').onclick = () => changeQty(item.product_id, item.variation_id, -1);
      line.querySelector('[data-action="inc"]').onclick = () => changeQty(item.product_id, item.variation_id, 1);
      line.querySelector('[data-action="remove"]').onclick = () => removeFromCart(item.product_id, item.variation_id);
      container.appendChild(line);
    }
  }

  document.getElementById('totalAmount').textContent = money(getTotal());
  updateChangeAndCheckoutState();

  renderProductGrid(); // mantiene el badge de cantidad del grid sincronizado
}

// ---------- Pago y checkout ----------

document.querySelectorAll('.pay-btn').forEach((btn) => {
  btn.onclick = () => {
    paymentMethod = btn.dataset.method;
    document.querySelectorAll('.pay-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('cashRow').classList.toggle('show', paymentMethod === 'cash');
    updateChangeAndCheckoutState();
  };
});

function getTotal() {
  return cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

// Calcula el cambio en vivo y bloquea "Cobrar" si el efectivo recibido no alcanza.
// Con tarjeta no aplica -- se asume que se cobra el monto exacto en la terminal.
function updateChangeAndCheckoutState() {
  const btn = document.getElementById('btnCheckout');
  const total = getTotal();

  if (paymentMethod !== 'cash') {
    document.getElementById('changeRow').classList.remove('insufficient');
    document.getElementById('changeAmount').textContent = '';
    btn.disabled = cart.length === 0;
    return;
  }

  const receivedInput = document.getElementById('cashReceived');
  const received = parseFloat(receivedInput.value) || 0;
  const change = received - total;
  const insufficient = received < total;

  document.getElementById('changeAmount').textContent = money(Math.max(change, 0));
  document.getElementById('changeRow').classList.toggle('insufficient', insufficient);
  receivedInput.classList.toggle('insufficient', insufficient && receivedInput.value !== '');

  renderCashPills(total, received);

  btn.disabled = cart.length === 0 || insufficient;
}

function renderCashPills(total, currentReceived) {
  const container = document.getElementById('cashPills');
  container.innerHTML = '';
  for (const amount of quickCashAmounts(total)) {
    const pill = document.createElement('button');
    pill.className = `cash-pill ${amount === currentReceived ? 'selected' : ''}`;
    pill.textContent = money(amount);
    pill.onclick = () => {
      document.getElementById('cashReceived').value = amount;
      updateChangeAndCheckoutState();
    };
    container.appendChild(pill);
  }
}

document.getElementById('cashReceived').addEventListener('input', updateChangeAndCheckoutState);

document.getElementById('noteCheckbox').addEventListener('change', (e) => {
  document.getElementById('noteText').classList.toggle('show', e.target.checked);
  if (!e.target.checked) document.getElementById('noteText').value = '';
});

document.getElementById('btnCheckout').addEventListener('click', async () => {
  if (cart.length === 0) return;
  const btn = document.getElementById('btnCheckout');
  btn.disabled = true;
  btn.textContent = 'Procesando...';

  const total = getTotal();
  const received = paymentMethod === 'cash' ? parseFloat(document.getElementById('cashReceived').value) || 0 : total;
  const change = paymentMethod === 'cash' ? received - total : 0;
  const noteChecked = document.getElementById('noteCheckbox').checked;
  const note = noteChecked ? document.getElementById('noteText').value.trim() : '';

  try {
    const result = await window.pos.checkout(cart, paymentMethod, { received, change }, note, selectedCustomer?.id);
    document.getElementById('lastTicket').textContent = result.localTicket;
    showToast(
      result.printed
        ? `Venta ${result.localTicket} registrada e impresa.`
        : `Venta ${result.localTicket} registrada. Falló la impresión: ${result.printError}`,
      !result.printed
    );
    cart = [];
    document.getElementById('cashReceived').value = '';
    document.getElementById('noteCheckbox').checked = false;
    document.getElementById('noteText').value = '';
    document.getElementById('noteText').classList.remove('show');
    selectedCustomer = null;
    updateCustomerButton();
    renderCart();
  } catch (err) {
    showToast(`Error al cobrar: ${err.message}`, true);
  }

  btn.textContent = 'Cobrar e imprimir';
  updateChangeAndCheckoutState();
});

// ---------- Sincronización de catálogo ----------

document.getElementById('btnSyncCatalog').addEventListener('click', async () => {
  const label = document.getElementById('catalogSyncedAt');
  label.textContent = 'Sincronizando...';
  try {
    const result = await window.pos.syncCatalogNow();
    label.textContent = new Date(result.syncedAt).toLocaleTimeString();
    const imgMsg = result.imagesFailed > 0
      ? ` — ${result.imagesOk} imágenes bajadas, ${result.imagesFailed} fallaron (ver consola)`
      : result.imagesOk > 0 ? ` — ${result.imagesOk} imágenes bajadas` : '';
    showToast(`Catálogo actualizado (${result.count} productos).${imgMsg}`, result.imagesFailed > 0);
  } catch (err) {
    label.textContent = 'Error de sync';
    showToast(`No se pudo sincronizar (¿sin conexión?): ${err.message}`, true);
  }
  loadProducts(document.getElementById('search').value);
});

document.getElementById('search').addEventListener('input', (e) => loadProducts(e.target.value));

// ---------- Panel de errores de sincronización ----------

async function refreshErrorBadge() {
  const summary = await window.pos.getQueueSummary();
  const errorRow = summary.find((s) => s.status === 'error');
  const count = errorRow ? errorRow.count : 0;

  const btn = document.getElementById('btnErrors');
  document.getElementById('errorCount').textContent = count;
  btn.style.display = count > 0 ? 'block' : 'none';
}

async function renderErrorPanel() {
  const errors = await window.pos.getQueueErrors();
  const body = document.getElementById('errorListBody');
  body.innerHTML = '';

  if (errors.length === 0) {
    body.innerHTML = '<div style="font-size:13px; color:var(--ink-soft);">Sin errores pendientes.</div>';
    return;
  }

  for (const order of errors) {
    const itemsText = order.display_items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
    const div = document.createElement('div');
    div.className = 'error-order';
    div.innerHTML = `
      <div class="eo-head"><span>${order.local_ticket}</span><span>${money(order.total)}</span></div>
      <div class="eo-items">${itemsText}</div>
      <div class="eo-msg">${order.error_message}</div>
      <div class="eo-actions">
        <button data-action="retry">Reintentar</button>
        <button data-action="resolve">Marcar resuelto</button>
      </div>
    `;
    div.querySelector('[data-action="retry"]').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Reintentando...';
      try {
        await window.pos.retryOrder(order.id);
        showToast(`${order.local_ticket} reintentado.`);
      } catch (err) {
        showToast(`No se pudo reintentar: ${err.message}`, true);
      }
      renderErrorPanel();
      refreshErrorBadge();
    };
    div.querySelector('[data-action="resolve"]').onclick = async () => {
      const note = prompt('¿Cómo se resolvió? (opcional, queda en el registro)') || '';
      try {
        await window.pos.resolveManually(order.id, note);
        showToast(`${order.local_ticket} marcado como resuelto.`);
      } catch (err) {
        showToast(`Error: ${err.message}`, true);
      }
      renderErrorPanel();
      refreshErrorBadge();
    };
    body.appendChild(div);
  }
}

document.getElementById('btnErrors').addEventListener('click', () => {
  document.getElementById('errorOverlay').classList.add('show');
  renderErrorPanel();
});
document.getElementById('btnCloseErrors').addEventListener('click', () => {
  document.getElementById('errorOverlay').classList.remove('show');
});

window.pos.onQueueUpdated((data) => {
  if (data.attempted > 0) {
    showToast(`Sync de cola: ${data.synced} enviadas, ${data.failed} con error.`, data.failed > 0);
  }
  refreshErrorBadge();
});

// ---------- Selector de variaciones (talla/color/etc.) ----------

async function openVariationPicker(parent) {
  const overlay = document.getElementById('variationOverlay');
  const title = document.getElementById('variationTitle');
  const body = document.getElementById('variationListBody');

  title.textContent = parent.name;
  body.innerHTML = '<div style="font-size:13px; color:var(--ink-soft);">Cargando opciones...</div>';
  overlay.classList.add('show');

  let variations;
  try {
    variations = await window.pos.getVariations(parent.id);
  } catch (err) {
    body.innerHTML = `<div style="font-size:13px; color:var(--warn);">No se pudieron cargar las opciones: ${err.message}</div>`;
    return;
  }

  if (variations.length === 0) {
    body.innerHTML = '<div style="font-size:13px; color:var(--ink-soft);">Este producto no tiene variaciones sincronizadas. Prueba sincronizar el catálogo.</div>';
    return;
  }

  body.innerHTML = '';
  for (const v of variations) {
    const outOfStock = v.manage_stock && v.stock_quantity <= 0;
    const row = document.createElement('button');
    row.className = 'variation-row';
    row.disabled = outOfStock;
    row.innerHTML = `
      <span class="vr-label">${variationLabel(v.attributes) || '(sin atributos)'}</span>
      <span class="vr-price">${money(v.price || parent.price)}</span>
      ${v.manage_stock ? `<span class="vr-stock">${v.stock_quantity} disp.</span>` : ''}
    `;
    row.onclick = () => {
      addVariationToCart(parent, v);
      overlay.classList.remove('show');
    };
    body.appendChild(row);
  }
}

document.getElementById('btnCloseVariations').addEventListener('click', () => {
  document.getElementById('variationOverlay').classList.remove('show');
});

// ---------- Selector de cliente ----------

function customerDisplayName(c) {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
  return name || c.email || c.phone || `Cliente #${c.id}`;
}

function updateCustomerButton() {
  const btn = document.getElementById('btnSelectCustomer');
  const clearBtn = document.getElementById('btnClearCustomer');
  if (selectedCustomer) {
    btn.textContent = `Cliente: ${customerDisplayName(selectedCustomer)}`;
    btn.classList.add('has-customer');
    clearBtn.classList.add('show');
  } else {
    btn.textContent = 'Cliente: Ninguno';
    btn.classList.remove('has-customer');
    clearBtn.classList.remove('show');
  }
}

async function renderCustomerList(search) {
  const body = document.getElementById('customerListBody');
  const customers = await window.pos.getCustomers(search);
  body.innerHTML = '';

  if (customers.length === 0) {
    body.innerHTML = '<div style="font-size:13px; color:var(--ink-soft);">Sin resultados.</div>';
    return;
  }

  for (const c of customers) {
    const row = document.createElement('button');
    row.className = 'customer-row';
    row.innerHTML = `
      <div class="cr-name">${customerDisplayName(c)}</div>
      <div class="cr-detail">${[c.email, c.phone].filter(Boolean).join(' · ')}</div>
    `;
    row.onclick = () => {
      selectedCustomer = c;
      updateCustomerButton();
      document.getElementById('customerOverlay').classList.remove('show');
    };
    body.appendChild(row);
  }
}

document.getElementById('btnSelectCustomer').addEventListener('click', () => {
  document.getElementById('customerOverlay').classList.add('show');
  document.getElementById('customerSearch').value = '';
  renderCustomerList();
});
document.getElementById('btnClearCustomer').addEventListener('click', () => {
  selectedCustomer = null;
  updateCustomerButton();
});
document.getElementById('btnCloseCustomers').addEventListener('click', () => {
  document.getElementById('customerOverlay').classList.remove('show');
});
document.getElementById('customerSearch').addEventListener('input', (e) => renderCustomerList(e.target.value));

// ---------- Arranque ----------

(async function init() {
  // Si el preload falló, window.pos no existe y TODA la UI queda muerta sin señal.
  // Mejor decirlo en pantalla que dejar la app en silencio.
  if (!window.pos) {
    document.getElementById('connLabel').textContent = 'Error: preload no cargó';
    document.getElementById('connDot').className = 'dot offline';
    return;
  }

  try {
    document.getElementById('railRegisterName').textContent = await window.pos.getRegisterId();

    const logoUrl = await window.pos.getLogoUrl();
    if (logoUrl) {
      const img = document.getElementById('railLogo');
      img.src = logoUrl;
      img.style.display = 'block';
    }
  } catch (err) {
    // No abortamos: el catálogo y el carrito deben funcionar aunque el logo o el
    // register id fallen.
    console.error('[init] fallo parcial:', err);
  }

  updateConnDot();
  updateCustomerButton();
  loadProducts();
  renderCart();
  refreshErrorBadge();
  setInterval(refreshErrorBadge, 15000);
})();
