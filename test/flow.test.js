import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
process.env.IKAS_MOCK = '1';
process.env.SCHEDULER = '0';
process.env.PORT = '3999';
process.env.ADMIN_PASSWORD = 'test';
const { addPeriod, today, addDays } = await import('../src/dates.js');
const { server } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const S = await import('../src/subscriptions.js');
const B = 'http://localhost:3999';
const auth = { Authorization: 'Basic ' + Buffer.from('a:test').toString('base64'), 'Content-Type': 'application/json' };
const j = async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; };

test('tarih hesapları', () => {
  assert.equal(addPeriod('2026-01-31', { unit: 'month', interval: 1 }, 31), '2026-02-28');
  assert.equal(addPeriod('2026-02-28', { unit: 'month', interval: 1 }, 31), '2026-03-31');
  assert.equal(addPeriod('2026-11-22', { unit: 'week', interval: 2 }), '2026-12-06');
});

test('uçtan uca akış', async (t) => {
  t.after(() => server.close());
  assert.equal((await fetch(B + '/api/admin/settings')).status, 401);
  // periyot düzenle
  const s = await j(await fetch(B + '/api/admin/settings', { method: 'PUT', headers: auth, body: JSON.stringify({
    periods: [{ id: 'w1', label: 'Haftalık', unit: 'week', interval: 1 }, { id: 'm1', label: 'Aylık', unit: 'month', interval: 1 }],
    defaultDiscountPercent: 40, salesChannelId: 'sc1', paymentGatewayId: 'pg-kapida' }) }));
  assert.equal(s.periods.length, 2);
  // ürünü aktif et
  await j(await fetch(B + '/api/admin/products/p1', { method: 'PUT', headers: auth, body: JSON.stringify({ enabled: true, periodIds: ['m1'] }) }));
  const cfg = await j(await fetch(B + '/api/public/config?slug=organik-elma-sirkesi'));
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.periods.map((p) => p.id), ['m1']);
  assert.equal(cfg.variants[0].subscriptionPrice, 479.4);
  assert.equal((await j(await fetch(B + '/api/public/config?slug=yok'))).enabled, false);

  const body = { productId: 'p1', periodId: 'm1', quantity: 2, startDate: today(),
    customer: { firstName: 'Ali', lastName: 'Veli', email: 'ali@example.com', phone: '5551112233' },
    address: { addressLine1: 'Cad. 1', city: 'İstanbul', district: 'Kadıköy' } };
  // izin verilmeyen periyot reddedilir
  const bad = await fetch(B + '/api/public/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, periodId: 'w1' }) });
  assert.equal(bad.status, 400);
  // bugün başlayan abonelik -> hemen sipariş
  const r = await j(await fetch(B + '/api/public/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal(r.nextDate, addPeriod(today(), { unit: 'month', interval: 1 }, Number(today().slice(8))));
  const orders = db.prepare('SELECT * FROM orders').all();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].amount, 958.8);
  const subjects = db.prepare('SELECT subject FROM mail_log').all().map((m) => m.subject);
  assert.ok(subjects.some((x) => x.includes('oluşturuldu #')), subjects.join('|'));

  // vadesi gelen abonelik zamanlayıcıyla işlenir, tekrar çalıştırmada çift sipariş olmaz
  db.prepare('UPDATE subscriptions SET next_date = ?').run(addDays(today(), -3));
  assert.equal((await S.runDue()).orders, 1);
  assert.ok(S.getSub('id', 1).next_date > today());
  assert.equal((await S.runDue()).orders, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM orders').get().c, 2);

  // hatırlatma
  db.prepare('UPDATE subscriptions SET next_date = ?').run(addDays(today(), 1));
  assert.equal((await S.runDue()).reminders, 1);
  assert.equal((await S.runDue()).reminders, 0);

  // müşteri yönetim sayfası: iptal
  const token = db.prepare('SELECT token FROM subscriptions').get().token;
  assert.equal((await fetch(`${B}/s/${token}/`)).status, 200);
  const c = await fetch(`${B}/s/${token}/cancel`, { method: 'POST' });
  assert.match(await c.text(), /iptal edildi/);
  db.prepare('UPDATE subscriptions SET next_date = ?').run(today());
  assert.equal((await S.runDue()).orders, 0);
});
