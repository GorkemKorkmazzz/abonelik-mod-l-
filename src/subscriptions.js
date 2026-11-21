import crypto from 'node:crypto';
import { db, getSettings, parseRow } from './db.js';
import { today, addDays, addPeriod, isDate } from './dates.js';
import * as ikas from './ikas.js';
import * as mail from './mailer.js';
import { currentStore, runInStore } from './context.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function productConfig(row, settings = getSettings()) {
  const p = parseRow(row);
  const periods = p.period_ids?.length ? settings.periods.filter((x) => p.period_ids.includes(x.id)) : settings.periods;
  const discount = p.discount_percent ?? settings.defaultDiscountPercent;
  return {
    productId: p.product_id, name: p.name, slug: p.slug, discountPercent: discount, periods,
    variants: p.variants.map((v) => ({ ...v, subscriptionPrice: round2(v.price * (1 - discount / 100)) })),
  };
}

export const findProductBySlug = (slug) =>
  db.prepare('SELECT * FROM products WHERE store = ? AND enabled = 1 AND slug = ?').get(currentStore(), String(slug).replace(/^\/+|\/+$/g, ''));

export const getSub = (where, val) => parseRow(db.prepare(`SELECT * FROM subscriptions WHERE ${where} = ?`).get(val));

const req = (v, name, max = 200) => {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`${name} zorunlu`);
  return s.slice(0, max);
};

export async function createSubscription(body) {
  const settings = getSettings();
  const row = body.productId
    ? db.prepare('SELECT * FROM products WHERE store = ? AND enabled = 1 AND product_id = ?').get(currentStore(), String(body.productId))
    : findProductBySlug(body.slug || '');
  if (!row) throw new Error('Bu ürün için düzenli teslimat aktif değil');
  const cfg = productConfig(row, settings);
  const variant = cfg.variants.find((v) => v.id === body.variantId) || (cfg.variants.length === 1 ? cfg.variants[0] : null);
  if (!variant) throw new Error('Geçerli bir ürün seçeneği seçin');
  const period = cfg.periods.find((p) => p.id === body.periodId);
  if (!period) throw new Error('Geçerli bir teslimat periyodu seçin');
  const qty = Math.min(Math.max(parseInt(body.quantity, 10) || 1, 1), 99);

  const t = today();
  const start = body.startDate || t;
  if (!isDate(start) || start < t || start > addDays(t, settings.maxStartDays)) throw new Error('İlk teslimat tarihi geçersiz');

  const c = body.customer || {}, a = body.address || {};
  const email = req(c.email, 'E-posta').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-posta geçersiz');
  const customer = { firstName: req(c.firstName, 'Ad', 60), lastName: req(c.lastName, 'Soyad', 60), email, phone: req(c.phone, 'Telefon', 30) };
  const address = {
    addressLine1: req(a.addressLine1, 'Adres', 300), addressLine2: String(a.addressLine2 || '').slice(0, 200),
    city: req(a.city, 'İl', 60), district: req(a.district, 'İlçe', 60), postalCode: String(a.postalCode || '').slice(0, 10),
  };

  const token = crypto.randomBytes(24).toString('base64url');
  const { lastInsertRowid } = db.prepare(`INSERT INTO subscriptions
    (store, token, product_id, product_name, variant_id, variant_name, quantity, discount_percent, period, start_date, next_date, customer, address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    currentStore(), token, cfg.productId, cfg.name, variant.id, cfg.variants.length > 1 ? variant.name : null, qty, cfg.discountPercent,
    JSON.stringify(period), start, start, JSON.stringify(customer), JSON.stringify(address));
  const sub = getSub('id', lastInsertRowid);
  await mail.sendWelcome(sub);
  if (start === t) await processSubscription(sub);
  return getSub('id', lastInsertRowid);
}

/** Abonelik için ikas'ta sipariş oluşturur ve next_date'i ilerletir. Aynı gün için iki kez sipariş açılmaz. */
export async function processSubscription(sub) {
  const settings = getSettings();
  const date = sub.next_date;
  const existing = db.prepare('SELECT * FROM orders WHERE subscription_id = ? AND scheduled_date = ?').get(sub.id, date);
  if (existing?.status === 'created') return advance(sub);
  if (existing && existing.attempts >= 5) return null; // panelden elle tekrar denenebilir

  try {
    // Fiyat her siparişte ikas'tan güncel çekilir; ürün bulunamazsa kayıtlı fiyat kullanılır.
    const live = await ikas.getProduct(sub.product_id).catch(() => null);
    const stored = parseRow(db.prepare('SELECT variants FROM products WHERE store = ? AND product_id = ?').get(sub.store, sub.product_id))?.variants || [];
    const v = live?.variants.find((x) => x.id === sub.variant_id) || stored.find((x) => x.id === sub.variant_id);
    if (!v) throw new Error('Ürün varyantı bulunamadı (silinmiş/pasif olabilir)');
    const unit = round2(v.price * (1 - sub.discount_percent / 100));
    const amount = round2(unit * sub.quantity);

    const addr = {
      firstName: sub.customer.firstName, lastName: sub.customer.lastName, phone: sub.customer.phone,
      addressLine1: sub.address.addressLine1, addressLine2: sub.address.addressLine2 || undefined,
      postalCode: sub.address.postalCode || undefined,
      city: { name: sub.address.city }, district: { name: sub.address.district },
      country: { name: 'Türkiye', iso2: 'TR', iso3: 'TUR', code: 'TR' }, isDefault: false,
    };
    const input = {
      order: {
        currencyCode: settings.currencyCode,
        shippingMethod: 'SHIPMENT',
        salesChannelId: settings.salesChannelId || undefined,
        customer: { email: sub.customer.email, firstName: sub.customer.firstName, lastName: sub.customer.lastName },
        shippingAddress: addr,
        billingAddress: addr,
        note: settings.orderNote.replace('{id}', sub.id).replace('{period}', sub.period.label),
        orderLineItems: [{ variant: { id: sub.variant_id }, quantity: sub.quantity, price: v.price, discountPrice: unit }],
      },
      transactions: [{ amount, paymentGatewayId: settings.paymentGatewayId || undefined }],
    };
    const res = await ikas.createOrder(input);
    db.prepare(`INSERT INTO orders (subscription_id, scheduled_date, status, ikas_order_id, order_number, amount)
      VALUES (?, ?, 'created', ?, ?, ?) ON CONFLICT(subscription_id, scheduled_date) DO UPDATE SET
      status='created', ikas_order_id=excluded.ikas_order_id, order_number=excluded.order_number, amount=excluded.amount, error=NULL, attempts=attempts+1`)
      .run(sub.id, date, res.id, res.orderNumber ?? null, amount);
    const order = db.prepare('SELECT * FROM orders WHERE subscription_id = ? AND scheduled_date = ?').get(sub.id, date);
    const advanced = advance(sub);
    await mail.sendOrderCreated(advanced, order);
    return order;
  } catch (e) {
    db.prepare(`INSERT INTO orders (subscription_id, scheduled_date, status, error) VALUES (?, ?, 'failed', ?)
      ON CONFLICT(subscription_id, scheduled_date) DO UPDATE SET status='failed', error=excluded.error, attempts=attempts+1`)
      .run(sub.id, date, e.message);
    const o = db.prepare('SELECT attempts FROM orders WHERE subscription_id = ? AND scheduled_date = ?').get(sub.id, date);
    if (o.attempts === 1 || o.attempts === 5) await mail.sendAdminAlert('Abonelik siparişi oluşturulamadı', `Abonelik #${sub.id} (${date}): ${e.message}`);
    console.error(`[abonelik #${sub.id}] sipariş hatası:`, e.message);
    return null;
  }
}

