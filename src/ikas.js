// ikas Admin GraphQL istemcisi.
// - Partner uygulaması: mağaza başına OAuth (authorization_code + refresh_token), `stores` tablosunda.
// - Özel uygulama (eski kurulum): IKAS_STORE_NAME + IKAS_CLIENT_ID/SECRET ile client_credentials.
// IKAS_MOCK=1 ile ikas'a gitmeden sahte verilerle çalışır (yerel test için).
import { db } from './db.js';
import { env, currentStore, defaultStore } from './context.js';

const MOCK = process.env.IKAS_MOCK === '1';
const API = process.env.IKAS_API_URL || 'https://api.myikas.com/api/v1/admin/graphql';
export const oauthBase = (store) => `https://${store}.myikas.com/api/admin/oauth`;
export const APP_SCOPES = 'read_products,read_orders,write_orders,read_customers,write_customers,write_storefronts';
export const appCreds = () => ({ client_id: env('IKAS_APP_CLIENT_ID'), client_secret: env('IKAS_APP_CLIENT_SECRET') });

export async function tokenRequest(store, body) {
  const res = await fetch(`${oauthBase(store)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ikas token hatası (${store}, ${body.grant_type}): HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const ccCache = new Map(); // client_credentials token önbelleği

async function getToken(store) {
  const row = db.prepare('SELECT * FROM stores WHERE store_name = ? AND uninstalled_at IS NULL').get(store);
  if (row) {
    if (row.access_token && Date.now() < row.expires_at - 60_000) return row.access_token;
    const j = await tokenRequest(store, { grant_type: 'refresh_token', refresh_token: row.refresh_token, ...appCreds() });
    db.prepare('UPDATE stores SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE store_name = ?')
      .run(j.access_token, j.refresh_token || null, Date.now() + (j.expires_in || 14400) * 1000, store);
    return j.access_token;
  }
  if (store !== defaultStore() || !env('IKAS_CLIENT_ID') || !env('IKAS_CLIENT_SECRET')) {
    throw new Error(`"${store}" mağazası için yetki yok; uygulamayı ikas'tan kurun`);
  }
  const c = ccCache.get(store);
  if (c && Date.now() < c.exp - 60_000) return c.token;
  const j = await tokenRequest(store, { grant_type: 'client_credentials', client_id: env('IKAS_CLIENT_ID'), client_secret: env('IKAS_CLIENT_SECRET') });
  ccCache.set(store, { token: j.access_token, exp: Date.now() + (j.expires_in || 14400) * 1000 });
  return j.access_token;
}

export async function gql(query, variables = {}, { token } = {}) {
  if (MOCK) return mock(query, variables);
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || await getToken(currentStore())}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors?.length) {
    const detail = (e) => e.message + (e.extensions ? ' ' + JSON.stringify(e.extensions).slice(0, 600) : '');
    throw new Error(`ikas API: ${j.errors?.map(detail).join('; ') || `HTTP ${res.status}`}`);
  }
  return j.data;
}

const PRODUCT_FIELDS = `id name metaData { slug } variants { id sku isActive
  variantValueIds { variantValueId } prices { sellPrice discountPrice priceListId } }`;

// Varyant değer adları (Renk: Siyah vb.) ayrı sorgudan gelir; 10 dk önbelleklenir.
const vvCache = new Map(); // mağaza -> { at, names }
async function variantValueNames() {
  const store = currentStore(), c = vvCache.get(store);
  if (c && Date.now() - c.at < 600_000) return c.names;
  const d = await gql('{ listVariantType { values { id name } } }');
  const names = new Map(d.listVariantType.flatMap((t) => t.values.map((v) => [v.id, v.name])));
  vvCache.set(store, { at: Date.now(), names });
  return names;
}

function normalizeProduct(p, names) {
  return {
    id: p.id,
    name: p.name,
    slug: (p.metaData?.slug || '').replace(/^\/+/, ''),
    variants: (p.variants || []).filter((v) => v.isActive !== false).map((v) => {
      const pr = v.prices?.find((x) => !x.priceListId) || v.prices?.[0] || {};
      const values = (v.variantValueIds || []).map((x) => names.get(x.variantValueId)).filter(Boolean).join(' / ');
      return { id: v.id, name: values || v.sku || 'Standart', price: pr.discountPrice || pr.sellPrice || 0, listPrice: pr.sellPrice || 0 };
    }),
  };
}

const LIST = `query($p: PaginationInput, $id: StringFilterInput) { listProduct(pagination: $p, id: $id) { count hasNext data { ${PRODUCT_FIELDS} } } }`;

