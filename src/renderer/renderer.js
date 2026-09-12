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

  // Sin turno abierto no se puede cobrar (el corte no cuadraría). En vez de soltar un
  // error y dejarlo atorado, se le abre el panel para que abra caja ahí mismo.
  if (!cashSession) {
    showToast('Abre la caja antes de cobrar.', true);
    openCashPanel();
    return;
  }

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
    refreshCashState();
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

// ---------- Control de efectivo ----------

let cashSession = null;

async function refreshCashState() {
  cashSession = await window.pos.getCashSession();
  const btn = document.getElementById('btnCash');
  if (cashSession) {
    btn.textContent = `Caja abierta · ${money(cashSession.expected)}`;
    btn.classList.remove('closed');
  } else {
    btn.textContent = 'Caja cerrada — abrir';
    btn.classList.add('closed');
  }
}

async function renderCashPanel() {
  const body = document.getElementById('cashBody');
  await refreshCashState();

  // Con la caja cerrada, "Cerrar" se leería como "cerrar la caja". Es solo descartar.
  document.getElementById('btnCloseCash').textContent = cashSession ? 'Cerrar' : 'Ahora no';

  if (!cashSession) {
    body.innerHTML = `
      <div class="cash-section-title">Fondo inicial en el cajón</div>
      <input id="openingFloat" type="number" step="0.01" min="0" placeholder="0.00" />
      <button class="cash-action-btn" id="btnOpenCash">Abrir caja</button>
    `;
    document.getElementById('btnOpenCash').onclick = async () => {
      const amount = parseFloat(document.getElementById('openingFloat').value) || 0;
      try {
        await window.pos.openCashSession(amount);
        showToast('Caja abierta.');
        renderCashPanel();
      } catch (err) {
        showToast(err.message, true);
      }
    };
    return;
  }

  const s = cashSession;
  const movements = await window.pos.getCashMovements();

  body.innerHTML = `
    <div class="cash-line"><span class="muted">Abierta desde</span><span>${new Date(s.opened_at).toLocaleString()}</span></div>
    <div class="cash-line"><span class="muted">Fondo inicial</span><span>${money(s.opening_float)}</span></div>
    <div class="cash-line"><span class="muted">Ventas en efectivo (${s.cashSalesCount})</span><span>${money(s.cashSalesTotal)}</span></div>
    <div class="cash-line"><span class="muted">Ingresos</span><span>${money(s.cashIn)}</span></div>
    <div class="cash-line"><span class="muted">Retiros</span><span>−${money(s.cashOut)}</span></div>
    <div class="cash-line total"><span>Esperado en cajón</span><span>${money(s.expected)}</span></div>
    <div class="cash-line"><span class="muted">Ventas con tarjeta (${s.cardSalesCount})</span><span class="muted">${money(s.cardSalesTotal)} · no afecta cajón</span></div>

    <div class="cash-section-title">Registrar movimiento</div>
    <input id="movAmount" type="number" step="0.01" min="0" placeholder="Monto" />
    <input id="movReason" type="text" placeholder="Motivo (ej. pago a proveedor)" />
    <div class="cash-row-2">
      <button class="cash-action-btn secondary" id="btnMovIn">+ Ingreso</button>
      <button class="cash-action-btn secondary" id="btnMovOut">− Retiro</button>
    </div>

    ${movements.length > 0 ? `
      <div class="cash-section-title">Movimientos del turno</div>
      ${movements.map((m) => `
        <div class="cash-line">
          <span class="muted">${m.type === 'in' ? '+' : '−'} ${m.reason || '(sin motivo)'}</span>
          <span>${money(m.amount)}</span>
        </div>
      `).join('')}
    ` : ''}

    <div class="cash-section-title">Cerrar turno (corte)</div>
    <input id="countedAmount" type="number" step="0.01" min="0" placeholder="Efectivo contado en el cajón" />
    <button class="cash-action-btn danger" id="btnCloseSession">Hacer corte e imprimir</button>
  `;

  const registerMovement = async (type) => {
    const amount = parseFloat(document.getElementById('movAmount').value);
    const reason = document.getElementById('movReason').value.trim();
    try {
      await window.pos.addCashMovement({ type, amount, reason });
      showToast(type === 'in' ? 'Ingreso registrado.' : 'Retiro registrado.');
      renderCashPanel();
    } catch (err) {
      showToast(err.message, true);
    }
  };
  document.getElementById('btnMovIn').onclick = () => registerMovement('in');
  document.getElementById('btnMovOut').onclick = () => registerMovement('out');

  document.getElementById('btnCloseSession').onclick = async () => {
    const countedInput = document.getElementById('countedAmount');
    if (countedInput.value === '') {
      showToast('Captura el efectivo contado antes de cerrar.', true);
      return;
    }
    const counted = parseFloat(countedInput.value) || 0;
    const diff = counted - s.expected;
    const diffMsg = diff === 0
      ? 'Cuadra exacto.'
      : diff > 0 ? `Sobrante de ${money(diff)}.` : `Faltante de ${money(Math.abs(diff))}.`;

    if (!confirm(`${diffMsg}\n\n¿Cerrar el turno? Esto no se puede deshacer.`)) return;

    try {
      const result = await window.pos.closeCashSession(counted);
      showToast(
        result.printed
          ? `Corte cerrado. ${diffMsg}`
          : `Corte cerrado (${diffMsg}) pero falló la impresión: ${result.printError}`,
        !result.printed
      );
      renderCashPanel();
    } catch (err) {
      showToast(err.message, true);
    }
  };
}

