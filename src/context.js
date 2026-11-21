// İstek/iş başına "hangi mağaza" bilgisini taşır (çok mağazalı partner uygulaması).
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/** Panellere yapıştırılan değerlerde kalan boşluk/tırnakları temizler. */
export const env = (k) => String(process.env[k] || '').trim().replace(/^["']|["']$/g, '').trim();

/** Tek mağazalı (özel uygulama) kurulumdaki varsayılan mağaza. */
export const defaultStore = () => env('IKAS_STORE_NAME') || (process.env.IKAS_MOCK === '1' ? 'mock' : '');

export const runInStore = (store, fn) => als.run({ store }, fn);

export function currentStore() {
  const s = als.getStore()?.store ?? defaultStore();
  if (!s) throw new Error('Mağaza belirlenemedi');
  return s;
}

export const isStoreName = (s) => /^[a-z0-9][a-z0-9-]{0,62}$/i.test(String(s || ''));
