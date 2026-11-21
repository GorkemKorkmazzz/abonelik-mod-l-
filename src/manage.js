// Müşterinin mail ile gelen linkten (/s/:token) aboneliğini yönettiği sayfa.
import express from 'express';
import { getSettings } from './db.js';
import { trDate, today, addDays } from './dates.js';
import * as S from './subscriptions.js';

export const manageRouter = express.Router();
manageRouter.use(express.urlencoded({ extended: false }));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATUS = { active: 'Aktif', paused: 'Duraklatıldı', cancelled: 'İptal edildi' };

function page(sub, msg = '', err = '') {
  const { storeName } = getSettings();
  const periods = S.periodsFor(sub.product_id);
  const live = sub.status !== 'cancelled';
  const t = today();
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aboneliğim · ${esc(storeName)}</title><style>
body{font-family:system-ui,Arial,sans-serif;background:#f5f6f4;margin:0;color:#222}
.card{max-width:520px;margin:24px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px #0001}
h1{font-size:20px;margin:0 0 16px;color:#2f6b3a}dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px}dt{color:#666}dd{margin:0;font-weight:600}
form{margin:12px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center}button{border:0;border-radius:8px;padding:10px 14px;cursor:pointer;background:#2f6b3a;color:#fff}
button.sec{background:#e9ece8;color:#222}button.danger{background:#b3261e}select,input{padding:9px;border:1px solid #ccc;border-radius:8px}
.msg{padding:10px;border-radius:8px;background:#e7f3e9;margin-bottom:12px}.err{background:#fde8e7}</style></head><body><div class="card">
<h1>Düzenli Teslimat Aboneliğim</h1>
${msg ? `<div class="msg">${esc(msg)}</div>` : ''}${err ? `<div class="msg err">${esc(err)}</div>` : ''}
<dl><dt>Ürün</dt><dd>${esc(sub.product_name)}${sub.variant_name ? ' – ' + esc(sub.variant_name) : ''} × ${sub.quantity}</dd>
<dt>Periyot</dt><dd>${esc(sub.period.label)}</dd><dt>Durum</dt><dd>${STATUS[sub.status]}</dd>
${live ? `<dt>Sonraki teslimat</dt><dd>${trDate(sub.next_date)}</dd>` : ''}<dt>İndirim</dt><dd>%${sub.discount_percent}</dd></dl>
${live ? `
<form method="post" action="skip"><button class="sec">Sıradaki teslimatı atla</button></form>
<form method="post" action="postpone"><input type="date" name="date" min="${addDays(t, 1)}" max="${addDays(t, 180)}" required><button class="sec">Tarihi değiştir</button></form>
<form method="post" action="period"><select name="periodId">${periods.map((p) => `<option value="${esc(p.id)}" ${p.id === sub.period.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select><button class="sec">Periyodu güncelle</button></form>
<form method="post" action="${sub.status === 'paused' ? 'resume' : 'pause'}"><button class="sec">${sub.status === 'paused' ? 'Devam ettir' : 'Duraklat'}</button></form>
<form method="post" action="cancel" onsubmit="return confirm('Aboneliği iptal etmek istediğinize emin misiniz?')"><button class="danger">Aboneliği iptal et</button></form>` : ''}
</div></body></html>`;
}

manageRouter.use('/:token', (req, res, next) => {
  const sub = S.getSub('token', req.params.token);
  if (!sub) return res.status(404).send('Abonelik bulunamadı');
  req.sub = sub; next();
});
manageRouter.get('/:token', (req, res) => {
  if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(req.originalUrl.split('?')[0] + '/');
  res.send(page(req.sub));
});

const ACTIONS = {
  skip: (s) => [S.skipNext(s), 'Sıradaki teslimat atlandı.'],
  postpone: (s, b) => [S.postpone(s, b.date), 'Teslimat tarihi güncellendi.'],
  period: (s, b) => [S.changePeriod(s, b.periodId), 'Periyot güncellendi.'],
  pause: (s) => [S.setPaused(s, true), 'Abonelik duraklatıldı.'],
  resume: (s) => [S.setPaused(s, false), 'Abonelik devam ediyor.'],
  cancel: async (s) => [await S.cancel(s), 'Aboneliğiniz iptal edildi.'],
};
manageRouter.post('/:token/:action', async (req, res) => {
  const fn = ACTIONS[req.params.action];
  if (!fn) return res.status(404).send('Bulunamadı');
  try { const [sub, msg] = await fn(req.sub, req.body || {}); res.send(page(sub, msg)); }
  catch (e) { res.status(400).send(page(S.getSub('id', req.sub.id), '', e.message)); }
});
