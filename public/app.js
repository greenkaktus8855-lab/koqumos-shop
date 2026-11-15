'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { products: [], cart: readCart(), category: 'all', adminProducts: [], orders: [], currentAdminTab: 'products' };
const money = (minor) => new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH', maximumFractionDigits: 2 }).format((Number(minor) || 0) / 100);
const productPrice = (product) => Math.round(Number(product.price_minor) * (100 - Number(product.discount_percent || 0)) / 100);

function readCart() {
  try {
    const value = JSON.parse(localStorage.getItem('koqumo-cart') || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}
function writeCart() { localStorage.setItem('koqumo-cart', JSON.stringify(state.cart)); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function imageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; }
  catch { return ''; }
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  let data = {};
  try { data = await response.json(); } catch { /* empty response */ }
  if (!response.ok) throw new Error(data.error || `Помилка ${response.status}`);
  return data;
}
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2900);
}
function showOverlay(id) { $(`#${id}`).hidden = false; document.body.style.overflow = 'hidden'; }
function hideOverlay(id) {
  $(`#${id}`).hidden = true;
  if ($$('.overlay:not([hidden])').length === 0) document.body.style.overflow = '';
}
function cartProducts() {
  return Object.entries(state.cart).map(([id, qty]) => {
    const product = state.products.find((item) => String(item.id) === String(id));
    return product ? { ...product, qty: Math.max(1, Number(qty) || 1) } : null;
  }).filter(Boolean);
}
function cartTotal() { return cartProducts().reduce((total, item) => total + productPrice(item) * item.qty, 0); }
function renderCartCount() { $('#cartCount').textContent = Object.values(state.cart).reduce((total, qty) => total + Number(qty || 0), 0); }

