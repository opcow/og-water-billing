import { calcBill, getGallons, formatCurrency, formatDate, formatNumber, DEFAULT_SMS_TEMPLATE } from './billing.js?v=a53e87cc';

// ── Helpers ───────────────────────────────────────────────────────────────────

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Period selector ───────────────────────────────────────────────────────────

export function renderPeriodPicker(periods, selectedId) {
  const selected = periods.find(p => p.id === selectedId);
  document.getElementById('btn-period-picker').textContent =
    (selected ? selected.name : '—') + ' ▾';
}

export function renderPeriodPopover(periods, selectedId, viewYear) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  const byMonth = new Map();
  for (const p of periods) {
    const [y, m] = p.endDate.split('-');
    if (Number(y) === viewYear) byMonth.set(Number(m), p);
  }
  const selected = periods.find(p => p.id === selectedId);
  const selYear  = selected ? Number(selected.endDate.slice(0, 4)) : null;
  const selMonth = selected ? Number(selected.endDate.slice(5, 7)) : null;

  const years = [...new Set(periods.map(p => Number(p.endDate.slice(0, 4))))].sort();
  document.getElementById('popover-year-label').textContent = viewYear;
  document.getElementById('popover-prev-year').disabled = viewYear <= years[0];
  document.getElementById('popover-next-year').disabled = viewYear >= years[years.length - 1];

  document.getElementById('popover-month-grid').innerHTML = MONTHS.map((label, i) => {
    const month  = i + 1;
    const period = byMonth.get(month);
    const active = viewYear === selYear && month === selMonth;
    return `<button class="popover-month${active ? ' active' : ''}"
      data-period-id="${period?.id ?? ''}"
      ${period ? '' : 'disabled'}>${label}</button>`;
  }).join('');
}

// ── Billing table ─────────────────────────────────────────────────────────────

// Build the period's content as HTML strings (no DOM writes). Shared by the live
// renderer and by buildGhost so a swipe's incoming neighbor matches exactly.
export function renderPeriodHTML(period, accounts, masterMeter, sortConfig = { column: null, dir: 'asc' }, lockStartReadings = false, showMasterSection = true) {
  if (!period) return { datesHTML: '', bodyHTML: '', footHTML: '', masterHTML: '', showMaster: false };

  const normBadge = period.normalizationFactor && period.normalizationFactor !== 1
    ? `<span class="prorated-badge">Prorated</span>`
    : '';
  const datesHTML = `${formatDate(period.startDate)} – ${formatDate(period.endDate)}${normBadge}`;

  const readMap = new Map((period.readings || []).map(r => [r.accountId, r]));
  const sorted  = applySortConfig(accounts, period, readMap, sortConfig);
  const bodyHTML = sorted.map(a => rowHTML(a, readMap.get(a.id), period, lockStartReadings)).join('');
  const footHTML = totalsHTML(period, accounts, readMap);

  const showMaster = !!(showMasterSection && masterMeter);
  const masterHTML = showMaster ? rowHTML(masterMeter, period.masterReading, period, lockStartReadings) : '';

  return { datesHTML, bodyHTML, footHTML, masterHTML, showMaster };
}

export function renderPeriod(period, accounts, masterMeter, sortConfig = { column: null, dir: 'asc' }, lockStartReadings = false, showMasterSection = true) {
  const { datesHTML, bodyHTML, footHTML, masterHTML, showMaster } =
    renderPeriodHTML(period, accounts, masterMeter, sortConfig, lockStartReadings, showMasterSection);

  document.getElementById('period-dates').innerHTML = datesHTML;
  document.getElementById('billing-body').innerHTML = bodyHTML;
  document.getElementById('billing-foot').innerHTML = footHTML;
  updateSortIndicators(sortConfig);

  const masterSection = document.getElementById('master-section');
  masterSection.hidden = !showMaster;
  if (showMaster) document.getElementById('master-body').innerHTML = masterHTML;
}

