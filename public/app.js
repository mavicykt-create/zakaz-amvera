const state = {
  categories: [],
  products: [],
  cart: {},
  loading: false,
  sending: false,
  selectedCategory: 'all'
};

const STORAGE_KEYS = {
  catalog: 'mobile_order_catalog_v1',
  cart: 'mobile_order_cart_v1',
  pendingOrders: 'mobile_order_pending_orders_v1'
};

const els = {
  status: document.getElementById('status'),
  catalogRoot: document.getElementById('catalog-root'),
  basketSum: document.getElementById('basket-sum'),
  refreshBtn: document.getElementById('refresh-btn'),

  categoryMenuBtn: document.getElementById('category-menu-btn'),
  categoryModal: document.getElementById('category-modal'),
  categoryBackdrop: document.getElementById('category-backdrop'),
  categoryCloseBtn: document.getElementById('category-close-btn'),
  categoryMenuList: document.getElementById('category-menu-list'),

  basketModal: document.getElementById('basket-modal'),
  basketBackdrop: document.getElementById('basket-backdrop'),
  basketOpenBtn: document.getElementById('basket-open-btn'),
  basketCloseBtn: document.getElementById('basket-close-btn'),
  basketList: document.getElementById('basket-list'),
  basketEmpty: document.getElementById('basket-empty'),
  basketSubtitle: document.getElementById('basket-subtitle'),
  basketTotalSum: document.getElementById('basket-total-sum'),
  clearCartBtn: document.getElementById('clear-cart-btn'),

  phoneInput: document.getElementById('phone-input'),
  commentInput: document.getElementById('comment-input'),
  sendBtn: document.getElementById('send-order-btn'),
  success: document.getElementById('success-message')
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(value) {
  const num = Math.round(Number(value) || 0);
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(num)} ₽`;
}

function formatLoadedAt(value) {
  if (!value) return 'Дата обновления неизвестна';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Дата обновления неизвестна';

  return `Актуально на ${date.toLocaleDateString('ru-RU')} ${date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  })}`;
}

function setStatus(text, isError = false) {
  els.status.textContent = text || '';
  els.status.classList.toggle('status--error', !!isError);
}

function buildImageUrl(url) {
  if (!url) return '';
  return `/img?url=${encodeURIComponent(url)}`;
}

function getProductById(id) {
  return state.products.find((p) => p.id === id);
}

function getTotalItems() {
  return Object.values(state.cart).reduce((sum, qty) => sum + qty, 0);
}

function getTotalSum() {
  return Object.entries(state.cart).reduce((sum, [id, qty]) => {
    const product = getProductById(id);
    if (!product) return sum;
    return sum + (Number(product.cartPrice) || 0) * qty;
  }, 0);
}

function saveCart() {
  localStorage.setItem(STORAGE_KEYS.cart, JSON.stringify(state.cart));
}

function loadCart() {
  try {
    state.cart = JSON.parse(localStorage.getItem(STORAGE_KEYS.cart) || '{}');
  } catch {
    state.cart = {};
  }
}

function saveCatalog(data) {
  localStorage.setItem(STORAGE_KEYS.catalog, JSON.stringify(data));
}

function loadCatalogFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.catalog) || 'null');
  } catch {
    return null;
  }
}

function getPendingOrders() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.pendingOrders) || '[]');
  } catch {
    return [];
  }
}

function setPendingOrders(list) {
  localStorage.setItem(STORAGE_KEYS.pendingOrders, JSON.stringify(list));
}

function addPendingOrder(order) {
  const list = getPendingOrders();
  list.push(order);
  setPendingOrders(list);
}

async function flushPendingOrders() {
  const list = getPendingOrders();
  if (!list.length) return;

  const remaining = [];

  for (const order of list) {
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order)
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        remaining.push(order);
      }
    } catch {
      remaining.push(order);
    }
  }

  setPendingOrders(remaining);
}

function showSuccess(text) {
  els.success.textContent = text;
  els.success.classList.add('is-visible');
  window.setTimeout(() => {
    els.success.classList.remove('is-visible');
  }, 2400);
}

function sortRuByName(items) {
  return [...items].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'ru', {
      sensitivity: 'base',
      numeric: true
    })
  );
}

function renderCategoryMenu() {
  const items = [
    `<button class="menu-item ${state.selectedCategory === 'all' ? 'is-active' : ''}" data-category="all" type="button">Все товары</button>`,
    ...state.categories.map((category) => `
      <button
        class="menu-item ${state.selectedCategory === category.id ? 'is-active' : ''}"
        data-category="${escapeHtml(category.id)}"
        type="button"
      >
        ${escapeHtml(category.name)}
      </button>
    `)
  ];

  els.categoryMenuList.innerHTML = items.join('');
}

function getGroupedProducts() {
  const byCategory = new Map();

  for (const category of state.categories) {
    byCategory.set(category.id, []);
  }

  for (const product of state.products) {
    if (!byCategory.has(product.categoryId)) {
      byCategory.set(product.categoryId, []);
    }
    byCategory.get(product.categoryId).push(product);
  }

  if (state.selectedCategory !== 'all') {
    const category = state.categories.find((c) => c.id === state.selectedCategory);
    return category
      ? [{
          id: category.id,
          name: category.name,
          products: sortRuByName(byCategory.get(category.id) || [])
        }]
      : [];
  }

  return state.categories
    .map((category) => ({
      id: category.id,
      name: category.name,
      products: sortRuByName(byCategory.get(category.id) || [])
    }))
    .filter((group) => group.products.length > 0);
}

function renderCatalog() {
  const groups = getGroupedProducts();

  if (!groups.length) {
    els.catalogRoot.innerHTML = '<div class="empty-state">Нет товаров</div>';
    return;
  }

  els.catalogRoot.innerHTML = groups.map((group) => `
    <section class="category-block" id="category-${escapeHtml(group.id)}">
      <h2 class="category-title">${escapeHtml(group.name)}</h2>
      <div class="grid">
        ${group.products.map((product) => {
          const qty = state.cart[product.id] || 0;
          return `
            <button class="product-card" data-id="${escapeHtml(product.id)}" type="button">
              <div class="product-card__image-wrap">
                ${
                  product.image
                    ? `<img class="product-card__image" src="${buildImageUrl(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy">`
                    : `<div class="product-card__image product-card__image--placeholder">Нет фото</div>`
                }
                <div class="product-card__qty ${qty > 0 ? 'is-visible' : ''}">${qty > 0 ? qty : ''}</div>
              </div>

              <div class="product-card__body">
                <div class="product-card__name">${escapeHtml(product.name)}</div>
                <div class="product-card__price">${product.displayPrice ? escapeHtml(formatPrice(product.displayPrice)) : ''}</div>
                <div class="product-card__shelf">${escapeHtml(product.shelfLife || '')}</div>
              </div>
            </button>
          `;
        }).join('')}
      </div>
    </section>
  `).join('');
}

function updateAllBadges() {
  document.querySelectorAll('.product-card').forEach((card) => {
    const id = card.dataset.id;
    const qty = state.cart[id] || 0;
    const qtyEl = card.querySelector('.product-card__qty');
    if (!qtyEl) return;
    qtyEl.textContent = qty > 0 ? String(qty) : '';
    qtyEl.classList.toggle('is-visible', qty > 0);
  });
}

function updateTopbar() {
  els.basketSum.textContent = formatPrice(getTotalSum());
}

function renderBasket() {
  const items = Object.entries(state.cart)
    .map(([id, quantity]) => {
      const product = getProductById(id);
      if (!product || quantity <= 0) return null;
      return { product, quantity };
    })
    .filter(Boolean);

  els.basketSubtitle.textContent = `${getTotalItems()} товаров`;
  els.basketTotalSum.textContent = formatPrice(getTotalSum());
  els.sendBtn.disabled = items.length === 0 || state.sending;
  els.clearCartBtn.disabled = items.length === 0 || state.sending;

  if (!items.length) {
    els.basketList.innerHTML = '';
    els.basketEmpty.style.display = 'block';
    return;
  }

  els.basketEmpty.style.display = 'none';
  els.basketList.innerHTML = items.map(({ product, quantity }) => {
    const sum = (Number(product.cartPrice) || 0) * quantity;

    return `
      <div class="basket-item" data-id="${escapeHtml(product.id)}">
        <div class="basket-item__thumb-wrap">
          ${
            product.image
              ? `<img class="basket-item__thumb" src="${buildImageUrl(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy">`
              : `<div class="basket-item__thumb basket-item__thumb--empty"></div>`
          }
        </div>

        <div class="basket-item__info">
          <div class="basket-item__name">${escapeHtml(product.name)}</div>
          <div class="basket-item__meta">
            <span>${escapeHtml(formatPrice(product.cartPrice || 0))}</span>
            <span>·</span>
            <span>${escapeHtml(formatPrice(sum))}</span>
          </div>
        </div>

        <div class="basket-item__controls">
          <button class="qty-btn qty-btn--minus" type="button" data-action="minus" data-id="${escapeHtml(product.id)}">−</button>
          <div class="basket-item__qty">${quantity}</div>
          <button class="qty-btn qty-btn--plus" type="button" data-action="plus" data-id="${escapeHtml(product.id)}">+</button>
        </div>
      </div>
    `;
  }).join('');
}

function openBasket() {
  renderBasket();
  els.basketModal.classList.add('is-open');
  els.basketModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('body-lock');
}

function closeBasket() {
  els.basketModal.classList.remove('is-open');
  els.basketModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('body-lock');
}

function openCategoryMenu() {
  renderCategoryMenu();
  els.categoryModal.classList.add('is-open');
  els.categoryModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('body-lock');
}

function closeCategoryMenu() {
  els.categoryModal.classList.remove('is-open');
  els.categoryModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('body-lock');
}

function addToCart(productId) {
  state.cart[productId] = (state.cart[productId] || 0) + 1;
  saveCart();
  updateAllBadges();
  updateTopbar();
}

function changeCartQty(productId, delta) {
  const current = state.cart[productId] || 0;
  const next = current + delta;

  if (next <= 0) {
    delete state.cart[productId];
  } else {
    state.cart[productId] = next;
  }

  saveCart();
  updateAllBadges();
  updateTopbar();
  renderBasket();
}

function clearCart() {
  state.cart = {};
  saveCart();
  updateAllBadges();
  updateTopbar();
  renderBasket();
}

async function loadProducts() {
  state.loading = true;
  setStatus('Загружаем каталог...');
  els.refreshBtn.disabled = true;

  try {
    const res = await fetch('/api/products', { cache: 'no-store' });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Не удалось загрузить товары');
    }

    state.products = Array.isArray(data.products) ? data.products : [];
    state.categories = Array.isArray(data.categories) ? data.categories : [];

    saveCatalog({
      products: state.products,
      categories: state.categories,
      loadedAt: data.loadedAt || null
    });

    renderCatalog();
    renderCategoryMenu();
    updateTopbar();
    setStatus(formatLoadedAt(data.loadedAt));
  } catch (error) {
    const cached = loadCatalogFromStorage();

    if (cached?.products?.length) {
      state.products = cached.products;
      state.categories = cached.categories || [];
      renderCatalog();
      renderCategoryMenu();
      updateTopbar();
      setStatus(`Работаем из сохраненного каталога. ${formatLoadedAt(cached.loadedAt)}`);
    } else {
      setStatus(error.message || 'Ошибка загрузки каталога', true);
    }
  } finally {
    state.loading = false;
    els.refreshBtn.disabled = false;
  }
}

async function refreshProducts() {
  setStatus('Обновляем товары...');
  els.refreshBtn.disabled = true;

  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Не удалось обновить каталог');
    }

    state.products = Array.isArray(data.products) ? data.products : [];
    state.categories = Array.isArray(data.categories) ? data.categories : [];

    saveCatalog({
      products: state.products,
      categories: state.categories,
      loadedAt: data.loadedAt || new Date().toISOString()
    });

    renderCatalog();
    renderCategoryMenu();
    updateTopbar();
    setStatus(formatLoadedAt(data.loadedAt || new Date().toISOString()));
  } catch (error) {
    setStatus(error.message || 'Ошибка обновления каталога', true);
  } finally {
    els.refreshBtn.disabled = false;
  }
}

async function sendOrder() {
  const orderPayload = {
    items: Object.entries(state.cart).map(([id, quantity]) => {
      const product = getProductById(id);
      if (!product) return null;

      return {
        id: product.id,
        vendorCode: product.vendorCode,
        name: product.name,
        quantity,
        cartPrice: product.cartPrice,
        displayPrice: product.displayPrice
      };
    }).filter(Boolean),
    phone: els.phoneInput.value.trim(),
    comment: els.commentInput.value.trim()
  };

  if (!orderPayload.items.length) {
    setStatus('Корзина пустая', true);
    return;
  }

  state.sending = true;
  renderBasket();
  els.sendBtn.textContent = 'Отправляем...';
  setStatus('Отправляем заказ...');

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayload)
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Не удалось отправить заказ');
    }

    clearCart();
    els.phoneInput.value = '';
    els.commentInput.value = '';
    closeBasket();
    setStatus(`Заказ отправлен: ${data.orderId}`);
    showSuccess('Заказ отправлен');
  } catch {
    addPendingOrder(orderPayload);
    clearCart();
    els.phoneInput.value = '';
    els.commentInput.value = '';
    closeBasket();
    setStatus('Нет сети. Заказ сохранен и отправится позже.');
    showSuccess('Заказ сохранен локально');
  } finally {
    state.sending = false;
    els.sendBtn.textContent = 'Отправить заказ';
    renderBasket();
  }
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {}
}

els.catalogRoot.addEventListener('click', (event) => {
  const card = event.target.closest('.product-card');
  if (!card) return;
  const id = card.dataset.id;
  if (!id) return;
  addToCart(id);
});

els.refreshBtn.addEventListener('click', refreshProducts);

els.categoryMenuBtn.addEventListener('click', openCategoryMenu);
els.categoryCloseBtn.addEventListener('click', closeCategoryMenu);
els.categoryBackdrop.addEventListener('click', closeCategoryMenu);

els.categoryMenuList.addEventListener('click', (event) => {
  const btn = event.target.closest('.menu-item');
  if (!btn) return;

  state.selectedCategory = btn.dataset.category || 'all';
  renderCatalog();
  renderCategoryMenu();
  closeCategoryMenu();
});

els.basketOpenBtn.addEventListener('click', openBasket);
els.basketCloseBtn.addEventListener('click', closeBasket);
els.basketBackdrop.addEventListener('click', closeBasket);
els.sendBtn.addEventListener('click', sendOrder);
els.clearCartBtn.addEventListener('click', clearCart);

els.basketList.addEventListener('click', (event) => {
  const btn = event.target.closest('.qty-btn');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (!id) return;

  if (action === 'minus') changeCartQty(id, -1);
  if (action === 'plus') changeCartQty(id, 1);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeBasket();
    closeCategoryMenu();
  }
});

window.addEventListener('online', () => {
  flushPendingOrders();
  setStatus('Сеть восстановлена');
});

window.addEventListener('offline', () => {
  setStatus('Нет сети. Работаем с сохраненными данными.');
});

loadCart();
updateTopbar();
registerSW();
loadProducts();
flushPendingOrders();
