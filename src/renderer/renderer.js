let cart = []; // { product_id, name, price, quantity }

async function loadProducts(search) {
  const products = await window.pos.getProducts(search);
  const list = document.getElementById('productList');
  list.innerHTML = '';
  for (const p of products) {
    const div = document.createElement('div');
    div.className = 'product';
    div.textContent = `${p.name} — $${p.price ?? '0'} (stock: ${p.stock_quantity ?? 'n/a'})`;
    div.onclick = () => addToCart(p);
    list.appendChild(div);
  }
}

function addToCart(p) {
  const existing = cart.find((i) => i.product_id === p.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ product_id: p.id, name: p.name, price: p.price || 0, quantity: 1 });
  }
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cartItems');
  container.innerHTML = '';
  let total = 0;
  for (const item of cart) {
    total += item.price * item.quantity;
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.textContent = `${item.quantity}x ${item.name} — $${(item.price * item.quantity).toFixed(2)}`;
    container.appendChild(row);
  }
  document.getElementById('total').textContent = `Total: $${total.toFixed(2)}`;
}

document.getElementById('search').addEventListener('input', (e) => loadProducts(e.target.value));

document.getElementById('btnSync').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'Sincronizando...';
  try {
    const result = await window.pos.syncCatalogNow();
    status.textContent = `Catálogo actualizado (${result.count} productos).`;
  } catch (err) {
    status.textContent = `Error de sync (¿sin conexión?): ${err.message}`;
  }
  loadProducts();
});

document.getElementById('btnCheckout').addEventListener('click', async () => {
  if (cart.length === 0) return;
  const status = document.getElementById('status');
  try {
    const result = await window.pos.checkout(cart, 'cash');
    status.textContent = result.printed
      ? `Venta ${result.localTicket} registrada e impresa.`
      : `Venta ${result.localTicket} registrada, pero falló la impresión: ${result.printError}`;
    cart = [];
    renderCart();
  } catch (err) {
    status.textContent = `Error al cobrar: ${err.message}`;
  }
});

window.pos.onQueueUpdated((data) => {
  const status = document.getElementById('status');
  status.textContent = `Sync de cola: ${data.synced} enviadas, ${data.failed} con error.`;
  loadErrors();
});

async function loadErrors() {
  const errors = await window.pos.getQueueErrors();
  const list = document.getElementById('errorList');
  list.innerHTML = '';

  if (errors.length === 0) {
    list.innerHTML = '<p style="color:#666; font-size:0.85em;">Sin errores pendientes.</p>';
    return;
  }

  for (const order of errors) {
    const div = document.createElement('div');
    div.className = 'error-order';

    const itemsText = order.display_items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
    div.innerHTML = `
      <strong>${order.local_ticket}</strong> — $${order.total?.toFixed(2) ?? '?'}<br>
      ${itemsText}
      <div class="msg">${order.error_message}</div>
    `;

    const btnRetry = document.createElement('button');
    btnRetry.textContent = 'Reintentar';
    btnRetry.onclick = async () => {
      btnRetry.disabled = true;
      btnRetry.textContent = 'Reintentando...';
      try {
        await window.pos.retryOrder(order.id);
      } catch (err) {
        alert(`No se pudo reintentar: ${err.message}`);
      }
      loadErrors();
    };

    const btnResolve = document.createElement('button');
    btnResolve.textContent = 'Marcar resuelto manual';
    btnResolve.onclick = async () => {
      const note = prompt('¿Cómo se resolvió? (opcional, queda en el registro)') || '';
      try {
        await window.pos.resolveManually(order.id, note);
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
      loadErrors();
    };

    div.appendChild(btnRetry);
    div.appendChild(btnResolve);
    list.appendChild(div);
  }
}

// Revisa errores al abrir y cada 15s (además de cuando el auto-sync reporta cambios).
loadErrors();
setInterval(loadErrors, 15000);

loadProducts();
