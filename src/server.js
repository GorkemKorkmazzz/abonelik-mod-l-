import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, getSettings, saveSettings, parseRow } from './db.js';
import * as ikas from './ikas.js';
import * as S from './subscriptions.js';
import { manageRouter } from './manage.js';
import * as mail from './mailer.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

// ---------- Mağaza (storefront) API: CORS açık ----------
const pub = express.Router();
pub.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

pub.get('/config', wrap((req, res) => {
  const slug = String(req.query.slug || '').split('?')[0];
  const row = S.findProductBySlug(slug);
  if (!row) return res.json({ enabled: false });
  const s = getSettings();
  res.json({ enabled: true, ...S.productConfig(row, s), texts: s.texts, anchorSelector: s.anchorSelector, maxStartDays: s.maxStartDays });
}));

const hits = new Map(); // basit IP başına sınır: 10 dk'da 10 abonelik
pub.post('/subscribe', wrap(async (req, res) => {
  const now = Date.now(), list = (hits.get(req.ip) || []).filter((t) => now - t < 600_000);
  if (list.length >= 10) return res.status(429).json({ error: 'Çok fazla deneme, lütfen sonra tekrar deneyin' });
  hits.set(req.ip, [...list, now]);
  const sub = await S.createSubscription(req.body || {});
  res.json({ ok: true, id: sub.id, nextDate: sub.next_date, manageUrl: `${PUBLIC_URL}/s/${sub.token}` });
}));
app.use('/api/public', pub);
app.get('/widget.js', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.sendFile(path.resolve('public/widget.js'), { maxAge: '5m' });
});

// ---------- Müşteri abonelik yönetim sayfası ----------
app.use('/s', manageRouter);

// ---------- Satıcı paneli (Basic Auth) ----------
function adminAuth(req, res, next) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return res.status(500).send('ADMIN_PASSWORD tanımlı değil');
  const [, b64] = (req.headers.authorization || '').split(' ');
  const [, given = ''] = Buffer.from(b64 || '', 'base64').toString().split(':');
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(pass).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Abonelik Paneli"').status(401).send('Yetkisiz');
}
const admin = express.Router();
admin.use(adminAuth);

admin.get('/settings', (req, res) => res.json(getSettings()));
admin.put('/settings', wrap((req, res) => {
  const b = req.body || {};
  if (b.periods) {
    const ids = new Set();
    b.periods = b.periods.map((p) => {
      const id = String(p.id || crypto.randomBytes(3).toString('hex'));
      if (ids.has(id)) throw new Error(`Periyot kimliği tekrar ediyor: ${id}`);
      ids.add(id);
      if (!['day', 'week', 'month'].includes(p.unit)) throw new Error('Periyot birimi day/week/month olmalı');
      const interval = parseInt(p.interval, 10);
      if (!(interval >= 1 && interval <= 365)) throw new Error('Periyot aralığı 1-365 olmalı');
      return { id, label: String(p.label || '').trim() || `${interval} ${p.unit}`, unit: p.unit, interval };
    });
    if (!b.periods.length) throw new Error('En az bir periyot olmalı');
  }
  if ('defaultDiscountPercent' in b) {
    const d = Number(b.defaultDiscountPercent);
    if (!(d >= 0 && d < 100)) throw new Error('İndirim 0-99 arası olmalı');
    b.defaultDiscountPercent = d;
  }
  res.json(saveSettings(b));
}));

admin.get('/ikas/meta', wrap(async (req, res) => res.json(await ikas.listMeta())));
admin.get('/ikas/products', wrap(async (req, res) =>
  res.json(await ikas.listProducts({ page: Number(req.query.page) || 1, search: req.query.search || undefined }))));

admin.get('/products', (req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY name').all().map(parseRow)));
admin.put('/products/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const live = await ikas.getProduct(req.params.id);
  if (!live) throw new Error('Ürün ikas\'ta bulunamadı');
  const discount = b.discountPercent === '' || b.discountPercent == null ? null : Number(b.discountPercent);
  if (discount != null && !(discount >= 0 && discount < 100)) throw new Error('İndirim 0-99 arası olmalı');
  db.prepare(`INSERT INTO products (product_id, name, slug, enabled, discount_percent, period_ids, variants, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(product_id) DO UPDATE SET name=excluded.name, slug=excluded.slug,
    enabled=excluded.enabled, discount_percent=excluded.discount_percent, period_ids=excluded.period_ids, variants=excluded.variants, updated_at=excluded.updated_at`)
    .run(live.id, live.name, live.slug, b.enabled ? 1 : 0, discount,
      Array.isArray(b.periodIds) && b.periodIds.length ? JSON.stringify(b.periodIds) : null, JSON.stringify(live.variants));
  res.json(parseRow(db.prepare('SELECT * FROM products WHERE product_id = ?').get(live.id)));
}));
admin.delete('/products/:id', (req, res) => { db.prepare('DELETE FROM products WHERE product_id = ?').run(req.params.id); res.json({ ok: true }); });

