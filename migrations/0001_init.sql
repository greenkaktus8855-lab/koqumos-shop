CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  price_minor INTEGER NOT NULL CHECK (price_minor > 0),
  discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 90),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  city_ref TEXT NOT NULL,
  city_name TEXT NOT NULL,
  warehouse_ref TEXT NOT NULL,
  warehouse_name TEXT NOT NULL,
  items_json TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'upon_receipt',
  status TEXT NOT NULL DEFAULT 'new',
  ttn TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_active_created ON products(active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_ttn ON orders(ttn);

CREATE TRIGGER IF NOT EXISTS prevent_negative_stock
BEFORE UPDATE OF stock ON products
WHEN NEW.stock < 0
BEGIN
  SELECT RAISE(ABORT, 'insufficient stock');
END;


CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor > 0)
);

CREATE TRIGGER IF NOT EXISTS check_order_item_stock
BEFORE INSERT ON order_items
WHEN (SELECT stock FROM products WHERE id = NEW.product_id AND active = 1) IS NULL
  OR (SELECT stock FROM products WHERE id = NEW.product_id AND active = 1) < NEW.quantity
BEGIN
  SELECT RAISE(ABORT, 'insufficient stock');
END;

CREATE TRIGGER IF NOT EXISTS reserve_order_item_stock
AFTER INSERT ON order_items
BEGIN
  UPDATE products SET stock = stock - NEW.quantity WHERE id = NEW.product_id;
END;