// A static, non-interactive snapshot of an adjacent period, cloned from the live
// pane so structure/header/styling match. IDs are stripped so it can't collide
// with the live pane's getElementById lookups. Removed after the swipe gesture.
export function buildGhost(period, accounts, masterMeter, sortConfig, lockStartReadings, showMasterSection) {
  const ghost = document.getElementById('period-view').cloneNode(true);
  ghost.classList.add('period-ghost');
  ghost.hidden = false;
  ghost.removeAttribute('id');
  ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

  const { bodyHTML, footHTML, masterHTML, showMaster } =
    renderPeriodHTML(period, accounts, masterMeter, sortConfig, lockStartReadings, showMasterSection);

  // The header (incl. .period-dates) is now fixed outside #period-view, so the
  // ghost clone has none — only the table/master content slides.
  const billingTable = ghost.querySelector('.billing-table');
  billingTable.querySelector('tbody').innerHTML = bodyHTML;
  billingTable.querySelector('tfoot').innerHTML = footHTML;

  const masterSection = ghost.querySelector('.master-section');
  if (masterSection) {
    masterSection.hidden = !showMaster;
    if (showMaster) masterSection.querySelector('tbody').innerHTML = masterHTML;
  }
  return ghost;
}

function applySortConfig(list, period, readMap, { column, dir }) {
  if (!column) return list;
  return [...list].sort((a, b) => {
    const va = sortVal(a, column, period, readMap);
    const vb = sortVal(b, column, period, readMap);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;   // nulls (no reading) always last
    if (vb == null) return -1;
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
}

function sortVal(account, column, period, readMap) {
  if (column === 'name') return account.name.toLowerCase();
  const r = readMap.get(account.id);
  const g = r ? getGallons(r) : null;
  if (column === 'gallons') return account.meterDefective ? null : g;
  return accountAmount(account, g, period);
}

function updateSortIndicators({ column, dir }) {
  document.querySelectorAll('#billing-table thead th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === column) {
      th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function isBadReading(reading) {
  return reading?.startReading != null && reading?.endReading != null
    && reading.endReading < reading.startReading;
}

const BAD_READING_TITLE = 'End reading is less than start reading';

// Must match periodAmount in app.js and buildSMSBody in billing.js: a fixed
// charge overrides everything; otherwise at least the base charge is owed,
// so this never returns null. A defective meter's readings don't count.
function accountAmount(account, g, period) {
  if (account?.fixedCharge != null) return account.fixedCharge;
  if (account?.meterDefective) g = null;
  return calcBill(g ?? 0, period.rateTableSnapshot);
}

function rowHTML(account, reading, period, lockStartReadings) {
  const g      = reading ? getGallons(reading) : null;
  const bad    = isBadReading(reading);
  const amount = accountAmount(account, g, period);
  const startV = reading?.startReading ?? '';
  const endV   = reading?.endReading ?? '';
  const amtClass = `num col-amt${account.phone && account.id !== 0 ? ' sms-trigger' : ''}${reading?.smsSentAt ? ' sms-sent' : ''}`;
  const amtData  = ` data-account-id="${account.id}"`;

  const defClass = account.meterDefective ? ' col-defective' : '';
  const disabledAttr = account.meterDefective ? ' disabled' : '';

  const startCell = lockStartReadings
    ? `<td class="num col-start${defClass}">${startV !== '' ? startV : '—'}</td>`
    : `<td class="num col-start${defClass}" style="padding:4px 14px">
        <input type="number" inputmode="numeric" class="reading-input start-reading-input"
          data-account-id="${account.id}"
          data-field="start"
          value="${startV !== '' ? startV : ''}"
          placeholder="—"
          min="0"${disabledAttr}>
      </td>`;

  return `
    <tr data-account-id="${account.id}">
      <td class="col-name" data-account-id="${account.id}">${esc(account.name)}</td>
      ${startCell}
      <td class="num col-end${defClass}" style="padding:4px 14px">
        <input type="number" inputmode="numeric" class="reading-input"
          data-account-id="${account.id}"
          data-field="end"
          value="${endV !== '' ? endV : ''}"
          placeholder="—"
          min="0"${disabledAttr}>
      </td>
      <td class="num col-gal${defClass}${!account.meterDefective && bad ? ' usage-warning' : ''}" id="gal-${account.id}"${!account.meterDefective && bad ? ` title="${BAD_READING_TITLE}"` : ''}>${account.meterDefective ? '—' : (g != null ? formatNumber(g) : '—')}</td>
      <td class="${amtClass}" id="amt-${account.id}"${amtData}>${formatCurrency(amount)}</td>
    </tr>`;
}

export function updateRow(accountId, period, accounts) {
  const reading = period.readings.find(r => r.accountId === accountId);
  if (!reading) return;
  const account = accounts?.find(a => a.id === accountId);
  const g      = getGallons(reading);
  const amount = accountAmount(account, g, period);
  const galEl  = document.getElementById(`gal-${accountId}`);
  const amtEl  = document.getElementById(`amt-${accountId}`);
  if (galEl) {
    const defective = !!account?.meterDefective;
    galEl.textContent = defective ? '—' : (g != null ? formatNumber(g) : '—');
    const bad = !defective && isBadReading(reading);
    galEl.classList.toggle('usage-warning', bad);
    galEl.title = bad ? BAD_READING_TITLE : '';
  }
  if (amtEl) {
    amtEl.textContent = formatCurrency(amount);
    amtEl.classList.toggle('sms-sent', !!reading.smsSentAt);
  }
}

export function updateMasterRow(period, masterMeter) {
  const reading = period.masterReading;
  if (!reading) return;
  const g      = getGallons(reading);
  const amount = accountAmount(masterMeter, g, period);
  const galEl  = document.getElementById('gal-0');
  const amtEl  = document.getElementById('amt-0');
  if (galEl) {
    const defective = !!masterMeter?.meterDefective;
    galEl.textContent = defective ? '—' : (g != null ? formatNumber(g) : '—');
    const bad = !defective && isBadReading(reading);
    galEl.classList.toggle('usage-warning', bad);
    galEl.title = bad ? BAD_READING_TITLE : '';
  }
  if (amtEl) {
    amtEl.textContent = formatCurrency(amount);
    amtEl.classList.toggle('sms-sent', !!reading.smsSentAt);
  }
}

export function updateTotals(period, accounts) {
  const readMap = new Map((period.readings || []).map(r => [r.accountId, r]));
  renderTotals(period, accounts, readMap);
}

function totalsHTML(period, nonMaster, readMap) {
  let totalGal = 0, totalAmt = 0;
  const hasAny = nonMaster.length > 0;
  for (const a of nonMaster) {
    const r = readMap.get(a.id);
    const g = r ? getGallons(r) : null;
    totalAmt += accountAmount(a, g, period);
    if (!a.meterDefective) totalGal += g ?? 0;
  }
  return `
    <tr class="totals-row">
      <td><strong>Total</strong></td>
      <td class="col-start"></td>
      <td class="col-end"></td>
      <td class="num col-gal">${hasAny ? formatNumber(totalGal) : '—'}</td>
      <td class="num col-amt">${hasAny ? formatCurrency(totalAmt) : '—'}</td>
    </tr>`;
}

// ── Settings modal ────────────────────────────────────────────────────────────

export function renderSettings(rateTable, accounts, masterMeter, hasPeriod, fileHandle = null, githubConfig = null, smsTemplate = null, maxSheets = 12, showMasterSection = true) {
  const baseCharge  = rateTable?.[0]?.[3] ?? 0;
  const billingDay  = rateTable?.[0]?.[4] ?? 3;
  const dueDay      = rateTable?.[0]?.[5] ?? 20;
  document.getElementById('base-charge').value  = baseCharge;
  document.getElementById('billing-day').value  = billingDay;
  document.getElementById('due-day').value       = dueDay;
  document.getElementById('show-master-section').checked = !!showMasterSection;

  renderRateTiers(rateTable);
  renderAccountsEditor(accounts);
  renderDataTab(hasPeriod, fileHandle, githubConfig, maxSheets);
  renderMessagesTab(smsTemplate, hasPeriod);
  switchTab('accounts');
}

export function renderDataTab(hasPeriod, fileHandle = null, githubConfig = null, maxSheets = 12) {
  const hasFileAPI = 'showSaveFilePicker' in window;
  const fileSection = hasFileAPI ? `
    <div class="data-section">
      <h3 class="data-section-title">Data File</h3>
      <p class="data-desc" style="margin-bottom:10px">
        Link a file on your computer. Changes save automatically — copy it anywhere for backup or restore on a new device.
      </p>
      ${fileHandle
        ? `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
             <span style="font-size:13px">📄 ${fileHandle.name}</span>
             <button id="btn-unlink-data-file" class="btn btn-secondary" style="font-size:12px;padding:4px 10px">Unlink</button>
           </div>`
        : `<button id="btn-link-data-file" class="btn btn-secondary">Link data file…</button>`
      }
    </div>` : '';

  const githubSection = `
    <div class="data-section">
      <h3 class="data-section-title">Sync</h3>
      <p class="data-desc" style="margin-bottom:10px">
        Enter the sync URL and key provided by your administrator.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <label style="font-size:13px">Sync Key
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
            <input type="text" id="sync-key" class="masked"
                   value="${esc(githubConfig?.key || '')}"
                   placeholder="passphrase"
                   autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                   style="width:100%;flex:1">
            <button id="btn-toggle-sync-key" aria-label="Toggle sync key visibility" title="Show key" style="background:none;border:1px solid var(--border);border-radius:var(--radius);width:32px;height:32px;cursor:pointer;color:var(--muted);display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
        </label>
        <button id="btn-show-qr" class="btn btn-secondary"${githubConfig?.key ? '' : ' hidden'} style="font-size:13px">QR Code</button>
      </div>
      <p class="data-desc" style="margin-top:8px;font-size:11px">
        Save these settings, then use the ↕ Sync button in the header.
      </p>
    </div>`;

  const historySection = `
    <div class="data-section">
      <h3 class="data-section-title">History</h3>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px">
        Keep at most
        <input type="number" id="max-sheets" value="${maxSheets}" min="3" max="120" step="1"
          style="width:64px;padding:5px 8px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px">
        months
      </label>
      <p class="data-desc" style="margin-top:8px">
        When a new sheet is created and this limit is exceeded, the oldest sheets are removed automatically. Range: 3–120.
      </p>
    </div>`;

  document.getElementById('tab-data').innerHTML = historySection + fileSection + githubSection + `
    <div class="data-section">
      <h3 class="data-section-title">Export</h3>
      <div class="data-actions">
        <div class="data-action">
          <button id="btn-export-period" class="btn btn-secondary" ${hasPeriod ? '' : 'disabled'}>
            Download Current Period
          </button>
          <span class="data-desc">Active billing sheet as XLSX (opens in Excel / LibreOffice)</span>
        </div>
        <div class="data-action">
          <button id="btn-export-all" class="btn btn-secondary">
            Download All Periods
          </button>
          <span class="data-desc">Full billing history — one sheet per period</span>
        </div>
        <div class="data-action">
          <button id="btn-export-backup" class="btn btn-secondary">
            Download Backup (JSON)
          </button>
          <span class="data-desc">Complete data backup for moving to another device</span>
        </div>
      </div>
    </div>

    <div class="data-section">
      <h3 class="data-section-title">Import</h3>
      <p class="data-desc" style="margin-bottom:10px">
        Import a single billing sheet from a backup file, or restore everything.
      </p>
      <div class="data-actions">
        <div class="data-action">
          <button id="btn-import-period" class="btn btn-secondary">Import from Backup…</button>
          <span class="data-desc">Choose a backup JSON, then pick a period or restore all data</span>
        </div>
      </div>
      <div id="import-period-ui" style="margin-top:12px" hidden></div>
    </div>

    <div class="data-section">
      <h3 class="data-section-title">Restore Backup</h3>
      <div class="import-warning">
        ⚠ Restoring a backup replaces <strong>all</strong> current data — accounts, periods, and rates.
      </div>
      <div class="data-actions" style="margin-top:10px">
        <div class="data-action">
          <button id="btn-import-backup" class="btn btn-danger">
            Restore from Backup (JSON)…
          </button>
          <span class="data-desc">Select a previously downloaded backup file</span>
        </div>
      </div>
    </div>

    <div class="data-section">
      <h3 class="data-section-title">Reset App</h3>
      <div class="import-warning">
        ⚠ This clears all local data (periods, accounts, rates). Sync data on GitHub is preserved — you can restore it after resetting.
      </div>
      <div class="data-actions" style="margin-top:10px">
        <div class="data-action">
          <button id="btn-reset-app" class="btn btn-danger">Reset app to first run</button>
          <span class="data-desc">Clear all local data and restart</span>
        </div>
      </div>
    </div>`;
}

export function renderMessagesTab(template, hasPeriod = false) {
  document.getElementById('tab-messages').innerHTML = `
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px">
      Customize the SMS message sent when you tap a bill amount. Available placeholders:
    </p>
    <table style="font-size:12px;margin-bottom:14px;border-collapse:collapse">
      <tr><td style="padding:2px 12px 2px 0;color:var(--blue);font-family:monospace">{period}</td><td style="color:var(--muted)">Billing period (e.g. Jun 2026)</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:var(--blue);font-family:monospace">{name}</td><td style="color:var(--muted)">Account name (e.g. #11)</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:var(--blue);font-family:monospace">{holder}</td><td style="color:var(--muted)">Account holder name (falls back to account name)</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:var(--blue);font-family:monospace">{gallons}</td><td style="color:var(--muted)">Usage (e.g. 4,920 gal)</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:var(--blue);font-family:monospace">{amount}</td><td style="color:var(--muted)">Amount due (e.g. $55.76)</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:var(--blue);font-family:monospace">{due}</td><td style="color:var(--muted)">Payment due date (MM/DD/YYYY)</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:var(--blue);font-family:monospace">{start}</td><td style="color:var(--muted)">Start meter reading</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:var(--blue);font-family:monospace">{end}</td><td style="color:var(--muted)">End meter reading</td></tr>
    </table>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:14px">
      Template
      <textarea id="sms-template" rows="4"
        style="display:block;width:100%;margin-top:6px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);font-family:monospace;font-size:13px;resize:vertical;line-height:1.5"
      >${esc(template || DEFAULT_SMS_TEMPLATE)}</textarea>
    </label>
    <button id="btn-reset-template" class="btn btn-secondary" style="margin-bottom:8px">Reset to default</button>
    <button id="btn-clear-sms-sent" class="btn btn-secondary" ${hasPeriod ? '' : 'disabled'}
      style="margin-bottom:16px">Clear sent status for this sheet</button>
    <p style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Preview</p>
    <pre id="sms-preview" style="font-size:13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;white-space:pre-wrap;line-height:1.5;margin:0"></pre>`;

  updateSMSPreview();
  document.getElementById('sms-template').addEventListener('input', updateSMSPreview);
  document.getElementById('btn-reset-template').addEventListener('click', () => {
    document.getElementById('sms-template').value = DEFAULT_SMS_TEMPLATE;
    updateSMSPreview();
  });
}

function updateSMSPreview() {
  const tmpl = document.getElementById('sms-template')?.value ?? '';
  const preview = document.getElementById('sms-preview');
  if (!preview) return;
  preview.textContent = tmpl
    .replace(/\{period\}/g,  'Jun 2026')
    .replace(/\{name\}/g,    '#11')
    .replace(/\{holder\}/g,  'Jane Smith')
    .replace(/\{gallons\}/g, '4,920 gal')
    .replace(/\{amount\}/g,  '$55.76')
    .replace(/\{due\}/g,     '06/20/2026')
    .replace(/\{start\}/g,  '12345')
    .replace(/\{end\}/g,    '17265');
}

// Storage keeps tier *widths* (gs_billing-compatible), but the editor shows
// cumulative upper bounds so the table reads like the city's published one:
// "First 2,000 · 2,001 – 6,999 · 7,000+".
function renderRateTiers(rateTable) {
  const tbody = document.getElementById('rate-table-body');
  // All but the last row are editable tiers; the last row (bracket === '-') is the final tier.
  const tiers   = rateTable.slice(0, -1);
  const lastRow = rateTable[rateTable.length - 1];

  let bound = 0;
  tbody.innerHTML = tiers.map((row, i) => {
    bound += row[0];
    return `
    <tr class="tier-row" data-index="${i}">
      <td><span class="tier-range-wrap"><span class="tier-range-prefix"></span><input type="number" class="tier-bound" value="${bound}" min="1" placeholder="gallons"></span></td>
      <td><input type="number" class="tier-rate"    value="${row[1]}" min="0" step="0.01" placeholder="0.00"></td>
      <td><input type="number" class="tier-unit"    value="${row[2]}" min="1" placeholder="1000"></td>
      <td><button class="btn btn-danger btn-sm remove-tier" style="padding:3px 8px;font-size:12px">×</button></td>
    </tr>`;
  }).join('') + `
    <tr class="tier-row final-row">
      <td class="final-tier"></td>
      <td><input type="number" class="tier-rate" value="${lastRow[1]}" min="0" step="0.01" placeholder="0.00"></td>
      <td><input type="number" class="tier-unit" value="${lastRow[2]}" min="1" placeholder="1000"></td>
      <td></td>
    </tr>`;
  updateTierLabels();
}

// Recomputes the "2,001 –" prefixes and the final "7,000+" label from the
// current upper-bound inputs. Called on render and whenever a bound changes.
export function updateTierLabels() {
  const tbody = document.getElementById('rate-table-body');
  if (!tbody) return;
  let prev = 0;
  tbody.querySelectorAll('.tier-row:not(.final-row)').forEach((row, i) => {
    row.querySelector('.tier-range-prefix').textContent =
      i === 0 ? 'First' : `${(prev + 1).toLocaleString('en-US')} –`;
    const bound = parseInt(row.querySelector('.tier-bound')?.value, 10);
    if (bound > prev) prev = bound;
  });
  const finalCell = tbody.querySelector('.final-row .final-tier');
  if (finalCell) {
    finalCell.textContent = prev > 0
      ? `${(prev + 1).toLocaleString('en-US')}+ (all remaining)`
      : 'All gallons';
  }
}

export function addRateTierRow() {
  const tbody   = document.getElementById('rate-table-body');
  const finalRow = tbody.querySelector('.final-row');
  const newRow  = document.createElement('tr');
  newRow.className = 'tier-row';
  const idx = tbody.querySelectorAll('.tier-row:not(.final-row)').length;
  newRow.dataset.index = idx;
  newRow.innerHTML = `
    <td><span class="tier-range-wrap"><span class="tier-range-prefix"></span><input type="number" class="tier-bound" value="" min="1" placeholder="gallons"></span></td>
    <td><input type="number" class="tier-rate"    value="" min="0" step="0.01" placeholder="0.00"></td>
    <td><input type="number" class="tier-unit"    value="1000" min="1" placeholder="1000"></td>
    <td><button class="btn btn-danger btn-sm remove-tier" style="padding:3px 8px;font-size:12px">×</button></td>`;
  tbody.insertBefore(newRow, finalRow);
  updateTierLabels();
}

function renderAccountsEditor(accounts) {
  const container = document.getElementById('accounts-editor');
  container.innerHTML = `
    <div class="acc-header">
      <span></span>
      <span>Unit / Name</span><span>Account Holder</span><span></span>
    </div>
    ${accounts.map(a => accountRowHTML(a)).join('')}`;
  initDragSort(container);
}

function accountRowHTML(a) {
  return `
    <div class="account-row" data-id="${a.id ?? ''}">
      <div class="acc-primary">
        <span class="drag-handle" draggable="true" title="Drag to reorder"></span>
        <input type="text"  class="acc-name"   value="${esc(a.name)}"            placeholder="Unit / account name">
        <input type="text"  class="acc-holder" value="${esc(a.accountHolder ?? '')}" placeholder="Account holder name">
        <button class="btn btn-danger btn-sm remove-account" style="padding:3px 8px;font-size:12px">×</button>
      </div>
      <div class="acc-secondary">
        <input type="tel" class="acc-phone" value="${esc(a.phone ?? '')}" placeholder="Phone (optional)" style="width:130px">
        <input type="number" class="acc-fixed-charge" value="${a.fixedCharge != null ? a.fixedCharge : ''}" placeholder="$ fixed" min="0" step="0.01" style="width:90px">
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;color:var(--text)">
          <input type="checkbox" class="acc-defective"${a.meterDefective ? ' checked' : ''} style="width:auto;margin:0">
          meter defective
        </label>
      </div>
    </div>`;
}

export function addAccountRow() {
  const container = document.getElementById('accounts-editor');
  const div = document.createElement('div');
  div.innerHTML = accountRowHTML({ id: undefined, name: '', accountHolder: '', phone: '', meterDefective: false, fixedCharge: null });
  container.appendChild(div.firstElementChild);
}

function initDragSort(container) {
  let dragSrc = null;

  container.addEventListener('dragstart', e => {
    if (!e.target.matches('.drag-handle')) return;
    dragSrc = e.target.closest('.account-row');
    dragSrc.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // required for Firefox
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    const target = e.target.closest('.account-row');
    if (!target || target === dragSrc) return;
    clearDragOver(container);
    const mid = target.getBoundingClientRect().top + target.offsetHeight / 2;
    target.classList.add(e.clientY < mid ? 'drag-over-top' : 'drag-over-bottom');
  });

  container.addEventListener('dragleave', e => {
    if (!e.relatedTarget?.closest?.('#accounts-editor')) clearDragOver(container);
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('.account-row');
    if (!target || !dragSrc || target === dragSrc) return;
    const before = target.classList.contains('drag-over-top');
    container.insertBefore(dragSrc, before ? target : target.nextSibling);
    clearDragOver(container);
  });

  container.addEventListener('dragend', () => {
    if (dragSrc) dragSrc.classList.remove('dragging');
    dragSrc = null;
    clearDragOver(container);
  });
}

function clearDragOver(container) {
  container.querySelectorAll('.drag-over-top, .drag-over-bottom')
    .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
}

export function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${tab}`);
    p.hidden = p.id !== `tab-${tab}`;
  });
}

// ── Collect settings from DOM ─────────────────────────────────────────────────

export function collectSettings() {
  const baseCharge = parseFloat(document.getElementById('base-charge').value) || 0;
  const billingDay = parseInt(document.getElementById('billing-day').value, 10) || 3;
  const dueDay     = parseInt(document.getElementById('due-day').value, 10) || 20;

  const rows = document.querySelectorAll('#rate-table-body .tier-row');
  const rateTable = [];

  // Inputs hold cumulative upper bounds; storage wants tier widths
  // (bound minus the previous bound).
  let prevBound = 0;
  let boundError = false;
  rows.forEach(row => {
    const isFinal = row.classList.contains('final-row');
    const rate    = parseFloat(row.querySelector('.tier-rate')?.value) || 0;
    const unit    = parseInt(row.querySelector('.tier-unit')?.value, 10) || 1000;

    if (isFinal) {
      rateTable.push(['-', rate, unit]);
    } else {
      const bound = parseInt(row.querySelector('.tier-bound')?.value, 10);
      if (!bound) return; // skip blank rows
      if (bound <= prevBound) { boundError = true; return; }
      rateTable.push([bound - prevBound, rate, unit]);
      prevBound = bound;
    }
  });

  if (boundError) {
    alert("Each tier's upper limit must be greater than the previous tier's.");
    return null;
  }

  // Ensure base charge, billing day, and due day are on row[0]
  if (rateTable.length > 0) {
    if (rateTable[0].length < 4) rateTable[0].push(baseCharge);
    if (rateTable[0].length < 5) rateTable[0].push(billingDay);
    if (rateTable[0].length < 6) rateTable[0].push(dueDay);
    rateTable[0][3] = baseCharge;
    rateTable[0][4] = billingDay;
    rateTable[0][5] = dueDay;
  }

  if (rateTable.length === 0 || rateTable[rateTable.length - 1][0] !== '-') {
    alert('Rate table must have at least one tier. The last tier must be the final (∞) tier.');
    return null;
  }

  const accountRows = document.querySelectorAll('#accounts-editor .account-row');
  const accounts = Array.from(accountRows).map((row, i) => {
    const idVal = row.dataset.id;
    const acc = {
      name:          row.querySelector('.acc-name')?.value.trim()   || '',
      accountHolder: row.querySelector('.acc-holder')?.value.trim() || '',
      phone:         row.querySelector('.acc-phone')?.value.trim()  || '',
      fixedCharge:   (() => { const v = parseFloat(row.querySelector('.acc-fixed-charge')?.value); return isNaN(v) ? null : v; })(),
      meterDefective: row.querySelector('.acc-defective')?.checked ?? false,
      sortOrder:     i,
    };
    if (idVal) acc.id = Number(idVal);
    return acc;
  }).filter(a => a && a.name);

  const showMasterSection  = document.getElementById('show-master-section')?.checked ?? true;
  const smsTemplate = document.getElementById('sms-template')?.value.trim() || null;
  const maxSheets = Math.min(120, Math.max(3, parseInt(document.getElementById('max-sheets')?.value, 10) || 12));
  return { rateTable, accounts, showMasterSection, smsTemplate, maxSheets };
}
