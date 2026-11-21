import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, getSettings, saveSettings, parseRow } from './db.js';
import * as ikas from './ikas.js';
import * as S from './subscriptions.js';
import { manageRouter } from './manage.js';
import * as mail from './mailer.js';
import { env, runInStore, defaultStore, isStoreName } from './context.js';

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
  const store = String(req.query.store || req.body?.store || defaultStore());
  if (!knownStore(store)) return res.status(404).json({ error: 'Mağaza bulunamadı' });
  runInStore(store, next);
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

// ---------- Mağazalar ve oturum ----------
const activeStore = (store) => db.prepare('SELECT * FROM stores WHERE store_name = ? AND uninstalled_at IS NULL').get(store);
const knownStore = (store) => isStoreName(store) && (store === defaultStore() || !!activeStore(store));

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (x, y) => crypto.timingSafeEqual(sha(x), sha(y));
const SESSION_SECRET = () => env('SESSION_SECRET') || env('IKAS_APP_CLIENT_SECRET') || env('ADMIN_PASSWORD') || 'dev';
const SESSION_TTL = 60 * 60 * 24 * 14;

/** "mağaza.bitişZamanı.imza" biçiminde oturum anahtarı. ikas içindeki iframe'de çerez engellenebildiği için başlıkla da gönderilir. */
function makeSession(store) {
  const body = `${store}.${Math.floor(Date.now() / 1000) + SESSION_TTL}`;
  return `${body}.${crypto.createHmac('sha256', SESSION_SECRET()).update(body).digest('base64url')}`;
}
function readSession(tok) {
  const [store, exp, sig] = String(tok || '').split('.');
  if (!store || !exp || !sig) return null;
  const good = crypto.createHmac('sha256', SESSION_SECRET()).update(`${store}.${exp}`).digest('base64url');
  if (!same(sig, good) || Number(exp) < Date.now() / 1000 || !knownStore(store)) return null;
  return store;
}
const cookie = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[1]))['abn_sess'];
const setCookie = (req, res, tok) => res.set('Set-Cookie', `abn_sess=${tok}; HttpOnly; Path=/; Max-Age=${SESSION_TTL}; ${req.secure ? 'SameSite=None; Secure' : 'SameSite=Lax'}`);

function adminAuth(req, res, next) {
  const store = readSession(req.get('x-abn-session')) || readSession(req.query.t) || readSession(cookie(req));
  if (store) { req.store = store; return runInStore(store, next); }
  if (req.method === 'GET' && !req.originalUrl.startsWith('/api/')) return res.redirect('/login');
  res.status(401).json({ error: 'Oturum süresi doldu; uygulamayı ikas panelinden yeniden açın' });
}

