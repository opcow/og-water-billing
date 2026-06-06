export function calcBill(gal, rateTable) {
  const minCharge = rateTable[0][3] ?? 0;
  let total = minCharge;
  let remaining = gal;
  for (const [bracket, rate, unit] of rateTable) {
    if (bracket === '-' || remaining <= bracket) {
      total += (remaining * rate) / unit;
      break;
    }
    total += (bracket * rate) / unit;
    remaining -= bracket;
  }
  // Round to 4 decimal places first to eliminate floating-point noise,
  // then ceiling to nearest cent (matches Google Sheets ROUNDUP behaviour).
  return Math.ceil(Math.round(total * 10000) / 100) / 100;
}

export function getGallons(reading, normFactor) {
  if (reading.startReading == null || reading.endReading == null) return null;
  const raw = Math.max(0, reading.endReading - reading.startReading);
  if (!normFactor || normFactor === 1) return raw;
  return Math.floor(raw * normFactor / 10) * 10;
}

export function newPeriod(prevPeriod, accounts, rateTable) {
  const billingDay = rateTable[0][4] ?? 3;
  const prevEnd = parseLocalDate(prevPeriod.endDate);

  const startDate = new Date(prevEnd);
  startDate.setDate(startDate.getDate() + 1);

  const endDate = new Date(prevEnd);
  endDate.setMonth(endDate.getMonth() + 1);
  endDate.setDate(billingDay);

  const prevMap = new Map((prevPeriod.readings || []).map(r => [r.accountId, r.endReading]));

  return {
    name: monthLabel(endDate),
    startDate: toDateStr(startDate),
    endDate: toDateStr(endDate),
    rateTableSnapshot: JSON.parse(JSON.stringify(rateTable)),
    readings: accounts.map(a => {
      const start = prevMap.get(a.id) ?? null;
      return {
        accountId: a.id,
        startReading: start,
        endReading: a.meterDefective ? start : null,
      };
    }),
    normalizationFactor: null,
  };
}

export function normalizePeriod(period, readingDay, billingDay) {
  const [ey, em] = period.endDate.split('-').map(Number);
  const readingDate   = new Date(ey, em - 1, readingDay);
  const start         = parseLocalDate(period.startDate);
  const actualDays    = Math.round((readingDate - start) / 86400000);
  if (actualDays <= 0) return period;

  // Standard period: billing day of previous month → billing day of current month
  const expectedEnd   = new Date(ey, em - 1, billingDay);
  const expectedStart = new Date(ey, em - 2, billingDay);
  const expectedDays  = Math.round((expectedEnd - expectedStart) / 86400000);

  return { ...period, normalizationFactor: expectedDays / actualDays, readingDay };
}

const DEFAULT_SMS_TEMPLATE = 'Water Bill — {period}\n{holder}: {gallons}\nTotal: {amount}';

export function buildSMSBody(account, reading, period, template) {
  const g = getGallons(reading, period.normalizationFactor);
  const amount = calcBill(g ?? 0, period.rateTableSnapshot);
  const galStr = g != null ? g.toLocaleString() + ' gal' : 'no reading';
  const dueDay = period.rateTableSnapshot[0][5] ?? 20;
  const [ey, em] = period.endDate.split('-').map(Number);
  const due = new Date(ey, em - 1, dueDay);
  const dueStr = `${String(due.getMonth()+1).padStart(2,'0')}/${String(due.getDate()).padStart(2,'0')}/${due.getFullYear()}`;
  const startStr = reading.startReading != null ? String(reading.startReading) : '—';
  const endStr   = reading.endReading   != null ? String(reading.endReading)   : '—';
  return (template || DEFAULT_SMS_TEMPLATE)
    .replace(/\{period\}/g,  period.name)
    .replace(/\{name\}/g,    account.name)
    .replace(/\{holder\}/g,  account.accountHolder || account.name)
    .replace(/\{gallons\}/g, galStr)
    .replace(/\{amount\}/g,  '$' + amount.toFixed(2))
    .replace(/\{due\}/g,     dueStr)
    .replace(/\{start\}/g,   startStr)
    .replace(/\{end\}/g,     endStr);
}

export { DEFAULT_SMS_TEMPLATE };

export function formatCurrency(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatNumber(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocalDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function monthLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