function renderCategories() {
  const categories = [...new Set(state.products.map((product) => product.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  const row = $('#categoryRow');
  row.innerHTML = `<button class="category-chip ${state.category === 'all' ? 'active' : ''}" data-category="all">Усі товари</button><button class="category-chip ${state.category === 'sale' ? 'active' : ''}" data-category="sale">Зі знижкою</button>` + categories.map((category) => `<button class="category-chip ${state.category === category ? 'active' : ''}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('');
  $$('.category-chip', row).forEach((button) => button.addEventListener('click', () => { state.category = button.dataset.category; renderCategories(); renderProducts(); }));
}
function renderProducts() {
  const query = $('#searchInput').value.trim().toLocaleLowerCase('uk');
  let products = state.products.filter((product) => {
    const matchCategory = state.category === 'all' || (state.category === 'sale' ? Number(product.discount_percent) > 0 : product.category === state.category);
    const text = `${product.name} ${product.description || ''} ${product.category || ''}`.toLocaleLowerCase('uk');
    return matchCategory && text.includes(query);
  });
  const sort = $('#sortSelect').value;
  if (sort === 'cheap') products.sort((a, b) => productPrice(a) - productPrice(b));
  if (sort === 'expensive') products.sort((a, b) => productPrice(b) - productPrice(a));
  if (sort === 'sale') products.sort((a, b) => Number(b.discount_percent) - Number(a.discount_percent));
  if (sort === 'popular') products.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  $('#productTotal').textContent = products.length;
  const grid = $('#productGrid');
  if (!products.length) {
    grid.innerHTML = state.products.length ? '<div class="empty-state"><strong>Нічого не знайшлося</strong>Спробуй інший запит або категорію.</div>' : '<div class="empty-state"><strong>Каталог скоро наповниться</strong>Перші товари з’являться тут. Власник магазину може додати їх через панель ⚙.</div>';
    return;
  }
  grid.innerHTML = products.map((product) => {
    const price = productPrice(product);
    const img = imageUrl(product.image_url) || '';
    const category = escapeHtml(product.category || 'KOQUMO');
    return `<article class="product-card" data-id="${product.id}"><div class="product-image-wrap">${img ? `<img class="product-image" src="${escapeHtml(img)}" alt="${escapeHtml(product.name)}" loading="lazy">` : '<img class="product-image" src="/placeholder.svg" alt="Koqumo" loading="lazy">'}${Number(product.discount_percent) > 0 ? `<span class="sale-badge">−${Number(product.discount_percent)}%</span>` : ''}<button class="quick-add" data-add="${product.id}" aria-label="Додати ${escapeHtml(product.name)} до кошика">＋</button></div><div class="product-info"><div class="product-meta"><span>${category}</span><span class="stock-label">${Number(product.stock) > 0 ? 'Є в наявності' : 'Немає'}</span></div><h3 class="product-name">${escapeHtml(product.name)}</h3><div class="price-row"><strong class="product-price">${money(price)}</strong>${Number(product.discount_percent) > 0 ? `<del class="old-price">${money(product.price_minor)}</del>` : ''}</div></div></article>`;
  }).join('');
  $$('[data-add]', grid).forEach((button) => button.addEventListener('click', () => addToCart(button.dataset.add)));
}
function addToCart(id) {
  const product = state.products.find((item) => String(item.id) === String(id));
  if (!product || Number(product.stock) < 1) return toast('Цього товару зараз немає в наявності.');
  const current = Number(state.cart[id] || 0);
  if (current >= Number(product.stock)) return toast('Більше товару немає на складі.');
  state.cart[id] = current + 1;
  writeCart(); renderCart(); toast('Додано до кошика.');
}
function changeQty(id, delta) {
  const product = state.products.find((item) => String(item.id) === String(id));
  const next = Number(state.cart[id] || 0) + delta;
  if (next <= 0) delete state.cart[id];
  else state.cart[id] = Math.min(next, Number(product?.stock || next));
  writeCart(); renderCart();
}
function renderCart() {
  const items = cartProducts();
  renderCartCount();
  $('#cartTotal').textContent = money(cartTotal());
  $('#checkoutTotal').textContent = money(cartTotal());
  const target = $('#cartItems');
  if (!items.length) { target.innerHTML = '<div class="empty-state"><strong>Кошик поки порожній</strong>Додай щось цікаве з каталогу.</div>'; $('#checkoutOpen').disabled = true; return; }
  $('#checkoutOpen').disabled = false;
  target.innerHTML = items.map((item) => `<div class="cart-line"><img src="${escapeHtml(imageUrl(item.image_url) || '/placeholder.svg')}" alt=""><div><h4>${escapeHtml(item.name)}</h4><small>${money(productPrice(item))}</small><div class="qty-controls"><button data-qty="${item.id}" data-delta="-1" aria-label="Зменшити">−</button><span>${item.qty}</span><button data-qty="${item.id}" data-delta="1" aria-label="Збільшити">＋</button></div></div><strong class="line-price">${money(productPrice(item) * item.qty)}</strong></div>`).join('');
  $$('[data-qty]', target).forEach((button) => button.addEventListener('click', () => changeQty(button.dataset.qty, Number(button.dataset.delta))));
}

async function loadProducts() {
  try {
    const data = await api('/api/products');
    state.products = Array.isArray(data.products) ? data.products : [];
    renderCategories(); renderProducts(); renderCart();
  } catch (error) {
    $('#productGrid').innerHTML = `<div class="empty-state"><strong>Не вдалося завантажити каталог</strong>${escapeHtml(error.message)}. Перевір, чи налаштована база Cloudflare D1.</div>`;
  }
}

let citySearchTimer;
let warehouseSearchTimer;
function bindSuggestions(input, target, search, onPick, minLength = 2) {
  input.addEventListener('input', () => {
    clearTimeout(input === $('#cityInput') ? citySearchTimer : warehouseSearchTimer);
    if (input === $('#cityInput')) { $('#cityRef').value = ''; $('#warehouseInput').value = ''; $('#warehouseRef').value = ''; $('#warehouseInput').disabled = true; $('#warehouseSuggestions').innerHTML = ''; }
    else $('#warehouseRef').value = '';
    const term = input.value.trim();
    target.innerHTML = '';
    if (term.length < minLength) return;
    const timer = setTimeout(async () => {
      try {
        const values = await search(term);
        if (!values.length) { target.innerHTML = '<div class="suggestion-list"><div class="suggestion-item">Нічого не знайдено</div></div>'; return; }
        target.innerHTML = `<div class="suggestion-list">${values.map((value, index) => `<button type="button" class="suggestion-item" data-pick="${index}">${escapeHtml(value.label)}</button>`).join('')}</div>`;
        $$('[data-pick]', target).forEach((button) => button.addEventListener('click', () => { onPick(values[Number(button.dataset.pick)]); target.innerHTML = ''; }));
      } catch (error) { toast(error.message); }
    }, 280);
    if (input === $('#cityInput')) citySearchTimer = timer; else warehouseSearchTimer = timer;
  });
}
function setupCheckoutLookups() {
  bindSuggestions($('#cityInput'), $('#citySuggestions'), async (term) => {
    const data = await api(`/api/np/cities?q=${encodeURIComponent(term)}`);
    return (data.cities || []).map((city) => ({ ref: city.ref, label: [city.name, city.area].filter(Boolean).join(', ') }));
  }, (city) => {
    $('#cityInput').value = city.label;
    $('#cityRef').value = city.ref;
    $('#warehouseInput').disabled = false;
    $('#warehouseInput').placeholder = 'Наприклад, Відділення №1';
    $('#warehouseInput').focus();
  });
  bindSuggestions($('#warehouseInput'), $('#warehouseSuggestions'), async (term) => {
    const ref = $('#cityRef').value;
    if (!ref) throw new Error('Спочатку обери місто.');
    const data = await api(`/api/np/warehouses?cityRef=${encodeURIComponent(ref)}&q=${encodeURIComponent(term)}`);
    return (data.warehouses || []).map((warehouse) => ({ ref: warehouse.ref, label: warehouse.name }));
  }, (warehouse) => {
    $('#warehouseInput').value = warehouse.label;
    $('#warehouseRef').value = warehouse.ref;
  }, 1);
}

$('#checkoutForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!Object.keys(state.cart).length) return toast('Кошик порожній.');
  if (!$('#cityRef').value || !$('#warehouseRef').value) return toast('Обери місто та відділення зі списку Нової пошти.');
  const form = new FormData(event.currentTarget);
  const payload = {
    customerName: String(form.get('customerName') || '').trim(),
    phone: String(form.get('phone') || '').trim(),
    cityRef: $('#cityRef').value,
    cityName: $('#cityInput').value,
    warehouseRef: $('#warehouseRef').value,
    warehouseName: $('#warehouseInput').value,
    paymentMethod: form.get('paymentMethod'),
    items: Object.entries(state.cart).map(([id, qty]) => ({ productId: Number(id), quantity: Number(qty) }))
  };
  const button = $('#placeOrderButton');
  button.disabled = true; button.textContent = 'Відправляємо…';
  try {
    const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
    state.cart = {}; writeCart(); renderCart(); event.currentTarget.reset();
    $('#cityRef').value = ''; $('#warehouseRef').value = ''; $('#warehouseInput').disabled = true;
    await loadProducts();
    hideOverlay('checkoutOverlay'); hideOverlay('cartOverlay');
    toast(`Замовлення №${result.orderNumber} прийнято. Дякуємо!`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.innerHTML = 'Підтвердити замовлення <span>→</span>'; }
});

function setAdminTab(tab) {
  state.currentAdminTab = tab;
  $$('.admin-tab').forEach((button) => button.classList.toggle('active', button.dataset.adminTab === tab));
  $('#adminProductsPane').hidden = tab !== 'products';
  $('#adminOrdersPane').hidden = tab !== 'orders';
  $('#adminShippingPane').hidden = tab !== 'shipping';
  if (tab === 'orders') loadAdminOrders();
  if (tab === 'shipping') loadShippingSettings();
}
async function openAdmin() {
  showOverlay('adminOverlay');
  try {
    await api('/api/admin/me');
    $('#adminLogin').hidden = true; $('#adminApp').hidden = false;
    setAdminTab(state.currentAdminTab);
    loadAdminProducts();
  } catch {
    $('#adminLogin').hidden = false; $('#adminApp').hidden = true;
    $('#loginMessage').textContent = '';
  }
}
$('#adminOpen').addEventListener('click', openAdmin);
$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  const password = new FormData(event.currentTarget).get('password');
  button.disabled = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    $('#adminLogin').hidden = true; $('#adminApp').hidden = false; event.currentTarget.reset();
    await loadAdminProducts(); toast('Вхід виконано.');
  } catch (error) { $('#loginMessage').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#adminLogout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch { /* close panel anyway */ }
  $('#adminApp').hidden = true; $('#adminLogin').hidden = false; hideOverlay('adminOverlay'); toast('Ти вийшов з панелі.');
});
$$('.admin-tab').forEach((button) => button.addEventListener('click', () => setAdminTab(button.dataset.adminTab)));

async function loadAdminProducts() {
  try {
    const data = await api('/api/admin/products');
    state.adminProducts = data.products || [];
    const target = $('#adminProductList');
    if (!state.adminProducts.length) { target.innerHTML = '<p class="empty-admin">Товарів ще немає. Натисни «Новий товар», щоб додати перший.</p>'; return; }
    target.innerHTML = state.adminProducts.map((product) => `<div class="admin-row"><img src="${escapeHtml(imageUrl(product.image_url) || '/placeholder.svg')}" alt=""><div><h4>${escapeHtml(product.name)} ${product.active ? '' : '· приховано'}</h4><p>${money(productPrice(product))}${Number(product.discount_percent) ? ` · знижка ${Number(product.discount_percent)}%` : ''} · залишок: ${Number(product.stock)}</p></div><div class="admin-row-actions"><button data-edit-product="${product.id}">Редагувати</button><button class="danger" data-delete-product="${product.id}">Видалити</button></div></div>`).join('');
    $$('[data-edit-product]', target).forEach((button) => button.addEventListener('click', () => editProduct(button.dataset.editProduct)));
    $$('[data-delete-product]', target).forEach((button) => button.addEventListener('click', () => deleteProduct(button.dataset.deleteProduct)));
  } catch (error) { toast(error.message); }
}
function resetProductForm() { $('#productForm').reset(); $('input[name="id"]', $('#productForm')).value = ''; $('input[name="discountPercent"]', $('#productForm')).value = 0; $('input[name="stock"]', $('#productForm')).value = 1; $('#productForm').hidden = true; }
$('#newProductButton').addEventListener('click', () => { resetProductForm(); $('#productForm').hidden = false; $('#productForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
$('#cancelProductEdit').addEventListener('click', resetProductForm);
function editProduct(id) {
  const product = state.adminProducts.find((item) => String(item.id) === String(id));
  if (!product) return;
  const form = $('#productForm');
  form.hidden = false;
  for (const [name, value] of Object.entries({ id: product.id, name: product.name, category: product.category || '', description: product.description || '', imageUrl: product.image_url || '', price: Number(product.price_minor) / 100, discountPercent: product.discount_percent, stock: product.stock })) {
    const input = $(`[name="${name}"]`, form); if (input) input.value = value;
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#productForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = String(form.get('id') || '');
  const payload = { name: String(form.get('name') || '').trim(), category: String(form.get('category') || '').trim(), description: String(form.get('description') || '').trim(), imageUrl: String(form.get('imageUrl') || '').trim(), price: Number(form.get('price')), discountPercent: Number(form.get('discountPercent') || 0), stock: Number(form.get('stock') || 0) };
  try {
    await api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    resetProductForm(); await loadAdminProducts(); await loadProducts(); toast('Товар збережено.');
  } catch (error) { $('#productMessage').textContent = error.message; }
});
async function deleteProduct(id) {
  if (!confirm('Видалити цей товар із каталогу?')) return;
  try { await api(`/api/admin/products/${id}`, { method: 'DELETE' }); await loadAdminProducts(); await loadProducts(); toast('Товар видалено.'); }
  catch (error) { toast(error.message); }
}

async function loadAdminOrders() {
  const target = $('#adminOrderList');
  target.innerHTML = '<p class="empty-admin">Завантажуємо замовлення…</p>';
  try {
    const data = await api('/api/admin/orders');
    state.orders = data.orders || [];
    if (!state.orders.length) { target.innerHTML = '<p class="empty-admin">Ще немає замовлень.</p>'; return; }
    target.innerHTML = state.orders.map((order) => {
      const items = (order.items || []).map((item) => `${escapeHtml(item.name)} × ${Number(item.quantity)}`).join(', ');
      return `<div class="admin-row order-row"><div class="order-details"><b>№${escapeHtml(order.order_number)}</b> · ${escapeHtml(order.customer_name)} · ${escapeHtml(order.phone)}<br>${escapeHtml(order.city_name)}, ${escapeHtml(order.warehouse_name)}<br>${items}<br><b>${money(order.total_minor)}</b> · ${escapeHtml(order.created_at)}${order.ttn ? `<br>ТТН: <b>${escapeHtml(order.ttn)}</b>` : ''}</div><div class="order-controls"><select data-status="${order.id}" aria-label="Статус замовлення"><option value="new" ${order.status === 'new' ? 'selected' : ''}>Нове</option><option value="confirmed" ${order.status === 'confirmed' ? 'selected' : ''}>Підтверджено</option><option value="sent" ${order.status === 'sent' ? 'selected' : ''}>Відправлено</option><option value="completed" ${order.status === 'completed' ? 'selected' : ''}>Виконано</option><option value="cancelled" ${order.status === 'cancelled' ? 'selected' : ''}>Скасовано</option></select><button data-waybill="${order.id}" ${order.ttn ? 'disabled' : ''}>${order.ttn ? 'ТТН створено' : 'Створити ТТН'}</button></div></div>`;
    }).join('');
    $$('[data-status]', target).forEach((select) => select.addEventListener('change', async () => {
      try { await api(`/api/admin/orders/${select.dataset.status}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); toast('Статус оновлено.'); }
      catch (error) { toast(error.message); }
    }));
    $$('[data-waybill]', target).forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('Створити справжню експрес-накладну Нової пошти для цього замовлення?')) return;
      button.disabled = true; button.textContent = 'Створюємо…';
      try { const result = await api(`/api/admin/orders/${button.dataset.waybill}/waybill`, { method: 'POST', body: '{}' }); toast(`ТТН створено: ${result.ttn}`); await loadAdminOrders(); }
      catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Створити ТТН'; }
    }));
  } catch (error) { target.innerHTML = `<p class="empty-admin">${escapeHtml(error.message)}</p>`; }
}
$('#refreshOrders').addEventListener('click', loadAdminOrders);
async function loadShippingSettings() {
  try {
    const data = await api('/api/admin/shipping-settings');
    const form = $('#shippingForm');
    const values = data.settings || {};
    for (const key of ['citySender', 'sender', 'senderAddress', 'contactSender', 'sendersPhone', 'weight']) {
      const field = $(`[name="${key}"]`, form); if (field && values[key] !== undefined) field.value = values[key];
    }
  } catch (error) { $('#shippingMessage').textContent = error.message; }
}
$('#shippingForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  try { await api('/api/admin/shipping-settings', { method: 'PUT', body: JSON.stringify(values) }); $('#shippingMessage').textContent = 'Дані відправника збережено.'; }
  catch (error) { $('#shippingMessage').textContent = error.message; }
});

$('#cartOpen').addEventListener('click', () => { renderCart(); showOverlay('cartOverlay'); });
$('#checkoutOpen').addEventListener('click', () => {
  if (!cartProducts().length) return;
  hideOverlay('cartOverlay'); $('#checkoutTotal').textContent = money(cartTotal()); showOverlay('checkoutOverlay');
});
$$('[data-close]').forEach((button) => button.addEventListener('click', () => hideOverlay(button.dataset.close)));
$$('.overlay').forEach((overlay) => overlay.addEventListener('click', (event) => { if (event.target === overlay) hideOverlay(overlay.id); }));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $$('.overlay:not([hidden])').forEach((overlay) => hideOverlay(overlay.id)); });
$('#searchInput').addEventListener('input', renderProducts);
$('#sortSelect').addEventListener('change', renderProducts);
$('#yearNow').textContent = new Date().getFullYear();
setupCheckoutLookups();
loadProducts();
