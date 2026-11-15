const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const NP_URL = 'https://api.novaposhta.ua/v2.0/json/';
const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function fail(message, status = 400) { return json({ error: message }, status); }
function parseCookies(request) {
  return Object.fromEntries((request.headers.get('Cookie') || '').split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter((part) => part.length === 2));
}
function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}
async function issueSession(secret) {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ exp: Date.now() + 12 * 60 * 60 * 1000 })));
  return `${payload}.${await sign(payload, secret)}`;
}
async function isAdmin(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = parseCookies(request).koqumo_admin;
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  const expected = await sign(payload, env.SESSION_SECRET);
  if (signature !== expected) return false;
  try { return JSON.parse(new TextDecoder().decode(fromBase64Url(payload))).exp > Date.now(); }
  catch { return false; }
}
async function bodyJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 100_000) throw new Error('Занадто великий запит.');
  try { return await request.json(); }
  catch { throw new Error('Некоректний JSON-запит.'); }
}
function cleanText(value, max = 300) { return String(value ?? '').trim().slice(0, max); }
function safeImage(value) {
  const url = cleanText(value, 1000);
  if (!url) return '';
  try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.href : ''; }
  catch { return ''; }
}
function cleanPhone(value) { return String(value || '').replace(/[^\d]/g, ''); }
function phoneForNp(value) {
  let digits = cleanPhone(value);
  if (digits.startsWith('0') && digits.length === 10) digits = `38${digits}`;
  if (digits.startsWith('380') && digits.length === 12) return digits;
  if (digits.startsWith('80') && digits.length === 11) return `3${digits}`;
  throw new Error('Перевір номер телефону отримувача. Потрібен український номер +380.');
}
function splitName(fullName) {
  const parts = cleanText(fullName, 100).split(/\s+/).filter(Boolean);
  if (parts.length < 2) throw new Error('Для ТТН вкажи прізвище та ім’я отримувача.');
  return { LastName: parts[0], FirstName: parts[1], MiddleName: parts.slice(2).join(' ') };
}
async function npCall(env, modelName, calledMethod, methodProperties = {}) {
  if (!env.NOVA_POSHTA_API_KEY) throw new Error('Не додано секрет NOVA_POSHTA_API_KEY у Cloudflare.');
  const response = await fetch(NP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: env.NOVA_POSHTA_API_KEY, modelName, calledMethod, methodProperties })
  });
  if (!response.ok) throw new Error(`Нова пошта повернула HTTP ${response.status}.`);
  const data = await response.json();
  if (!data.success) {
    const message = Array.isArray(data.errors) && data.errors.length ? data.errors.join('; ') : 'Нова пошта не прийняла запит.';
    throw new Error(message.slice(0, 500));
  }
  return data;
}
async function requireAdmin(request, env) {
  return await isAdmin(request, env) ? null : fail('Потрібен вхід адміністратора.', 401);
}
async function getSettings(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('shipping').first();
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}
async function saveSettings(db, values) {
  await db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').bind('shipping', JSON.stringify(values)).run();
}
function publicProduct(row) {
  return {
    id: row.id, name: row.name, description: row.description, category: row.category,
    image_url: row.image_url, price_minor: row.price_minor, discount_percent: row.discount_percent,
    stock: row.stock, active: row.active, created_at: row.created_at
  };
}
function publicOrder(row) {
  let items = [];
  try { items = JSON.parse(row.items_json); } catch { /* keep empty */ }
  return {
    id: row.id, order_number: row.order_number, customer_name: row.customer_name, phone: row.phone,
    city_name: row.city_name, warehouse_name: row.warehouse_name, items, total_minor: row.total_minor,
    status: row.status, ttn: row.ttn, payment_method: row.payment_method, created_at: row.created_at
  };
}

