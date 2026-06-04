import { chromium } from 'playwright';

const expected = {
  'Bud': '$20.44', '#11': '$55.76', '#10': '$30.26', 'Pool Co.': '$59.99',
  'Ann': '$44.79', '#3': '$26.65', '#2': '$63.74', 'Judy': '$20.44', 'Emily': '$70.95',
};
const readings = {
  'Bud': 0, '#11': 4920, '#10': 2270, 'Pool Co.': 5360, 'Ann': 3780,
  '#3': 1720, '#2': 5750, 'Judy': 0, 'Emily': 6500,
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8080/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// Clear any prior IndexedDB so we start clean, then reload.
await page.evaluate(() => indexedDB.deleteDatabase('WaterBilling'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);

await page.screenshot({ path: 'shot-1-load.png' });
console.log('--- after load, errors:', JSON.stringify(errors));

// Create First Period
await page.click('#btn-first-period');
await page.waitForTimeout(300);
await page.fill('#period-start-date', '2025-12-04');
await page.fill('#period-end-date', '2026-01-03');
await page.screenshot({ path: 'shot-2-dialog.png' });
await page.click('#btn-confirm-period');
await page.waitForTimeout(500);
await page.screenshot({ path: 'shot-3-period.png' });

const periodDates = await page.textContent('#period-dates').catch(() => null);
console.log('--- period dates:', periodDates);

// Enter readings: match by row name -> reading-input in that row
for (const [name, val] of Object.entries(readings)) {
  const handle = await page.evaluateHandle((nm) => {
    const rows = [...document.querySelectorAll('#billing-body tr')];
    const row = rows.find(r => r.querySelector('td')?.textContent.trim() === nm);
    return row ? row.querySelector('input.reading-input') : null;
  }, name);
  const el = handle.asElement();
  if (!el) { console.log('!! no input row for', name); continue; }
  await el.fill(String(val));
  await el.dispatchEvent('input');
  await el.dispatchEvent('change');
}
await page.waitForTimeout(500);
await page.screenshot({ path: 'shot-4-readings.png', fullPage: true });

// Read amounts as the UI shows them right now (first period, start=null)
const firstPass = await page.evaluate(() => {
  const out = {};
  for (const r of document.querySelectorAll('#billing-body tr')) {
    const tds = r.querySelectorAll('td');
    if (tds.length < 5) continue;
    out[tds[0].textContent.trim()] = tds[4].textContent.trim();
  }
  return out;
});
console.log('--- first-pass amounts (start=null):', JSON.stringify(firstPass));

// Wait for the 600ms debounced save to flush end readings to IDB
await page.waitForTimeout(1500);

// Now set startReading=0 for every reading in IDB, reload, re-enter not needed
await page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('WaterBilling', 1);
  open.onsuccess = e => {
    const db = e.target.result;
    const tx = db.transaction('periods', 'readwrite');
    const store = tx.objectStore('periods');
    store.getAll().onsuccess = ev => {
      const periods = ev.target.result;
      for (const p of periods) {
        for (const rd of p.readings) rd.startReading = 0;
        store.put(p);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = ev => reject(ev.target.error);
  };
  open.onerror = e => reject(e.target.error);
}));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: 'shot-4b-start0.png', fullPage: true });

// Read back computed amounts per row
const results = await page.evaluate(() => {
  const out = {};
  for (const r of document.querySelectorAll('#billing-body tr')) {
    const tds = r.querySelectorAll('td');
    if (tds.length < 5) continue;
    out[tds[0].textContent.trim()] = {
      gallons: tds[3].textContent.trim(),
      amount: tds[4].textContent.trim(),
    };
  }
  return out;
});

console.log('\n=== RESULTS ===');
let allPass = true;
for (const [name, exp] of Object.entries(expected)) {
  const got = results[name];
  const amt = got ? got.amount : '(missing)';
  const ok = amt === exp;
  if (!ok) allPass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(9)} gal=${got?got.gallons:'?'}  amount=${amt}  expected=${exp}`);
}

// Test Settings modal: gear -> Rates + Accounts tabs
console.log('\n=== SETTINGS ===');
await page.click('#btn-settings');
await page.waitForTimeout(300);
const dlgOpen = await page.evaluate(() => document.getElementById('settings-dialog').open);
const tabs = await page.$$eval('.dialog-tabs .tab-btn', els => els.map(e => e.textContent.trim()));
console.log('settings dialog open:', dlgOpen, ' tabs:', JSON.stringify(tabs));
await page.screenshot({ path: 'shot-5-settings-rates.png' });
// Click Accounts tab
await page.click('.tab-btn[data-tab="accounts"]');
await page.waitForTimeout(300);
const acctRows = await page.$$eval('#accounts-editor .account-row', els => els.length);
console.log('accounts tab rows:', acctRows);
await page.screenshot({ path: 'shot-6-settings-accounts.png' });

console.log('\n=== ERRORS ===');
console.log(errors.length ? errors.join('\n') : '(none)');
console.log('\nVERDICT:', allPass && errors.length === 0 ? 'PASS' : (allPass ? 'PASS-with-console-errors' : 'FAIL'));

await browser.close();