function openCashPanel() {
  document.getElementById('cashOverlay').classList.add('show');
  renderCashPanel();
}

document.getElementById('btnCash').addEventListener('click', openCashPanel);
document.getElementById('btnCloseCash').addEventListener('click', () => {
  document.getElementById('cashOverlay').classList.remove('show');
});

// F11 para salir/entrar de pantalla completa (no hay menú que lo ofrezca).
document.addEventListener('keydown', (e) => {
  if (e.key === 'F11') {
    e.preventDefault();
    window.pos.toggleFullscreen();
  }
});

// ---------- Ventas recientes / reimpresión ----------

const STATUS_LABELS = {
  pending: 'por sincronizar',
  synced: 'sincronizada',
  error: 'con error',
  resolved_manually: 'resuelta manual',
};

async function renderSalesPanel() {
  const body = document.getElementById('salesBody');
  body.innerHTML = '<div style="font-size:13px; color:var(--ink-soft);">Cargando...</div>';

  const orders = await window.pos.getRecentOrders();
  body.innerHTML = '';

  if (orders.length === 0) {
    body.innerHTML = '<div style="font-size:13px; color:var(--ink-soft);">Todavía no hay ventas en esta caja.</div>';
    return;
  }

  for (const o of orders) {
    const row = document.createElement('div');
    row.className = 'sale-row';
    const when = new Date(o.created_at).toLocaleString();
    const pay = o.payment_method === 'card' ? 'Tarjeta' : o.payment_method === 'cash' ? 'Efectivo' : '—';
    row.innerHTML = `
      <div class="sr-info">
        <div class="sr-ticket">${o.local_ticket}</div>
        <div class="sr-meta">${when} · ${pay} · ${STATUS_LABELS[o.status] || o.status}</div>
      </div>
      <span class="sr-total">${money(o.total)}</span>
      <button data-action="reprint">Reimprimir</button>
    `;
    row.querySelector('[data-action="reprint"]').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Imprimiendo...';
      try {
        await window.pos.reprintOrder(o.id);
        showToast(`Ticket ${o.local_ticket} reimpreso.`);
      } catch (err) {
        showToast(`No se pudo reimprimir: ${err.message}`, true);
      }
      e.target.disabled = false;
      e.target.textContent = 'Reimprimir';
    };
    body.appendChild(row);
  }
}

document.getElementById('btnSales').addEventListener('click', () => {
  document.getElementById('salesOverlay').classList.add('show');
  renderSalesPanel();
});
document.getElementById('btnCloseSales').addEventListener('click', () => {
  document.getElementById('salesOverlay').classList.remove('show');
});

// ---------- Ajustes ----------

const SETTINGS_FIELDS = {
  setBaseUrl: 'WC_BASE_URL',
  setKey: 'WC_CONSUMER_KEY',
  setSecret: 'WC_CONSUMER_SECRET',
  setRegister: 'REGISTER_ID',
  setPrinter: 'PRINTER_INTERFACE',
  setLogo: 'LOGO_URL',
};

async function openSettings() {
  const { values, path } = await window.pos.getConfig();
  for (const [inputId, key] of Object.entries(SETTINGS_FIELDS)) {
    document.getElementById(inputId).value = values[key] || '';
  }
  document.getElementById('settingsPath').textContent = `Archivo: ${path}`;
  document.getElementById('settingsOverlay').classList.add('show');
}

