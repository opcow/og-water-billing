import { calcBill, getGallons, formatCurrency, formatDate, formatNumber, DEFAULT_SMS_TEMPLATE } from './billing.js?v=2';

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
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

export function renderPeriod(period, accounts, sortConfig = { column: null, dir: 'asc' }, lockStartReadings = false) {
  const datesEl = document.getElementById('period-dates');
  if (!period) {
    datesEl.innerHTML = '';
    document.getElementById('billing-body').innerHTML = '';
    document.getElementById('billing-foot').innerHTML = '';
    document.getElementById('master-section').hidden = true;
    updateSortIndicators(sortConfig);
    return;
  }

  const normBadge = period.normalizationFactor && period.normalizationFactor !== 1
    ? `<span class="normalized-badge">Normalized</span>`
    : '';
  datesEl.innerHTML = `${formatDate(period.startDate)} – ${formatDate(period.endDate)}${normBadge}`;

  const readMap = new Map((period.readings || []).map(r => [r.accountId, r]));
  const nonMaster = accounts.filter(a => !a.isMaster);
  const masters   = accounts.filter(a => a.isMaster);

  const sorted = applySortConfig(nonMaster, period, readMap, sortConfig);
  document.getElementById('billing-body').innerHTML =
    sorted.map(a => rowHTML(a, readMap.get(a.id), period, lockStartReadings)).join('');

  renderTotals(period, nonMaster, readMap);
  updateSortIndicators(sortConfig);

  const masterSection = document.getElementById('master-section');
  if (masters.length > 0) {
    masterSection.hidden = false;
    document.getElementById('master-body').innerHTML =
      masters.map(a => rowHTML(a, readMap.get(a.id), period, lockStartReadings)).join('');
  } else {
    masterSection.hidden = true;
  }
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
  if (!r) return null;
  if (column === 'gallons') return getGallons(r, period.normalizationFactor);
  const g = getGallons(r, period.normalizationFactor);
  return g != null ? calcBill(g, period.rateTableSnapshot) : null;
}