const loginPage = (err = '') => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Abonelik Paneli · Giriş</title><style>body{font-family:system-ui,Arial,sans-serif;background:#f5f6f4;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
form{background:#fff;padding:28px;border-radius:12px;box-shadow:0 1px 4px #0002;width:100%;max-width:340px}h1{font-size:18px;margin:0 0 16px;color:#2f6b3a}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;margin-bottom:12px;font:inherit}p{color:#666;font-size:13px}
button{width:100%;padding:11px;background:#2f6b3a;color:#fff;border:0;border-radius:8px;font:inherit;cursor:pointer}.e{color:#b3261e;font-size:14px;margin-bottom:10px}</style></head>
<body><form method="post" action="/login"><h1>Abonelik Paneli</h1>${err ? `<div class="e">${err}</div>` : ''}
<p>ikas mağazanızdan açtığınızda giriş otomatik yapılır. Doğrudan erişim için yönetici şifresi:</p>
<input type="password" name="password" placeholder="Şifre" autofocus required><button>Giriş yap</button></form></body></html>`;

const loginTries = new Map();
app.get('/login', (req, res) => res.send(loginPage()));
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const now = Date.now(), list = (loginTries.get(req.ip) || []).filter((t) => now - t < 600_000);
  if (list.length >= 10) return res.status(429).send(loginPage('Çok fazla deneme, 10 dakika sonra tekrar deneyin.'));
  if (!env('ADMIN_PASSWORD') || !defaultStore() || !same(req.body?.password || '', env('ADMIN_PASSWORD'))) {
    loginTries.set(req.ip, [...list, now]);
    return res.status(401).send(loginPage('Şifre hatalı.'));
  }
  setCookie(req, res, makeSession(defaultStore())).redirect('/admin');
});
app.get('/logout', (req, res) => res.set('Set-Cookie', 'abn_sess=; Path=/; Max-Age=0').redirect('/login'));

// ---------- ikas partner kurulumu (OAuth) ----------
const REDIRECT_URI = () => `${PUBLIC_URL}/oauth/callback`;
// state sunucu belleğinde değil imzalı tutulur: yeniden başlatma/deploy sırasında kurulum bozulmasın.
const signState = (store, exp, nonce) => crypto.createHmac('sha256', SESSION_SECRET()).update(`oauth.${store}.${exp}.${nonce}`).digest('base64url');
function makeState(store) {
  const exp = Math.floor(Date.now() / 1000) + 30 * 60, nonce = crypto.randomBytes(8).toString('hex');
  return `${store}.${exp}.${nonce}.${signState(store, exp, nonce)}`;
}
function readState(state) {
  const [store, exp, nonce, sig] = String(state || '').split('.');
  if (!store || !exp || !nonce || !sig || Number(exp) < Date.now() / 1000) return null;
  return same(sig, signState(store, exp, nonce)) ? store : null;
}
/** ikas callback imzası (varsa): code'un uygulama secret'ı ile HMAC-SHA256'sı. */
function validCodeSignature(code, signature) {
  const secret = ikas.appCreds().client_secret;
  if (!secret || !code || !signature) return false;
  const d = crypto.createHmac('sha256', secret).update(String(code)).digest();
  return [d.toString('hex'), d.toString('base64'), d.toString('base64url')].some((x) => same(x, String(signature)));
}

function startOAuth(res, store) {
  const { client_id } = ikas.appCreds();
  if (!client_id) return res.status(500).send('IKAS_APP_CLIENT_ID tanımlı değil');
  const state = makeState(store);
  const q = new URLSearchParams({ client_id, redirect_uri: REDIRECT_URI(), scope: ikas.APP_SCOPES, state });
  res.redirect(`${ikas.oauthBase(store)}/authorize?${q}`);
}

/** ikas'ın uygulamayı açarken eklediği imzayı doğrular: storeName+merchantId+timestamp, uygulama secret'ı ile HMAC-SHA256. */
function validAdminSignature(q) {
  const secret = ikas.appCreds().client_secret;
  if (!secret || !q.signature) return false;
  const h = crypto.createHmac('sha256', secret).update(`${q.storeName}${q.merchantId}${q.timestamp}`);
  const d = h.digest();
  return [d.toString('hex'), d.toString('base64'), d.toString('base64url')].some((x) => same(x, q.signature));
}

// Kurulum Adresi: ikas hem kurulumda (?storeName=) hem panelden açılışta (imzalı parametrelerle) buraya yönlendirir.
app.get('/', (req, res) => {
  const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
  if (!q.storeName) return res.redirect('/admin');
  if (!isStoreName(q.storeName)) return res.status(400).send('Geçersiz mağaza adı');
  const row = activeStore(q.storeName);
  if (q.signature && row) {
    if (!validAdminSignature(q) || (row.merchant_id && q.merchantId !== row.merchant_id)) {
      console.warn('[oauth] imza doğrulanamadı', { storeName: q.storeName, merchantId: q.merchantId, timestamp: q.timestamp });
      return res.status(401).send('İmza doğrulanamadı. Uygulamayı ikas panelinden yeniden açın.');
    }
    const tok = makeSession(q.storeName);
    return setCookie(req, res, tok).redirect(`/admin?t=${encodeURIComponent(tok)}`);
  }
  startOAuth(res, q.storeName);
});

app.get('/oauth/callback', wrap(async (req, res) => {
  const { code, state, storeName, signature } = req.query;
  console.log('[oauth] callback', { params: Object.keys(req.query), storeName, hasState: !!state, hasSignature: !!signature });
  let store = readState(state);
  // ikas kurulumu kendisi başlatınca yalnızca code + storeName gönderir (state/imza yok; Railway loglarıyla doğrulandı).
  // code yalnızca bu mağazanın token adresinde, uygulamanın client_secret'ı ile değiştirilebildiği için yeterli güvencedir.
  // İmza gelirse yine de doğrulanır.
  if (!store && isStoreName(storeName) && (!signature || validCodeSignature(code, signature)) && !state) store = String(storeName);
  if (!code || !store) {
    console.warn('[oauth] callback reddedildi', { storeName, stateOk: !!readState(state), signatureOk: validCodeSignature(code, signature) });
    return res.status(400).send('Kurulum oturumu geçersiz veya süresi doldu. Uygulamayı ikas\'tan yeniden yükleyin.');
  }
  if (storeName && storeName !== store) return res.status(400).send('Mağaza eşleşmedi');
  const j = await ikas.tokenRequest(store, { grant_type: 'authorization_code', code: String(code), redirect_uri: REDIRECT_URI(), ...ikas.appCreds() });
  const d = await ikas.gql('{ getMerchant { id storeName } me { id } }', {}, { token: j.access_token });
  db.prepare(`INSERT INTO stores (store_name, merchant_id, authorized_app_id, access_token, refresh_token, expires_at, scope, installed_at, uninstalled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL) ON CONFLICT(store_name) DO UPDATE SET merchant_id=excluded.merchant_id,
    authorized_app_id=excluded.authorized_app_id, access_token=excluded.access_token, refresh_token=excluded.refresh_token,
    expires_at=excluded.expires_at, scope=excluded.scope, uninstalled_at=NULL`)
    .run(store, d.getMerchant?.id || null, d.me?.id || null, j.access_token, j.refresh_token || null,
      Date.now() + (j.expires_in || 14400) * 1000, j.scope || ikas.APP_SCOPES);
  console.log('[oauth] kuruldu:', store);
  res.redirect(d.me?.id ? `https://${store}.myikas.com/admin/authorized-app/${d.me.id}` : `/admin?t=${encodeURIComponent(makeSession(store))}`);
}));