/** ikas API isimde "içerir" araması desteklemediği için arama varsa ürünler sayfalanarak çekilip burada süzülür. */
export async function listProducts({ page = 1, limit = 50, search } = {}) {
  const names = await variantValueNames();
  if (!search) {
    const r = (await gql(LIST, { p: { page, limit } })).listProduct;
    return { count: r.count, hasNext: r.hasNext, data: r.data.map((p) => normalizeProduct(p, names)) };
  }
  const q = search.toLocaleLowerCase('tr'), out = [];
  for (let pg = 1; pg <= 20; pg++) {
    const r = (await gql(LIST, { p: { page: pg, limit: 100 } })).listProduct;
    out.push(...r.data.filter((p) => p.name.toLocaleLowerCase('tr').includes(q)));
    if (!r.hasNext) break;
  }
  return { count: out.length, hasNext: false, data: out.map((p) => normalizeProduct(p, names)) };
}

export async function getProduct(id) {
  const [names, d] = await Promise.all([variantValueNames(), gql(LIST, { id: { eq: id } })]);
  const p = d.listProduct.data[0];
  return p ? normalizeProduct(p, names) : null;
}

export async function listMeta() {
  const out = {};
  const tries = {
    salesChannels: 'listSalesChannel { id name }',
    storefronts: 'listStorefront { id name }',
    paymentGateways: 'listPaymentGateway { id name }',
  };
  for (const [k, q] of Object.entries(tries)) {
    try { out[k] = Object.values(await gql(`{ ${q} }`))[0]; } catch (e) { out[k] = { error: e.message }; }
  }
  return out;
}

export async function createOrder(input) {
  const d = await gql(
    `mutation($input: CreateOrderWithTransactionsInput!) { createOrderWithTransactions(input: $input) { id orderNumber } }`,
    { input },
  );
  return d.createOrderWithTransactions;
}

export async function saveStorefrontScript({ storefrontId, scriptContent }) {
  const d = await gql(
    `mutation($input: StorefrontJSScriptInput!) { saveStorefrontJSScript(input: $input) { id } }`,
    { input: { name: 'Abonelik Modülü', contentType: 'SCRIPT', storefrontId, scriptContent, isHighPriority: false } },
  );
  return d.saveStorefrontJSScript;
}

// ---------- Mock ----------
const MOCK_PRODUCTS = [
  { id: 'p1', name: 'Organik Elma Sirkesi 500 ml', metaData: { slug: 'organik-elma-sirkesi' },
    variants: [{ id: 'v1', sku: 'ES500', variantValueIds: [], prices: [{ sellPrice: 799, currency: 'TRY' }] }] },
  { id: 'p2', name: 'Ev Yapımı Kombucha', metaData: { slug: 'kombucha' },
    variants: [
      { id: 'v2a', sku: 'KB-ZEN', variantValueIds: [{ variantValueId: 'zen' }], prices: [{ sellPrice: 250, currency: 'TRY' }] },
      { id: 'v2b', sku: 'KB-SADE', variantValueIds: [{ variantValueId: 'sade' }], prices: [{ sellPrice: 300, discountPrice: 220, currency: 'TRY' }] },
    ] },
];
let mockOrderNo = 1000;
function mock(query, v) {
  if (query.includes('getMerchant')) return { getMerchant: { id: 'mock-merchant', storeName: 'mock' }, me: { id: 'mock-app' } };
  if (query.includes('createOrderWithTransactions')) {
    if (process.env.IKAS_MOCK_FAIL === '1') throw new Error('mock: sipariş oluşturulamadı');
    mockOrderNo++;
    return { createOrderWithTransactions: { id: `mock-order-${mockOrderNo}`, orderNumber: String(mockOrderNo) } };
  }
  if (query.includes('saveStorefrontJSScript')) return { saveStorefrontJSScript: { id: 'mock-script' } };
  if (query.includes('listSalesChannel')) return { listSalesChannel: [{ id: 'sc1', name: 'Web' }] };
  if (query.includes('listStorefront')) return { listStorefront: [{ id: 'sf1', name: 'Mağaza' }] };
  if (query.includes('listPaymentGateway')) return { listPaymentGateway: [{ id: 'pg-kapida', name: 'Kapıda Ödeme' }, { id: 'pg-havale', name: 'Havale/EFT' }] };
  if (query.includes('listVariantType')) return { listVariantType: [{ values: [{ id: 'zen', name: 'Zencefilli' }, { id: 'sade', name: 'Sade' }] }] };
  if (query.includes('listProduct')) {
    let data = MOCK_PRODUCTS;
    if (v.id?.eq) data = data.filter((p) => p.id === v.id.eq);
    return { listProduct: { count: data.length, hasNext: false, data } };
  }
  throw new Error('mock: bilinmeyen sorgu');
}
