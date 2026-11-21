// Mail gönderimi.
// MAIL_MODE=ikas : ikas'ın kendi sipariş mailine güvenilir, modül yalnızca hatırlatma/hoş geldin
//                  maillerini (SMTP varsa) gönderir; sipariş maili gönderilmez.
// MAIL_MODE=smtp : (varsayılan) sipariş maili dahil tüm mailler SMTP ile gönderilir.
// SMTP tanımlı değilse mailler gönderilmez, panelde "Mail Kutusu"nda görüntülenir (status=logged).
import nodemailer from 'nodemailer';
import { db, getSettings } from './db.js';
import { trDate } from './dates.js';
import { currentStore } from './context.js';

const MODE = process.env.MAIL_MODE || 'smtp';
const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === '1',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tl = (n) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(n);
const manageUrl = (sub) => `${process.env.PUBLIC_URL || 'http://localhost:3000'}/s/${sub.token}`;

async function send(to, subject, html) {
  let status = 'logged', error = null;
  if (transport) {
    try {
      await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html });
      status = 'sent';
    } catch (e) { status = 'failed'; error = e.message; }
  }
  db.prepare('INSERT INTO mail_log (store, recipient, subject, html, status, error) VALUES (?, ?, ?, ?, ?, ?)').run(currentStore(), to, subject, html, status, error);
  if (status === 'failed') console.error('[mail] gönderilemedi:', to, error);
  return status;
}

function layout(title, body) {
  const { storeName } = getSettings();
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#222">
  <h2 style="color:#2f6b3a">${esc(title)}</h2>${body}
  <p style="color:#888;font-size:12px;margin-top:32px">${esc(storeName)} · Düzenli Teslimat</p></div>`;
}

function summary(sub, extra = '') {
  return `<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <tr><td style="padding:6px 0;color:#666">Ürün</td><td><b>${esc(sub.product_name)}</b>${sub.variant_name ? ' – ' + esc(sub.variant_name) : ''} × ${sub.quantity}</td></tr>
  <tr><td style="padding:6px 0;color:#666">Periyot</td><td>${esc(sub.period.label)}</td></tr>
  <tr><td style="padding:6px 0;color:#666">Sonraki teslimat</td><td>${trDate(sub.next_date)}</td></tr>${extra}</table>`;
}

const button = (sub, label = 'Aboneliğimi Yönet') =>
  `<p><a href="${manageUrl(sub)}" style="background:#2f6b3a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${label}</a></p>`;

export function sendWelcome(sub) {
  return send(sub.customer.email, 'Düzenli teslimat aboneliğiniz oluşturuldu',
    layout(`Merhaba ${sub.customer.firstName},`, `<p>Düzenli teslimat aboneliğiniz başarıyla oluşturuldu.</p>${summary(sub)}
    <p>Kartınız saklanmaz. Her teslimat gününde siparişiniz otomatik oluşturulur ve size bilgi verilir.
    Dilediğiniz zaman teslimatı erteleyebilir veya aboneliği iptal edebilirsiniz.</p>${button(sub)}`));
}

export function sendReminder(sub) {
  return send(sub.customer.email, `Hatırlatma: siparişiniz ${trDate(sub.next_date)} tarihinde oluşturulacak`,
    layout(`Merhaba ${sub.customer.firstName},`, `<p>Düzenli teslimat siparişiniz yakında oluşturulacak.</p>${summary(sub)}
    <p>Bu teslimatı atlamak, tarihi ertelemek veya aboneliği iptal etmek için:</p>${button(sub)}`));
}

export function sendOrderCreated(sub, order) {
  if (MODE === 'ikas') return Promise.resolve('skipped');
  return send(sub.customer.email, `Siparişiniz oluşturuldu #${order.order_number || order.ikas_order_id}`,
    layout(`Merhaba ${sub.customer.firstName},`, `<p>Düzenli teslimat aboneliğiniz kapsamında siparişiniz oluşturuldu.</p>
    ${summary(sub, `<tr><td style="padding:6px 0;color:#666">Sipariş no</td><td>#${esc(order.order_number || order.ikas_order_id)}</td></tr>
    <tr><td style="padding:6px 0;color:#666">Tutar</td><td><b>${tl(order.amount)}</b></td></tr>`)}
    ${button(sub)}`));
}

export function sendCancelled(sub) {
  return send(sub.customer.email, 'Aboneliğiniz iptal edildi',
    layout(`Merhaba ${sub.customer.firstName},`, `<p><b>${esc(sub.product_name)}</b> için düzenli teslimat aboneliğiniz iptal edildi. Yeni sipariş oluşturulmayacak.</p>`));
}

export function sendTest(to) {
  return send(to, 'Abonelik modülü test maili', layout('Test maili', '<p>Bu mail geldiyse SMTP ayarlarınız çalışıyor.</p>'));
}

export const smtpConfigured = () => Boolean(transport);

export function sendAdminAlert(subject, text) {
  if (!process.env.ADMIN_EMAIL) return Promise.resolve('skipped');
  return send(process.env.ADMIN_EMAIL, `[Abonelik] ${subject}`, layout(subject, `<p>${esc(text)}</p>`));
}