function updateSortIndicators({ column, dir }) {
  document.querySelectorAll('#billing-table thead th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === column) {
      th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function rowHTML(account, reading, period, lockStartReadings) {
  const g      = reading ? getGallons(reading, period.normalizationFactor) : null;
  const amount = g != null ? calcBill(g, period.rateTableSnapshot) : null;
  const startV = reading?.startReading ?? '';
  const endV   = reading?.endReading ?? '';
  const amtClass = `num col-amt${account.phone ? ' sms-trigger' : ''}${reading?.smsSentAt ? ' sms-sent' : ''}`;
  const amtData  = account.phone ? ` data-account-id="${account.id}"` : '';

  const startCell = lockStartReadings
    ? `<td class="num col-start">${startV !== '' ? startV : '—'}</td>`
    : `<td class="num col-start" style="padding:4px 14px">
        <input type="number" class="reading-input start-reading-input"
          data-account-id="${account.id}"
          data-field="start"
          value="${startV !== '' ? startV : ''}"
          placeholder="—"
          min="0">
      </td>`;

  return `
    <tr data-account-id="${account.id}">
      <td>${esc(account.name)}</td>
      ${startCell}
      <td class="num col-end" style="padding:4px 14px">
        <input type="number" class="reading-input"
          data-account-id="${account.id}"
          data-field="end"
          value="${endV !== '' ? endV : ''}"
          placeholder="—"
          min="0">
      </td>
      <td class="num col-gal" id="gal-${account.id}">${g != null ? formatNumber(g) : '—'}</td>
      <td class="${amtClass}" id="amt-${account.id}"${amtData}>${amount != null ? formatCurrency(amount) : '—'}</td>
    </tr>`;
}

export function updateRow(accountId, period) {
  const reading = period.readings.find(r => r.accountId === accountId);
  if (!reading) return;
  const g      = getGallons(reading, period.normalizationFactor);
  const amount = g != null ? calcBill(g, period.rateTableSnapshot) : null;
  const galEl  = document.getElementById(`gal-${accountId}`);
  const amtEl  = document.getElementById(`amt-${accountId}`);
  if (galEl) galEl.textContent = g != null ? formatNumber(g) : '—';
  if (amtEl) {
    amtEl.textContent = amount != null ? formatCurrency(amount) : '—';
    amtEl.classList.toggle('sms-sent', !!reading.smsSentAt);
  }
}

export function updateTotals(period, accounts) {
  const readMap = new Map((period.readings || []).map(r => [r.accountId, r]));
  renderTotals(period, accounts.filter(a => !a.isMaster), readMap);
}

function renderTotals(period, nonMaster, readMap) {
  let totalGal = 0, totalAmt = 0, hasAny = false;
  for (const a of nonMaster) {
    const r = readMap.get(a.id);
    if (!r) continue;
    const g = getGallons(r, period.normalizationFactor);
    if (g != null) { totalGal += g; totalAmt += calcBill(g, period.rateTableSnapshot); hasAny = true; }
  }
  document.getElementById('billing-foot').innerHTML = `
    <tr class="totals-row">
      <td><strong>Total</strong></td>
      <td class="col-start"></td>
      <td class="col-end"></td>
      <td class="num col-gal">${hasAny ? formatNumber(totalGal) : '—'}</td>
      <td class="num col-amt">${hasAny ? formatCurrency(totalAmt) : '—'}</td>
    </tr>`;
}

// ── Settings modal ────────────────────────────────────────────────────────────

export function renderSettings(rateTable, accounts, hasPeriod, lockStartReadings, fileHandle = null, githubConfig = null, smsTemplate = null, maxSheets = 60) {
  const baseCharge  = rateTable[0][3] ?? 0;
  const billingDay  = rateTable[0][4] ?? 3;
  const dueDay      = rateTable[0][5] ?? 20;
  document.getElementById('base-charge').value  = baseCharge;
  document.getElementById('billing-day').value  = billingDay;
  document.getElementById('due-day').value       = dueDay;
  document.getElementById('lock-start-readings').checked = !!lockStartReadings;

  renderRateTiers(rateTable);
  renderAccountsEditor(accounts);
  renderDataTab(hasPeriod, fileHandle, githubConfig, maxSheets);
  renderMessagesTab(smsTemplate, hasPeriod);
  switchTab('rates');
}

export function renderDataTab(hasPeriod, fileHandle = null, githubConfig = null, maxSheets = 60) {
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
          <input type="password" id="sync-key"
                 value="${esc(githubConfig?.key || '')}"
                 placeholder="passphrase"
                 style="width:100%;margin-top:4px">
        </label>
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

function renderRateTiers(rateTable) {
  const tbody = document.getElementById('rate-table-body');
  // All but the last row are editable tiers; the last row (bracket === '-') is the final tier.
  const tiers   = rateTable.slice(0, -1);
  const lastRow = rateTable[rateTable.length - 1];

  tbody.innerHTML = tiers.map((row, i) => `
    <tr class="tier-row" data-index="${i}">
      <td><input type="number" class="tier-bracket" value="${row[0]}" min="1" placeholder="gallons"></td>
      <td><input type="number" class="tier-rate"    value="${row[1]}" min="0" step="0.01" placeholder="0.00"></td>
      <td><input type="number" class="tier-unit"    value="${row[2]}" min="1" placeholder="1000"></td>
      <td><button class="btn btn-danger btn-sm remove-tier" style="padding:3px 8px;font-size:12px">×</button></td>
    </tr>`).join('') + `
    <tr class="tier-row final-row">
      <td class="final-tier">∞ (all remaining)</td>
      <td><input type="number" class="tier-rate" value="${lastRow[1]}" min="0" step="0.01" placeholder="0.00"></td>
      <td><input type="number" class="tier-unit" value="${lastRow[2]}" min="1" placeholder="1000"></td>
      <td></td>
    </tr>`;
}

export function addRateTierRow() {
  const tbody   = document.getElementById('rate-table-body');
  const finalRow = tbody.querySelector('.final-row');
  const newRow  = document.createElement('tr');
  newRow.className = 'tier-row';
  const idx = tbody.querySelectorAll('.tier-row:not(.final-row)').length;
  newRow.dataset.index = idx;
  newRow.innerHTML = `
    <td><input type="number" class="tier-bracket" value="" min="1" placeholder="gallons"></td>
    <td><input type="number" class="tier-rate"    value="" min="0" step="0.01" placeholder="0.00"></td>
    <td><input type="number" class="tier-unit"    value="1000" min="1" placeholder="1000"></td>
    <td><button class="btn btn-danger btn-sm remove-tier" style="padding:3px 8px;font-size:12px">×</button></td>`;
  tbody.insertBefore(newRow, finalRow);
}

function renderAccountsEditor(accounts) {
  const container = document.getElementById('accounts-editor');
  container.innerHTML = `
    <div class="acc-header">
      <span></span>
      <span>Unit / Name</span><span>Account Holder</span><span></span>
    </div>
    ${accounts.filter(a => !a.isMaster).map(a => accountRowHTML(a)).join('')}`;
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
        <input type="tel" class="acc-phone" value="${esc(a.phone ?? '')}" placeholder="Phone (optional)">
      </div>
    </div>`;
}

export function addAccountRow() {
  const container = document.getElementById('accounts-editor');
  const div = document.createElement('div');
  div.innerHTML = accountRowHTML({ id: undefined, name: '', accountHolder: '', email: '', phone: '', isMaster: false });
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

  rows.forEach((row, i) => {
    const isFinal = row.classList.contains('final-row');
    const rate    = parseFloat(row.querySelector('.tier-rate')?.value) || 0;
    const unit    = parseInt(row.querySelector('.tier-unit')?.value, 10) || 1000;

    if (isFinal) {
      const entry = ['-', rate, unit];
      if (i === 0) { entry.push(baseCharge, billingDay); }
      rateTable.push(entry);
    } else {
      const bracket = parseInt(row.querySelector('.tier-bracket')?.value, 10);
      if (!bracket) return; // skip blank rows
      const entry = [bracket, rate, unit];
      if (i === 0) { entry.push(baseCharge, billingDay); }
      rateTable.push(entry);
    }
  });

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
      isMaster:      false,
      sortOrder:     i,
    };
    if (idVal) acc.id = Number(idVal);
    return acc;
  }).filter(a => a.name);

  const lockStartReadings = document.getElementById('lock-start-readings')?.checked ?? false;
  const smsTemplate = document.getElementById('sms-template')?.value.trim() || null;
  const maxSheets = Math.min(120, Math.max(3, parseInt(document.getElementById('max-sheets')?.value, 10) || 60));
  return { rateTable, accounts, lockStartReadings, smsTemplate, maxSheets };
}
