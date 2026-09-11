let cart = []; // { product_id, name, price, quantity, manage_stock, stock_quantity }
let selectedCategory = 'all';
let paymentMethod = 'cash';
let allProducts = []; // cache local para filtrar categorías sin volver a pedir a la DB

// ---------- Utilidades ----------

function money(n) {
  return `$${(n || 0).toFixed(2)}`;
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
    const outOfStock = p.manage_stock && p.stock_quantity <= 0;
    const cartItem = cart.find((i) => i.product_id === p.id);

    const tile = document.createElement('button');
    tile.className = `product-tile ${outOfStock ? 'no-stock' : ''}`;
    tile.disabled = outOfStock;
    tile.innerHTML = `
      ${cartItem ? `
        <div class="tile-badge">
          <span class="tb-qty">${cartItem.quantity}</span>
          <span class="tb-remove" title="Quitar del carrito">×</span>
        </div>
      ` : ''}
      <div class="p-name">${p.name}</div>
      <div>
        <div class="p-price">${money(p.price)}</div>
        ${p.manage_stock ? `<div class="p-stock">${p.stock_quantity} disp.</div>` : ''}
      </div>
    `;

    // Click en el tile (fuera del badge) = agregar/incrementar.
    tile.onclick = () => addToCart(p);

    // Click en la × del badge = quitar del carrito sin pasar por el panel derecho.
    // stopPropagation para que no dispare también el addToCart del tile.
    const removeBtn = tile.querySelector('.tb-remove');
    if (removeBtn) {
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        removeFromCart(p.id);
      };
    }

    grid.appendChild(tile);
  }
}

// ---------- Carrito ----------

function addToCart(p) {
  const existing = cart.find((i) => i.product_id === p.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      product_id: p.id,
      name: p.name,
      price: p.price || 0,
      quantity: 1,
      manage_stock: p.manage_stock,
      stock_quantity: p.stock_quantity,
    });
  }
  renderCart();
}

function changeQty(productId, delta) {
  const item = cart.find((i) => i.product_id === productId);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) {
    cart = cart.filter((i) => i.product_id !== productId);
  }
  renderCart();
}

function removeFromCart(productId) {
  cart = cart.filter((i) => i.product_id !== productId);
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
      line.querySelector('[data-action="dec"]').onclick = () => changeQty(item.product_id, -1);
      line.querySelector('[data-action="inc"]').onclick = () => changeQty(item.product_id, 1);
      line.querySelector('[data-action="remove"]').onclick = () => removeFromCart(item.product_id);
      container.appendChild(line);
    }
  }

  const total = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
  document.getElementById('totalAmount').textContent = money(total);
  document.getElementById('btnCheckout').disabled = cart.length === 0;

  renderProductGrid(); // mantiene el badge de cantidad del grid sincronizado
}

// ---------- Pago y checkout ----------

document.querySelectorAll('.pay-btn').forEach((btn) => {
  btn.onclick = () => {
    paymentMethod = btn.dataset.method;
    document.querySelectorAll('.pay-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  };
});

document.getElementById('btnCheckout').addEventListener('click', async () => {
  if (cart.length === 0) return;
  const btn = document.getElementById('btnCheckout');
  btn.disabled = true;
  btn.textContent = 'Procesando...';

  try {
    const result = await window.pos.checkout(cart, paymentMethod);
    document.getElementById('lastTicket').textContent = result.localTicket;
    showToast(
      result.printed
        ? `Venta ${result.localTicket} registrada e impresa.`
        : `Venta ${result.localTicket} registrada. Falló la impresión: ${result.printError}`,
      !result.printed
    );
    cart = [];
    renderCart();
  } catch (err) {
    showToast(`Error al cobrar: ${err.message}`, true);
  }

  btn.textContent = 'Cobrar e imprimir';
  btn.disabled = cart.length === 0;
});

// ---------- Sincronización de catálogo ----------

document.getElementById('btnSyncCatalog').addEventListener('click', async () => {
  const label = document.getElementById('catalogSyncedAt');
  label.textContent = 'Sincronizando...';
  try {
    const result = await window.pos.syncCatalogNow();
    label.textContent = new Date(result.syncedAt).toLocaleTimeString();
    showToast(`Catálogo actualizado (${result.count} productos).`);
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

// ---------- Arranque ----------

(async function init() {
  document.getElementById('railRegisterName').textContent = await window.pos.getRegisterId();
  updateConnDot();
  loadProducts();
  renderCart();
  refreshErrorBadge();
  setInterval(refreshErrorBadge, 15000);
})();
