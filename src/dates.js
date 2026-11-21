// Tüm tarihler 'YYYY-MM-DD' (Europe/Istanbul) olarak tutulur.
const TZ = process.env.TZ_STORE || 'Europe/Istanbul';

export function today(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const toUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (dt) => dt.toISOString().slice(0, 10);

export function addDays(s, n) {
  const dt = toUTC(s); dt.setUTCDate(dt.getUTCDate() + n); return fmt(dt);
}

/** Ay eklerken ay sonuna sabitler: 31 Ocak + 1 ay = 28/29 Şubat. `anchorDay` ilk teslimatın günüdür. */
export function addPeriod(s, period, anchorDay) {
  const n = Number(period.interval) || 1;
  if (period.unit === 'day') return addDays(s, n);
  if (period.unit === 'week') return addDays(s, n * 7);
  const dt = toUTC(s);
  const day = anchorDay || dt.getUTCDate();
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(y, m, Math.min(day, last))));
}

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(toUTC(s)) === s;

export function trDate(s) {
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(toUTC(s));
}
