import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { currentStore, defaultStore } from './context.js';

const file = process.env.DB_PATH || path.resolve('data/abonelik.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const exists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS stores (
  store_name TEXT PRIMARY KEY,
  merchant_id TEXT,
  authorized_app_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  scope TEXT,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  uninstalled_at TEXT
);
`);

// Eski tek mağazalı şemayı mağaza kolonlu şemaya taşı (mevcut kayıtlar varsayılan mağazaya atanır).
const legacy = defaultStore();
db.exec('BEGIN');
try {
  if (exists('settings') && !cols('settings').includes('store')) db.exec('ALTER TABLE settings RENAME TO settings_old');
  if (exists('products') && !cols('products').includes('store')) db.exec('ALTER TABLE products RENAME TO products_old');
  db.exec(`
CREATE TABLE IF NOT EXISTS settings (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));
CREATE TABLE IF NOT EXISTS products (
  store TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  discount_percent REAL,          -- NULL = genel ayardaki indirim
  period_ids TEXT,                -- JSON dizi, NULL = tüm periyotlar
  variants TEXT NOT NULL DEFAULT '[]', -- [{id,name,price}]
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store, product_id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',  -- active | paused | cancelled
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  variant_name TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  discount_percent REAL NOT NULL,
  period TEXT NOT NULL,           -- JSON {id,label,unit,interval}
  start_date TEXT NOT NULL,       -- YYYY-MM-DD
  next_date TEXT NOT NULL,        -- YYYY-MM-DD
  customer TEXT NOT NULL,         -- JSON {firstName,lastName,email,phone}
  address TEXT NOT NULL,          -- JSON
  reminded_for TEXT,              -- hatırlatma gönderilen next_date
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  scheduled_date TEXT NOT NULL,
  status TEXT NOT NULL,           -- created | failed
  ikas_order_id TEXT,
  order_number TEXT,
  amount REAL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subscription_id, scheduled_date)
);
CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  status TEXT NOT NULL,           -- sent | logged | failed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
  if (exists('settings_old')) { db.prepare('INSERT INTO settings (store, key, value) SELECT ?, key, value FROM settings_old').run(legacy); db.exec('DROP TABLE settings_old'); }
  if (exists('products_old')) {
    db.prepare(`INSERT INTO products (store, product_id, name, slug, enabled, discount_percent, period_ids, variants, updated_at)
      SELECT ?, product_id, name, slug, enabled, discount_percent, period_ids, variants, updated_at FROM products_old`).run(legacy);
    db.exec('DROP TABLE products_old');
  }
  for (const t of ['subscriptions', 'mail_log']) {
    if (!cols(t).includes('store')) db.exec(`ALTER TABLE ${t} ADD COLUMN store TEXT NOT NULL DEFAULT ''`);
    db.prepare(`UPDATE ${t} SET store = ? WHERE store = ''`).run(legacy);
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

export const DEFAULT_SETTINGS = {
  periods: [
    { id: 'w2', label: '2 Haftada Bir', unit: 'week', interval: 2 },
    { id: 'm1', label: 'Aylık', unit: 'month', interval: 1 },
    { id: 'm2', label: '2 Ayda Bir', unit: 'month', interval: 2 },
  ],
  defaultDiscountPercent: 10,
  currencyCode: 'TRY',
  salesChannelId: '',
  paymentGatewayId: '',
  storefrontId: '',
  reminderDaysBefore: 2,
  maxStartDays: 60,
  storeName: 'Mağazamız',
  anchorSelector: '',
  texts: {
    oneTime: 'Tek Seferlik',
    subscription: 'Düzenli Teslimat',
    bullets: [
      'İstediğin Zaman Ücretsiz Ertele veya İptal Et',
      'Aboneliğe Özel İndirimden Yararlan',
      'Ödeme kartı saklanmaz, her sipariş öncesi bilgilendirilirsin',
    ],
    button: 'Aboneliği Başlat',
  },
  orderNote: 'Abonelik siparişi #{id} ({period})',
};

export function getSettings() {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const { key, value } of db.prepare('SELECT key, value FROM settings WHERE store = ?').all(currentStore())) out[key] = JSON.parse(value);
  return out;
}

export function saveSettings(patch) {
  const store = currentStore();
  const stmt = db.prepare('INSERT INTO settings (store, key, value) VALUES (?, ?, ?) ON CONFLICT(store, key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) stmt.run(store, k, JSON.stringify(v));
  return getSettings();
}

const JSON_COLS = ['period', 'customer', 'address', 'variants', 'period_ids'];
export function parseRow(row) {
  if (!row) return row;
  const r = { ...row };
  for (const c of JSON_COLS) if (typeof r[c] === 'string') r[c] = JSON.parse(r[c]);
  return r;
}