function advance(sub) {
  const anchor = Number(sub.start_date.slice(8, 10));
  let next = addPeriod(sub.next_date, sub.period, anchor);
  while (next <= today()) next = addPeriod(next, sub.period, anchor); // uzun kesintiden sonra geçmişe sipariş açma
  db.prepare('UPDATE subscriptions SET next_date = ?, reminded_for = NULL WHERE id = ?').run(next, sub.id);
  return getSub('id', sub.id);
}

export function skipNext(sub) {
  if (sub.status !== 'active') throw new Error('Abonelik aktif değil');
  return advance(sub);
}

export function postpone(sub, newDate) {
  const t = today();
  if (sub.status === 'cancelled') throw new Error('Abonelik iptal edilmiş');
  if (!isDate(newDate) || newDate <= t || newDate > addDays(t, 180)) throw new Error('Geçersiz tarih');
  db.prepare("UPDATE subscriptions SET next_date = ?, reminded_for = NULL, status = 'active' WHERE id = ?").run(newDate, sub.id);
  return getSub('id', sub.id);
}

export function periodsFor(productId) {
  const row = db.prepare('SELECT * FROM products WHERE store = ? AND product_id = ?').get(currentStore(), productId);
  return row ? productConfig(row).periods : getSettings().periods;
}

export function changePeriod(sub, periodId) {
  if (sub.status === 'cancelled') throw new Error('Abonelik iptal edilmiş');
  const p = periodsFor(sub.product_id).find((x) => x.id === periodId);
  if (!p) throw new Error('Geçersiz periyot');
  db.prepare('UPDATE subscriptions SET period = ? WHERE id = ?').run(JSON.stringify(p), sub.id);
  return getSub('id', sub.id);
}

export async function cancel(sub) {
  if (sub.status === 'cancelled') return sub;
  db.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").run(sub.id);
  const s = getSub('id', sub.id);
  await mail.sendCancelled(s);
  return s;
}

export function setPaused(sub, paused) {
  if (sub.status === 'cancelled') throw new Error('Abonelik iptal edilmiş');
  db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run(paused ? 'paused' : 'active', sub.id);
  let s = getSub('id', sub.id);
  if (!paused && s.next_date <= today()) s = advance(s);
  return s;
}

let running = false;
/** Zamanlayıcı turu: vadesi gelenlere sipariş, yaklaşanlara hatırlatma. */
export async function runDue() {
  if (running) return { skipped: true };
  running = true;
  const stats = { orders: 0, failed: 0, reminders: 0 };
  try {
    const t = today();
    const due = db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND next_date <= ? ORDER BY next_date").all(t).map(parseRow);
    for (const s of due) (await runInStore(s.store, () => processSubscription(s))) ? stats.orders++ : stats.failed++;

    const days = Number(getSettings().reminderDaysBefore) || 0;
    if (days > 0) {
      const upcoming = db.prepare(`SELECT * FROM subscriptions WHERE status = 'active' AND next_date > ? AND next_date <= ?
        AND (reminded_for IS NULL OR reminded_for <> next_date)`).all(t, addDays(t, days)).map(parseRow);
      for (const s of upcoming) {
        await runInStore(s.store, () => mail.sendReminder(s));
        db.prepare('UPDATE subscriptions SET reminded_for = next_date WHERE id = ?').run(s.id);
        stats.reminders++;
      }
    }
  } finally { running = false; }
  return stats;
}