async function createWaybill(env, order, settings) {
  const required = ['citySender', 'sender', 'senderAddress', 'contactSender', 'sendersPhone'];
  const missing = required.filter((field) => !cleanText(settings[field], 120));
  if (missing.length) throw new Error('Спочатку заповни всі Ref відправника у вкладці «Нова пошта».');
  const recipientPhone = phoneForNp(order.phone);
  const person = splitName(order.customer_name);

  const counterparty = await npCall(env, 'Counterparty', 'save', {
    CounterpartyProperty: 'Recipient', CounterpartyType: 'PrivatePerson', CityRef: order.city_ref,
    ...person, Phone: recipientPhone
  });
  const recipientRef = counterparty.data?.[0]?.Ref;
  if (!recipientRef) throw new Error('Не вдалося отримати Ref отримувача від Нової пошти.');

  const contact = await npCall(env, 'ContactPerson', 'save', {
    CounterpartyRef: recipientRef,
    FirstName: person.FirstName,
    LastName: person.LastName,
    MiddleName: person.MiddleName,
    Phone: `0${recipientPhone.slice(-9)}`
  });
  const contactRef = contact.data?.[0]?.Ref;
  if (!contactRef) throw new Error('Нова пошта не повернула Ref контактної особи отримувача.');

  const items = JSON.parse(order.items_json || '[]');
  const description = cleanText(items.map((item) => item.name).join(', '), 100) || 'Товари Koqumo’s Shop';
  const properties = {
    PayerType: 'Recipient', PaymentMethod: 'Cash', CargoType: 'Parcel',
    Weight: String(settings.weight || '0.5'), ServiceType: 'WarehouseWarehouse', SeatsAmount: '1',
    Description: description, Cost: String(Math.max(1, Math.round(order.total_minor / 100))),
    CitySender: settings.citySender, Sender: settings.sender, SenderAddress: settings.senderAddress,
    ContactSender: settings.contactSender, SendersPhone: phoneForNp(settings.sendersPhone),
    CityRecipient: order.city_ref, Recipient: recipientRef, RecipientAddress: order.warehouse_ref,
    ContactRecipient: contactRef, RecipientsPhone: recipientPhone
  };
  if (order.payment_method === 'upon_receipt') {
    properties.BackwardDeliveryData = [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: String(Math.max(1, Math.round(order.total_minor / 100))) }];
  }
  const waybill = await npCall(env, 'InternetDocument', 'save', properties);
  const data = waybill.data?.[0] || {};
  const ttn = data.IntDocNumber || data.Number || '';
  if (!ttn) throw new Error('Нова пошта не повернула номер ТТН. Перевір відповідь у кабінеті Нової пошти.');
  return { ttn, ref: data.Ref || null };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (path === '/api/health' && method === 'GET') return json({ ok: true, service: 'Koqumo Shop API', database: Boolean(env.DB) });
  if (!env.DB) return fail('Cloudflare D1 не підключена. Перевір wrangler.jsonc.', 503);

  if (path === '/api/admin/login' && method === 'POST') {
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return fail('Адміністратор ще не налаштований. Додай ADMIN_PASSWORD та SESSION_SECRET у Cloudflare Secrets.', 503);
    const body = await bodyJson(request);
    const supplied = cleanText(body.password, 200);
    const suppliedHash = await sign(supplied, env.SESSION_SECRET);
    const actualHash = await sign(env.ADMIN_PASSWORD, env.SESSION_SECRET);
    if (suppliedHash !== actualHash) return fail('Неправильний пароль.', 401);
    const token = await issueSession(env.SESSION_SECRET);
    return json({ ok: true }, 200, { 'set-cookie': `koqumo_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200` });
  }
  if (path === '/api/admin/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': 'koqumo_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (path === '/api/admin/me' && method === 'GET') {
    const auth = await requireAdmin(request, env); return auth || json({ ok: true });
  }

  if (path === '/api/np/cities' && method === 'GET') {
    const query = cleanText(url.searchParams.get('q'), 80);
    if (query.length < 2) return json({ cities: [] });
    try {
      const result = await npCall(env, 'Address', 'getCities', { FindByString: query, Limit: '20' });
      return json({ cities: (result.data || []).map((city) => ({ ref: city.Ref, name: city.Description, area: city.AreaDescription || '' })).filter((city) => city.ref && city.name) });
    } catch (error) { return fail(error.message, 502); }
  }
  if (path === '/api/np/warehouses' && method === 'GET') {
    const cityRef = cleanText(url.searchParams.get('cityRef'), 80);
    const query = cleanText(url.searchParams.get('q'), 100);
    if (!cityRef) return fail('Обери місто.');
    try {
      const result = await npCall(env, 'Address', 'getWarehouses', { CityRef: cityRef, FindByString: query, Limit: '50' });
      return json({ warehouses: (result.data || []).map((warehouse) => ({ ref: warehouse.Ref, name: warehouse.Description })).filter((warehouse) => warehouse.ref && warehouse.name) });
    } catch (error) { return fail(error.message, 502); }
  }

  if (path === '/api/products' && method === 'GET') {
    const result = await env.DB.prepare('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC').all();
    return json({ products: (result.results || []).map(publicProduct) });
  }

  if (path === '/api/orders' && method === 'POST') {
    const body = await bodyJson(request);
    const customerName = cleanText(body.customerName, 100);
    const phone = cleanText(body.phone, 24);
    const cityRef = cleanText(body.cityRef, 80);
    const cityName = cleanText(body.cityName, 120);
    const warehouseRef = cleanText(body.warehouseRef, 80);
    const warehouseName = cleanText(body.warehouseName, 180);
    const itemsInput = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
    if (customerName.length < 3 || cleanPhone(phone).length < 10 || !cityRef || !cityName || !warehouseRef || !warehouseName || !itemsInput.length) return fail('Заповни всі поля та обери місто й відділення зі списку Нової пошти.');
    let total = 0;
    const items = [];
    for (const item of itemsInput) {
      const id = cleanText(item.productId, 50);
      const quantity = Math.max(1, Math.min(20, Math.floor(Number(item.quantity) || 1)));
      const product = await env.DB.prepare('SELECT * FROM products WHERE id = ? AND active = 1').bind(id).first();
      if (!product || Number(product.stock) < quantity) return fail(`Товар «${product?.name || 'невідомий'}» вже недоступний у потрібній кількості. Онови кошик.` , 409);
      const unitPrice = Math.round(Number(product.price_minor) * (100 - Number(product.discount_percent || 0)) / 100);
      total += unitPrice * quantity;
      items.push({ productId: product.id, name: product.name, quantity, unitPrice });
    }
    if (total <= 0 || total > 100_000_000) return fail('Некоректна сума замовлення.');
    const orderNumber = `KQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
    const id = crypto.randomUUID();
    const paymentMethod = body.paymentMethod === 'transfer' ? 'transfer' : 'upon_receipt';
    const statements = [env.DB.prepare(`INSERT INTO orders (id, order_number, customer_name, phone, city_ref, city_name, warehouse_ref, warehouse_name, items_json, total_minor, payment_method, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`)
      .bind(id, orderNumber, customerName, phone, cityRef, cityName, warehouseRef, warehouseName, JSON.stringify(items), total, paymentMethod)];
    for (const item of items) {
      statements.push(env.DB.prepare('INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price_minor) VALUES (?, ?, ?, ?, ?)')
        .bind(id, item.productId, item.name, item.quantity, item.unitPrice));
    }
    try { await env.DB.batch(statements); }
    catch (error) {
      if (/stock|product|insufficient/i.test(error.message || '')) return fail('Один із товарів щойно закінчився. Онови кошик.', 409);
      throw error;
    }
    return json({ ok: true, orderNumber });
  }

  if (path.startsWith('/api/admin/')) {
    const auth = await requireAdmin(request, env); if (auth) return auth;
  }
  if (path === '/api/admin/products' && method === 'GET') {
    const result = await env.DB.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
    return json({ products: (result.results || []).map(publicProduct) });
  }
  if (path === '/api/admin/products' && method === 'POST') {
    const body = await bodyJson(request);
    const name = cleanText(body.name, 100);
    const price = Number(body.price);
    const discount = Math.floor(Number(body.discountPercent) || 0);
    const stock = Math.floor(Number(body.stock) || 0);
    if (name.length < 2 || !Number.isFinite(price) || price < 1 || price > 1_000_000 || discount < 0 || discount > 90 || stock < 0 || stock > 100_000) return fail('Перевір назву, ціну, знижку та кількість товару.');
    const image = body.imageUrl ? safeImage(body.imageUrl) : '';
    if (body.imageUrl && !image) return fail('Посилання на фото має починатися з https://.');
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO products (id, name, description, category, image_url, price_minor, discount_percent, stock, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .bind(id, name, cleanText(body.description, 1000), cleanText(body.category, 40), image, Math.round(price * 100), discount, stock).run();
    return json({ ok: true, id }, 201);
  }
  const productRoute = path.match(/^\/api\/admin\/products\/([0-9a-f-]+)$/i);
  if (productRoute && method === 'PUT') {
    const body = await bodyJson(request);
    const name = cleanText(body.name, 100);
    const price = Number(body.price);
    const discount = Math.floor(Number(body.discountPercent) || 0);
    const stock = Math.floor(Number(body.stock) || 0);
    if (name.length < 2 || !Number.isFinite(price) || price < 1 || price > 1_000_000 || discount < 0 || discount > 90 || stock < 0 || stock > 100_000) return fail('Перевір назву, ціну, знижку та кількість товару.');
    const image = body.imageUrl ? safeImage(body.imageUrl) : '';
    if (body.imageUrl && !image) return fail('Посилання на фото має починатися з https://.');
    const result = await env.DB.prepare('UPDATE products SET name=?, description=?, category=?, image_url=?, price_minor=?, discount_percent=?, stock=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(name, cleanText(body.description, 1000), cleanText(body.category, 40), image, Math.round(price * 100), discount, stock, productRoute[1]).run();
    if (!result.meta?.changes) return fail('Товар не знайдено.', 404);
    return json({ ok: true });
  }
  if (productRoute && method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(productRoute[1]).run();
    if (!result.meta?.changes) return fail('Товар не знайдено.', 404);
    return json({ ok: true });
  }

  if (path === '/api/admin/orders' && method === 'GET') {
    const result = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
    return json({ orders: (result.results || []).map(publicOrder) });
  }
  const orderRoute = path.match(/^\/api\/admin\/orders\/([0-9a-f-]+)(?:\/(waybill))?$/i);
  if (orderRoute && method === 'PATCH' && !orderRoute[2]) {
    const body = await bodyJson(request);
    const allowed = ['new', 'confirmed', 'sent', 'completed', 'cancelled'];
    if (!allowed.includes(body.status)) return fail('Невідомий статус замовлення.');
    const result = await env.DB.prepare('UPDATE orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(body.status, orderRoute[1]).run();
    if (!result.meta?.changes) return fail('Замовлення не знайдено.', 404);
    return json({ ok: true });
  }
  if (orderRoute && orderRoute[2] === 'waybill' && method === 'POST') {
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderRoute[1]).first();
    if (!order) return fail('Замовлення не знайдено.', 404);
    if (order.ttn) return fail(`Для цього замовлення вже є ТТН: ${order.ttn}`, 409);
    try {
      const settings = await getSettings(env.DB);
      const result = await createWaybill(env, order, settings);
      await env.DB.prepare("UPDATE orders SET ttn=?, status=CASE WHEN status='new' THEN 'sent' ELSE status END, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(result.ttn, order.id).run();
      return json({ ok: true, ttn: result.ttn });
    } catch (error) { return fail(error.message || 'Не вдалося створити ТТН.', 502); }
  }
  if (path === '/api/admin/shipping-settings' && method === 'GET') {
    const settings = await getSettings(env.DB);
    return json({ settings });
  }
  if (path === '/api/admin/shipping-settings' && method === 'PUT') {
    const body = await bodyJson(request);
    const settings = {
      citySender: cleanText(body.citySender, 80), sender: cleanText(body.sender, 80),
      senderAddress: cleanText(body.senderAddress, 80), contactSender: cleanText(body.contactSender, 80),
      sendersPhone: cleanText(body.sendersPhone, 24), weight: String(Math.max(0.1, Math.min(30, Number(body.weight) || 0.5)))
    };
    await saveSettings(env.DB, settings);
    return json({ ok: true });
  }
  return fail('Маршрут API не знайдено.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await handleApi(request, env); }
    catch (error) {
      console.error('Koqumo Shop API error:', error);
      return fail(error.message || 'Внутрішня помилка сервера.', 500);
    }
  }
};