admin.get('/subscriptions', (req, res) => {
  const st = req.query.status;
  const rows = st ? db.prepare('SELECT * FROM subscriptions WHERE status = ? ORDER BY id DESC').all(st)
    : db.prepare('SELECT * FROM subscriptions ORDER BY id DESC').all();
  res.json(rows.map(parseRow).map(({ token, ...r }) => ({ ...r, manageUrl: `${PUBLIC_URL}/s/${token}` })));
});
admin.post('/subscriptions/:id/:action', wrap(async (req, res) => {
  const sub = S.getSub('id', Number(req.params.id));
  if (!sub) throw new Error('Abonelik bulunamadı');
  const a = req.params.action;
  if (a === 'cancel') return res.json(await S.cancel(sub));
  if (a === 'pause') return res.json(S.setPaused(sub, true));
  if (a === 'resume') return res.json(S.setPaused(sub, false));
  if (a === 'skip') return res.json(S.skipNext(sub));
  if (a === 'postpone') return res.json(S.postpone(sub, req.body?.date));
  if (a === 'order-now') {
    db.prepare("DELETE FROM orders WHERE subscription_id = ? AND scheduled_date = ? AND status = 'failed'").run(sub.id, sub.next_date);
    const o = await S.processSubscription(sub);
    if (!o) throw new Error(db.prepare('SELECT error FROM orders WHERE subscription_id = ? AND scheduled_date = ?').get(sub.id, sub.next_date)?.error || 'Sipariş oluşturulamadı');
    return res.json(o);
  }
  throw new Error('Bilinmeyen işlem');
}));

admin.get('/orders', (req, res) => res.json(db.prepare(`SELECT o.*, s.product_name, json_extract(s.customer, '$.email') AS email
  FROM orders o JOIN subscriptions s ON s.id = o.subscription_id ORDER BY o.id DESC LIMIT 500`).all()));
admin.get('/mails', (req, res) => res.json(db.prepare('SELECT * FROM mail_log ORDER BY id DESC LIMIT 200').all()));
admin.post('/test-mail', wrap(async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Geçerli bir e-posta girin');
  if (!mail.smtpConfigured()) throw new Error('SMTP ayarlanmamış (.env içindeki SMTP_HOST boş)');
  const status = await mail.sendTest(to);
  if (status !== 'sent') throw new Error(db.prepare('SELECT error FROM mail_log ORDER BY id DESC LIMIT 1').get()?.error || 'Gönderilemedi');
  res.json({ ok: true });
}));
admin.post('/run', wrap(async (req, res) => res.json(await S.runDue())));

admin.post('/install-script', wrap(async (req, res) => {
  const storefrontId = req.body?.storefrontId || getSettings().storefrontId;
  if (!storefrontId) throw new Error('Storefront seçin');
  saveSettings({ storefrontId });
  const scriptContent = `(function(){var s=document.createElement('script');s.src=${JSON.stringify(PUBLIC_URL + '/widget.js')};s.async=true;document.head.appendChild(s);})();`;
  res.json(await ikas.saveStorefrontScript({ storefrontId, scriptContent }));
}));

app.use('/api/admin', admin);
app.get(['/', '/admin'], adminAuth, (req, res) => res.sendFile(path.resolve('public/admin.html')));
app.get('/demo', (req, res) => res.sendFile(path.resolve('public/demo.html')));

// ---------- Zamanlayıcı ----------
const INTERVAL = Number(process.env.SCHEDULER_MINUTES || 15) * 60_000;
const tick = () => S.runDue().then((s) => (s.orders || s.failed || s.reminders) && console.log('[zamanlayıcı]', s)).catch((e) => console.error('[zamanlayıcı]', e));
if (process.env.SCHEDULER !== '0') { setTimeout(tick, 5_000); setInterval(tick, INTERVAL); }

export const server = app.listen(PORT, () => console.log(`Abonelik modülü: ${PUBLIC_URL} (panel: /admin)${process.env.IKAS_MOCK === '1' ? ' [MOCK]' : ''}`));