// Partner panelindeki "Webhook Adresi": ödeme ve silinme bildirimleri.
app.post('/webhooks/ikas', (req, res) => {
  const b = req.body || {};
  console.log('[webhook]', JSON.stringify(b).slice(0, 1000));
  const store = b.storeName || b.data?.storeName;
  const merchantId = b.merchantId || b.data?.merchantId;
  if (/uninstall|delete|remove/i.test(JSON.stringify(b.type || b.scope || b.event || '')) && (store || merchantId)) {
    db.prepare("UPDATE stores SET uninstalled_at = datetime('now'), access_token = NULL, refresh_token = NULL WHERE store_name = ? OR merchant_id = ?")
      .run(store || '', merchantId || '');
  }
  res.sendStatus(200);
});

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

admin.get('/products', (req, res) => res.json(db.prepare('SELECT * FROM products WHERE store = ? ORDER BY name').all(req.store).map(parseRow)));
admin.put('/products/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const live = await ikas.getProduct(req.params.id);
  if (!live) throw new Error('Ürün ikas\'ta bulunamadı');
  const discount = b.discountPercent === '' || b.discountPercent == null ? null : Number(b.discountPercent);
  if (discount != null && !(discount >= 0 && discount < 100)) throw new Error('İndirim 0-99 arası olmalı');
  db.prepare(`INSERT INTO products (store, product_id, name, slug, enabled, discount_percent, period_ids, variants, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(store, product_id) DO UPDATE SET name=excluded.name, slug=excluded.slug,
    enabled=excluded.enabled, discount_percent=excluded.discount_percent, period_ids=excluded.period_ids, variants=excluded.variants, updated_at=excluded.updated_at`)
    .run(req.store, live.id, live.name, live.slug, b.enabled ? 1 : 0, discount,
      Array.isArray(b.periodIds) && b.periodIds.length ? JSON.stringify(b.periodIds) : null, JSON.stringify(live.variants));
  res.json(parseRow(db.prepare('SELECT * FROM products WHERE store = ? AND product_id = ?').get(req.store, live.id)));
}));
admin.delete('/products/:id', (req, res) => { db.prepare('DELETE FROM products WHERE store = ? AND product_id = ?').run(req.store, req.params.id); res.json({ ok: true }); });

