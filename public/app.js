const state = {
  products: [],
  cart: new Map(),
  categoryName: ''
};

const gridEl = document.getElementById('grid');
const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');
const categoryNameEl = document.getElementById('categoryName');
const cartCountEl = document.getElementById('cartCount');
const cartSumEl = document.getElementById('cartSum');
const refreshBtn = document.getElementById('refreshBtn');
const submitBtn = document.getElementById('submitBtn');

function money(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value || 0)) + ' ₽';
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function quantityOf(id) {
  return state.cart.get(id)?.quantity || 0;
}

function updateSummary() {
  let totalQty = 0;
  let totalSum = 0;
  for (const item of state.cart.values()) {
    totalQty += item.quantity;
    totalSum += item.quantity * item.price;
  }
  cartCountEl.textContent = totalQty;
  cartSumEl.textContent = money(totalSum);
}

function shelfClass(tone) {
  return tone === 'danger' ? 'badge-danger' : tone === 'warn' ? 'badge-warn' : tone === 'ok' ? 'badge-ok' : 'badge-none';
}

function render() {
  if (!state.products.length) {
    gridEl.innerHTML = '';
    statusEl.textContent = 'Нет товаров';
    return;
  }

  statusEl.textContent = '';

  gridEl.innerHTML = state.products.map((item) => {
    const qty = quantityOf(item.id);
    const image = item.image ? `/img?url=${encodeURIComponent(item.image)}` : '';
    return `
      <article class="card">
        <button class="img-btn" data-add="${item.id}">
          ${image
            ? `<img src="${image}" alt="${item.name}" loading="lazy" decoding="async" />`
            : `<div class="img-placeholder">Нет фото</div>`}
        </button>

        <div class="card-body">
          <div class="name" title="${item.name}">${item.name}</div>
          <div class="article">${item.article || item.id}</div>

          <div class="meta-row">
            <div class="price">${money(item.price)}</div>
            <div class="badge ${shelfClass(item.shelfLifeBadge?.tone)}" title="${item.shelfLifeRaw || 'Срок не указан'}">
              ${item.shelfLifeBadge?.text || '—'}
            </div>
          </div>

          <div class="qty-row">
            <button class="qty-btn" data-minus="${item.id}">−</button>
            <div class="qty">${qty}</div>
            <button class="qty-btn" data-add="${item.id}">+</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function addItem(id) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;

  const current = state.cart.get(id) || {
    id: product.id,
    article: product.article,
    name: product.name,
    price: product.price,
    quantity: 0
  };

  current.quantity += 1;
  state.cart.set(id, current);
  updateSummary();
  render();
}

function minusItem(id) {
  const current = state.cart.get(id);
  if (!current) return;
  current.quantity -= 1;
  if (current.quantity <= 0) state.cart.delete(id);
  else state.cart.set(id, current);
  updateSummary();
  render();
}

gridEl.addEventListener('click', (e) => {
  const addId = e.target.closest('[data-add]')?.dataset.add;
  const minusId = e.target.closest('[data-minus]')?.dataset.minus;

  if (addId) addItem(addId);
  if (minusId) minusItem(minusId);
});

async function loadProducts(silent = false) {
  if (!silent) statusEl.textContent = 'Загрузка каталога…';
  const res = await fetch('/api/products');
  const data = await res.json();

  if (!data.ok && !data.products) {
    statusEl.textContent = data.error || 'Ошибка загрузки';
    return;
  }

  state.products = data.products || [];
  state.categoryName = data.categoryName || '';
  categoryNameEl.textContent = data.categoryName
    ? `${data.categoryName} · ${state.products.length} товаров`
    : `${state.products.length} товаров`;

  if (data.error) {
    statusEl.textContent = `Каталог загружен из кеша. ${data.error}`;
  }

  render();
}

async function refreshCatalog() {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Обновляем…';
  const res = await fetch('/api/refresh', { method: 'POST' });
  const data = await res.json();
  refreshBtn.disabled = false;
  refreshBtn.textContent = 'Актуализировать';

  if (!data.ok) {
    showToast(data.error || 'Не удалось обновить');
  } else {
    showToast('Каталог обновлён');
  }
  await loadProducts(true);
}

async function submitOrder() {
  const items = Array.from(state.cart.values());
  if (!items.length) {
    showToast('Корзина пустая');
    return;
  }

  const customer = prompt('Название клиента / магазина');
  const comment = prompt('Комментарий к заявке', '') || '';

  submitBtn.disabled = true;
  submitBtn.textContent = 'Отправляем…';

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: customer || '', comment, items })
    });
    const data = await res.json();

    if (!data.ok) throw new Error(data.error || 'Ошибка отправки');

    state.cart.clear();
    updateSummary();
    render();
    showToast(`Заявка ${data.orderId} отправлена`);
  } catch (e) {
    showToast(e.message || 'Ошибка');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Отправить заявку';
  }
}

refreshBtn.addEventListener('click', refreshCatalog);
submitBtn.addEventListener('click', submitOrder);

loadProducts();
updateSummary();
