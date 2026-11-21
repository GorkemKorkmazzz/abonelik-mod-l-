import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const file = process.env.DB_PATH || path.resolve('data/abonelik.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  discount_percent REAL,          -- NULL = genel ayardaki indirim
  period_ids TEXT,                -- JSON dizi, NULL = tüm periyotlar
  variants TEXT NOT NULL DEFAULT '[]', -- [{id,name,price}]
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  status TEXT NOT NULL,           -- sent | logged | failed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

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
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) out[key] = JSON.parse(value);
  return out;
}

export function saveSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
  return getSettings();
}

const JSON_COLS = ['period', 'customer', 'address', 'variants', 'period_ids'];
export function parseRow(row) {
  if (!row) return row;
  const r = { ...row };
  for (const c of JSON_COLS) if (typeof r[c] === 'string') r[c] = JSON.parse(r[c]);
  return r;
}