document.getElementById('btnSettings').addEventListener('click', openSettings);
document.getElementById('btnCloseSettings').addEventListener('click', () => {
  document.getElementById('settingsOverlay').classList.remove('show');
});

document.getElementById('btnSaveSettings').addEventListener('click', async () => {
  const values = {};
  for (const [inputId, key] of Object.entries(SETTINGS_FIELDS)) {
    values[key] = document.getElementById(inputId).value.trim();
  }
  try {
    const result = await window.pos.saveConfig(values);
    if (!result.isConfigured) {
      showToast('Guardado, pero faltan URL, key o secret para conectar.', true);
      return;
    }
    // Varios valores (intervalos de sync, impresora) se leen al arrancar, así que
    // el reinicio no es opcional para que todo tome efecto.
    showToast('Guardado. Reinicia la app para aplicar todos los cambios.');
    document.getElementById('settingsOverlay').classList.remove('show');
  } catch (err) {
    showToast(`No se pudo guardar: ${err.message}`, true);
  }
});

// ---------- Lector de código de barras ----------
// Un lector USB se comporta como teclado: teclea muy rápido y manda Enter. Se detecta
// por velocidad (teclas a menos de 40ms una de otra), no por foco, para que funcione
// aunque el cajero no haya hecho click en el buscador.

let scanBuffer = '';
let lastKeyTime = 0;
const SCAN_MAX_GAP_MS = 40;

async function handleScan(code) {
  const match = await window.pos.findBySku(code);

  if (!match) {
    showToast(`Código no encontrado: ${code}`, true);
    return;
  }

  if (match.kind === 'needs-variation') {
    // Es un producto variable: el SKU del padre no se puede vender directo.
    const parent = allProducts.find((p) => p.id === match.product_id);
    if (parent) {
      openVariationPicker(parent);
    } else {
      showToast(`${match.name}: elige la variación en el catálogo.`, true);
    }
    return;
  }

  const existing = cart.find(
    (i) => i.product_id === match.product_id && i.variation_id == match.variation_id
  );
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      product_id: match.product_id,
      variation_id: match.variation_id,
      name: match.name,
      price: match.price || 0,
      quantity: 1,
      manage_stock: match.manage_stock,
      stock_quantity: match.stock_quantity,
    });
  }
  renderCart();
  showToast(`Agregado: ${match.name}`);
}

document.addEventListener('keydown', (e) => {
  // No interferir con modales abiertos ni con escritura manual en campos de texto
  // libre (nota, motivo de movimiento, ajustes).
  const anyOverlayOpen = document.querySelector(
    '#errorOverlay.show, #variationOverlay.show, #customerOverlay.show, #cashOverlay.show, #salesOverlay.show, #settingsOverlay.show'
  );
  if (anyOverlayOpen) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'TEXTAREA') return;

  const now = Date.now();

  if (e.key === 'Enter') {
    if (scanBuffer.length >= 3) {
      e.preventDefault();
      const code = scanBuffer;
      scanBuffer = '';
      // Si el lector escribió dentro del buscador, limpiarlo: ya se procesó como escaneo.
      const search = document.getElementById('search');
      if (document.activeElement === search) {
        search.value = '';
        loadProducts();
      }
      handleScan(code);
    }
    scanBuffer = '';
    return;
  }

  if (e.key.length !== 1) return; // ignora Shift, flechas, etc.

  // Pausa larga = tecleo humano, no escaneo: se reinicia el buffer.
  if (now - lastKeyTime > SCAN_MAX_GAP_MS) scanBuffer = '';
  scanBuffer += e.key;
  lastKeyTime = now;
});

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

  // Si falta la configuración de WooCommerce, eso va primero: sin ella no hay catálogo
  // ni sincronización, y abrir caja no sirve de nada.
  const { isConfigured } = await window.pos.getConfig();
  if (!isConfigured) {
    showToast('Falta configurar la conexión con WooCommerce.', true);
    openSettings();
    return;
  }

  // Si no hay turno abierto, el panel de caja se abre solo: abrir caja es lo primero
  // del día, no algo que el cajero deba ir a buscar en el riel.
  await refreshCashState();
  if (!cashSession) openCashPanel();

  setInterval(() => { refreshErrorBadge(); refreshCashState(); }, 15000);
})();