admin.get('/subscriptions', (req, res) => {
  const st = req.query.status;
  const rows = st ? db.prepare('SELECT * FROM subscriptions WHERE store = ? AND status = ? ORDER BY id DESC').all(req.store, st)
    : db.prepare('SELECT * FROM subscriptions WHERE store = ? ORDER BY id DESC').all(req.store);
  res.json(rows.map(parseRow).map(({ token, ...r }) => ({ ...r, manageUrl: `${PUBLIC_URL}/s/${token}` })));
});
admin.post('/subscriptions/:id/:action', wrap(async (req, res) => {
  const sub = S.getSub('id', Number(req.params.id));
  if (!sub || sub.store !== req.store) throw new Error('Abonelik bulunamadı');
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
  FROM orders o JOIN subscriptions s ON s.id = o.subscription_id WHERE s.store = ? ORDER BY o.id DESC LIMIT 500`).all(req.store)));
admin.get('/mails', (req, res) => res.json(db.prepare('SELECT * FROM mail_log WHERE store = ? ORDER BY id DESC LIMIT 200').all(req.store)));
admin.post('/test-mail', wrap(async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Geçerli bir e-posta girin');
  if (!mail.smtpConfigured()) throw new Error('SMTP ayarlanmamış (.env içindeki SMTP_HOST boş)');
  const status = await mail.sendTest(to);
  if (status !== 'sent') throw new Error(db.prepare('SELECT error FROM mail_log ORDER BY id DESC LIMIT 1').get()?.error || 'Gönderilemedi');
  res.json({ ok: true });
}));
admin.post('/run', wrap(async (req, res) => res.json(await S.runDue())));
admin.get('/me', (req, res) => res.json({ store: req.store }));

admin.post('/install-script', wrap(async (req, res) => {
  const storefrontId = req.body?.storefrontId || getSettings().storefrontId;
  if (!storefrontId) throw new Error('Storefront seçin');
  saveSettings({ storefrontId });
  const scriptContent = `(function(){var s=document.createElement('script');s.src=${JSON.stringify(`${PUBLIC_URL}/widget.js?store=${encodeURIComponent(req.store)}`)};s.async=true;document.head.appendChild(s);})();`;
  res.json(await ikas.saveStorefrontScript({ storefrontId, scriptContent }));
}));

app.use('/api/admin', admin);
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/admin', adminAuth, (req, res) => res.sendFile(path.resolve('public/admin.html')));
app.get('/demo', (req, res) => res.sendFile(path.resolve('public/demo.html')));

// ---------- Zamanlayıcı ----------
const INTERVAL = Number(process.env.SCHEDULER_MINUTES || 15) * 60_000;
const tick = () => S.runDue().then((s) => (s.orders || s.failed || s.reminders) && console.log('[zamanlayıcı]', s)).catch((e) => console.error('[zamanlayıcı]', e));
if (process.env.SCHEDULER !== '0') { setTimeout(tick, 5_000); setInterval(tick, INTERVAL); }

export const server = app.listen(PORT, () => console.log(`Abonelik modülü: ${PUBLIC_URL} (panel: /admin)${process.env.IKAS_MOCK === '1' ? ' [MOCK]' : ''}`));
