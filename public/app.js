const state = {
  products: [],
  categoryName: '',
  cart: {},
  loading: false,
  sending: false
};

const els = {
  title: document.getElementById('page-title'),
  category: document.getElementById('category-name'),
  status: document.getElementById('status'),
  grid: document.getElementById('product-grid'),
  totalItems: document.getElementById('total-items'),
  sendBtn: document.getElementById('send-order-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  clearBtn: document.getElementById('clear-btn'),
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
  const num = Number(value) || 0;
  if (!num) return '';
  return `${new Intl.NumberFormat('ru-RU').format(num)} ₽`;
}

function getTotalItems() {
  return Object.values(state.cart).reduce((sum, qty) => sum + qty, 0);
}

function updateSummary() {
  const totalItems = getTotalItems();
  els.totalItems.textContent = totalItems;
  els.sendBtn.disabled = totalItems === 0 || state.sending;
  els.clearBtn.disabled = totalItems === 0 || state.sending;
}

function setStatus(text, isError = false) {
  els.status.textContent = text || '';
  els.status.classList.toggle('status--error', !!isError);
}

function buildImageUrl(url) {
  if (!url) return '';
  return `/img?url=${encodeURIComponent(url)}`;
}

function renderProducts() {
  if (!state.products.length) {
    els.grid.innerHTML = '';
    return;
  }

  els.grid.innerHTML = state.products
    .map((product) => {
      const qty = state.cart[product.id] || 0;

      return `
        <button class="product-card" data-id="${escapeHtml(product.id)}" type="button">
          <div class="product-card__image-wrap">
            ${
              product.image
                ? `<img class="product-card__image" src="${buildImageUrl(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy">`
                : `<div class="product-card__image product-card__image--placeholder">Нет фото</div>`
            }
            <div class="product-card__qty ${qty > 0 ? 'is-visible' : ''}">
              ${qty > 0 ? qty : ''}
            </div>
          </div>

          <div class="product-card__body">
            <div class="product-card__name">${escapeHtml(product.name)}</div>
            <div class="product-card__category">${escapeHtml(product.categoryName || state.categoryName || '')}</div>
            <div class="product-card__price">${escapeHtml(formatPrice(product.referencePrice))}</div>
            <div class="product-card__shelf">${escapeHtml(product.shelfLife || '')}</div>
          </div>
        </button>
      `;
    })
    .join('');
}

function showSuccess(text) {
  els.success.textContent = text;
  els.success.classList.add('is-visible');

  window.setTimeout(() => {
    els.success.classList.remove('is-visible');
  }, 2500);
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
    state.categoryName = data.categoryName || '';

    els.category.textContent = state.categoryName || 'Категория';
    setStatus(
      data.error
        ? `Каталог загружен из кеша. ${data.error}`
        : `Товаров: ${state.products.length}`
    );

    renderProducts();
    updateSummary();
  } catch (error) {
    setStatus(error.message || 'Ошибка загрузки каталога', true);
  } finally {
    state.loading = false;
    els.refreshBtn.disabled = false;
  }
}

async function refreshProducts() {
  setStatus('Обновляем каталог...');
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
    state.categoryName = data.categoryName || '';

    els.category.textContent = state.categoryName || 'Категория';
    setStatus(`Каталог обновлён. Товаров: ${state.products.length}`);

    renderProducts();
    updateSummary();
  } catch (error) {
    setStatus(error.message || 'Ошибка обновления каталога', true);
  } finally {
    els.refreshBtn.disabled = false;
  }
}

function addToCart(productId) {
  state.cart[productId] = (state.cart[productId] || 0) + 1;
  renderProducts();
  updateSummary();
}

function clearCart() {
  state.cart = {};
  renderProducts();
  updateSummary();
}

async function sendOrder() {
  const items = state.products
    .filter((product) => (state.cart[product.id] || 0) > 0)
    .map((product) => ({
      id: product.id,
      name: product.name,
      quantity: state.cart[product.id]
    }));

  if (!items.length) {
    setStatus('Нет выбранных товаров', true);
    return;
  }

  state.sending = true;
  updateSummary();
  els.sendBtn.textContent = 'Отправляем...';
  setStatus('Отправляем заявку...');

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Не удалось отправить заявку');
    }

    clearCart();
    setStatus(`Заявка отправлена: ${data.orderId}`);
    showSuccess('Заявка отправлена');
  } catch (error) {
    setStatus(error.message || 'Ошибка отправки заявки', true);
  } finally {
    state.sending = false;
    els.sendBtn.textContent = 'Отправить заявку';
    updateSummary();
  }
}

els.grid.addEventListener('click', (event) => {
  const card = event.target.closest('.product-card');
  if (!card) return;

  const id = card.dataset.id;
  if (!id) return;

  addToCart(id);
});

els.refreshBtn.addEventListener('click', refreshProducts);
els.clearBtn.addEventListener('click', clearCart);
els.sendBtn.addEventListener('click', sendOrder);

loadProducts();
