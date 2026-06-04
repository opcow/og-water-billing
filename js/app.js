import * as db      from './db.js';
import * as billing from './billing.js';
import * as ui      from './ui.js';

const SYNC_URL = 'https://water-billing-sync.opcow.workers.dev';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  periods: [],
  accounts: [],
  rateTable: null,
  currentPeriodId: null,
  lockStartReadings: false,
  sortConfig: { column: null, dir: 'asc' },
  dataFileHandle: null,
  githubConfig: null,
  get currentPeriod() {
    return this.periods.find(p => p.id === this.currentPeriodId) ?? null;
  },
};

let saveTimer = null;

// Returns the account list appropriate for a given period: the snapshot
// captured at creation time (preserving historical accuracy) or, for
// periods created before snapshots existed, the current live list.
function accountsFor(period) {
  return period?.accountsSnapshot ?? state.accounts;
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await db.seedIfEmpty();
  [state.periods, state.accounts, state.rateTable, state.lockStartReadings] = await Promise.all([
    db.getPeriods(),
    db.getAccounts(),
    db.getConfig('rateTable'),
    db.getConfig('lockStartReadings').then(v => v ?? true),
  ]);
  if (state.periods.length > 0) {
    state.currentPeriodId = state.periods[state.periods.length - 1].id;
  }

  // Reconnect to the linked data file and auto-restore if IDB was cleared
  const fileHandle = await db.getConfig('dataFileHandle');
  if (fileHandle) {
    try {
      const perm = await fileHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'prompt') await fileHandle.requestPermission({ mode: 'readwrite' });
      state.dataFileHandle = fileHandle;
      if (state.periods.length === 0) {
        const file = await fileHandle.getFile();
        if (file.size > 0) {
          await applyBackupData(JSON.parse(await file.text()));
          state.accounts = await db.getAccounts();
          state.periods  = await db.getPeriods();
          if (state.periods.length > 0)
            state.currentPeriodId = state.periods[state.periods.length - 1].id;
        }
      }
    } catch (e) { console.warn('Data file reconnect failed:', e); }
  }

  const githubConfig = await db.getConfig('githubConfig');
  if (githubConfig?.key) {
    state.githubConfig = githubConfig;
  }

  render();
  setupEvents();
  registerSW();
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  const hasPeriods = state.periods.length > 0;
  document.getElementById('empty-state').hidden  = hasPeriods;
  document.getElementById('period-view').hidden  = !hasPeriods;
  document.getElementById('btn-new-period').hidden    = !hasPeriods;
  document.getElementById('btn-normalize').hidden     = !hasPeriods;
  document.getElementById('btn-print').hidden         = !hasPeriods;
  document.getElementById('btn-delete-period').hidden = !hasPeriods;
  document.getElementById('btn-sync').hidden           = !state.githubConfig?.key;

  if (!hasPeriods) return;

  ui.renderPeriodSelector(state.periods, state.currentPeriodId);
  ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.sortConfig, state.lockStartReadings);
}

// ── Events ────────────────────────────────────────────────────────────────────

function setupEvents() {
  // Period selectors — year rebuilds the month list; month just switches the period
  document.getElementById('period-year').addEventListener('change', e => {
    const inYear = state.periods.filter(p => p.endDate.startsWith(e.target.value));
    if (!inYear.length) return;
    state.currentPeriodId = inYear[inYear.length - 1].id;
    ui.renderPeriodSelector(state.periods, state.currentPeriodId);
    ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.sortConfig, state.lockStartReadings);
  });

  document.getElementById('period-month').addEventListener('change', e => {
    state.currentPeriodId = Number(e.target.value);
    ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.sortConfig, state.lockStartReadings);
  });

  // Column resize handles
  initColumnResize('billing-table');

  // Column sort — only on the main billing table, not the master meter table
  document.querySelector('#billing-table thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const col = th.dataset.sort;
    if (state.sortConfig.column === col) {
      // Cycle: asc → desc → default (null)
      if (state.sortConfig.dir === 'asc') {
        state.sortConfig.dir = 'desc';
      } else {
        state.sortConfig = { column: null, dir: 'asc' };
      }
    } else {
      state.sortConfig = { column: col, dir: 'asc' };
    }
    if (state.currentPeriod) {
      ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.sortConfig, state.lockStartReadings);
    }
  });

  // New period / first period
  document.getElementById('btn-new-period').addEventListener('click', handleNewPeriod);
  document.getElementById('btn-delete-period').addEventListener('click', handleDeletePeriod);
  document.getElementById('btn-first-period').addEventListener('click', () => openPeriodDialog(true));

  // Normalize
  document.getElementById('btn-normalize').addEventListener('click', handleNormalize);

  // Print
  document.getElementById('btn-print').addEventListener('click', () => window.print());

  // Settings
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('close-settings').addEventListener('click', closeSettings);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-cancel-settings').addEventListener('click', closeSettings);
  // Normalize dialog
  document.getElementById('close-normalize-dialog').addEventListener('click', () => document.getElementById('normalize-dialog').close());
  document.getElementById('btn-cancel-normalize').addEventListener('click',  () => document.getElementById('normalize-dialog').close());
  document.getElementById('btn-confirm-normalize').addEventListener('click', confirmNormalize);
  document.getElementById('normalize-reading-day').addEventListener('input', updateNormalizeInfo);
  document.getElementById('normalize-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) document.getElementById('normalize-dialog').close();
  });

  document.getElementById('btn-add-tier').addEventListener('click', ui.addRateTierRow);
  document.getElementById('btn-add-account').addEventListener('click', ui.addAccountRow);
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => ui.switchTab(btn.dataset.tab)));
  document.getElementById('settings-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSettings();
  });

  // Data tab — export / import / file link (event delegation; tab-data is rendered dynamically)
  document.getElementById('settings-dialog').addEventListener('click', e => {
    if (e.target.matches('#btn-export-period'))       exportCurrentPeriodXLSX();
    if (e.target.matches('#btn-export-all'))          exportAllPeriodsXLSX();
    if (e.target.matches('#btn-export-backup'))       exportBackupJSON();
    if (e.target.matches('#btn-import-period'))       pickAndImportPeriod();
    if (e.target.matches('#btn-import-backup'))       pickAndRestoreBackup();
    if (e.target.matches('#btn-link-data-file'))      chooseDataFile();
    if (e.target.matches('#btn-unlink-data-file'))    unlinkDataFile();
  });

  // GitHub sync
  document.getElementById('btn-sync').addEventListener('click', githubSync);

  // Period creation dialog
  document.getElementById('close-period-dialog').addEventListener('click', closePeriodDialog);
  document.getElementById('btn-confirm-period').addEventListener('click', confirmPeriod);
  document.getElementById('btn-cancel-period').addEventListener('click', closePeriodDialog);
  document.getElementById('period-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePeriodDialog();
  });

  // Reading inputs — event delegation on both table bodies
  for (const bodyId of ['billing-body', 'master-body']) {
    document.getElementById(bodyId).addEventListener('input', handleReadingInput);
    document.getElementById(bodyId).addEventListener('keydown', handleReadingKeydown);
  }

  // Email buttons — event delegation on document
  document.addEventListener('click', e => {
    if (e.target.matches('.email-btn')) handleEmailClick(Number(e.target.dataset.accountId));
  });

  // Remove buttons in settings — event delegation
  document.getElementById('rate-table-body').addEventListener('click', e => {
    if (e.target.matches('.remove-tier')) e.target.closest('.tier-row').remove();
  });
  document.getElementById('accounts-editor').addEventListener('click', e => {
    if (e.target.matches('.remove-account')) e.target.closest('.account-row').remove();
  });
}

// ── Reading input handler ─────────────────────────────────────────────────────

function handleReadingInput(e) {
  if (!e.target.matches('.reading-input')) return;
  const accountId = Number(e.target.dataset.accountId);
  const val = e.target.value.trim();
  const period = state.currentPeriod;
  if (!period) return;

  let reading = period.readings.find(r => r.accountId === accountId);
  if (!reading) {
    reading = { accountId, startReading: null, endReading: null };
    period.readings.push(reading);
  }
  const field = e.target.dataset.field === 'start' ? 'startReading' : 'endReading';
  reading[field] = val === '' ? null : Number(val);

  ui.updateRow(accountId, period);
  ui.updateTotals(period, accountsFor(period));

  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(period), 600);
}

function handleReadingKeydown(e) {
  if (e.key !== 'Enter' || !e.target.matches('.reading-input')) return;
  e.preventDefault();
  const field = e.target.dataset.field;
  const all = [...document.querySelectorAll(`.reading-input[data-field="${field}"]`)];
  const next = all[all.indexOf(e.target) + 1];
  if (next) { next.focus(); next.select(); }
}

async function flushSave(period) {
  await db.savePeriod(period);
  const idx = state.periods.findIndex(p => p.id === period.id);
  if (idx >= 0) state.periods[idx] = period;
  syncToFile();
}

// ── New period ────────────────────────────────────────────────────────────────

function handleNewPeriod() {
  openPeriodDialog(false);
}

async function handleDeletePeriod() {
  const period = state.currentPeriod;
  if (!period) return;
  if (!confirm(`Delete the "${period.name}" period? This cannot be undone.`)) return;

  await db.deletePeriod(period.id);
  state.periods = state.periods.filter(p => p.id !== period.id);
  state.currentPeriodId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
  render();
  syncToFile();
}

// ── Period creation dialog ────────────────────────────────────────────────────

let _periodIsFirst = true;

function openPeriodDialog(isFirst) {
  _periodIsFirst = isFirst;
  document.getElementById('period-end-date').value = '';
  document.getElementById('period-dialog-title').textContent = isFirst ? 'Create First Sheet' : 'New Sheet';
  document.getElementById('period-dialog').showModal();
}

function closePeriodDialog() {
  document.getElementById('period-dialog').close();
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function confirmPeriod() {
  const endStr = document.getElementById('period-end-date').value;
  if (!endStr) { alert('Please enter the end date.'); return; }

  let period;

  if (_periodIsFirst) {
    const [y, m, d] = endStr.split('-').map(Number);
    const prevMonthSameDay = new Date(y, m - 2, d);
    prevMonthSameDay.setDate(prevMonthSameDay.getDate() + 1);
    const startStr = dateStr(prevMonthSameDay);
    period = {
      name: new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      startDate: startStr,
      endDate:   endStr,
      rateTableSnapshot: JSON.parse(JSON.stringify(state.rateTable)),
      accountsSnapshot: JSON.parse(JSON.stringify(state.accounts)),
      readings: state.accounts.map(a => ({ accountId: a.id, startReading: null, endReading: null })),
      normalizationFactor: null,
    };
  } else {
    const latest = state.periods[state.periods.length - 1];
    const prevEnd = new Date(...latest.endDate.split('-').map((v, i) => i === 1 ? +v - 1 : +v));
    const startDate = new Date(prevEnd); startDate.setDate(prevEnd.getDate() + 1);
    const startStr = dateStr(startDate);
    if (endStr < startStr) { alert('End date must be after the previous period end.'); return; }
    const [y, m, d] = endStr.split('-').map(Number);
    period = billing.newPeriod(latest, state.accounts, state.rateTable);
    period.endDate          = endStr;
    period.name             = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    period.accountsSnapshot = JSON.parse(JSON.stringify(state.accounts));
  }

  const id = await db.savePeriod(period);
  period.id = id;
  state.periods.push(period);
  state.currentPeriodId = id;
  closePeriodDialog();
  render();
  syncToFile();
}

// ── Normalize ─────────────────────────────────────────────────────────────────

async function handleNormalize() {
  const period = state.currentPeriod;
  if (!period) return;

  if (period.normalizationFactor && period.normalizationFactor !== 1) {
    if (!confirm('Clear normalization and revert to actual readings?')) return;
    period.normalizationFactor = null;
    delete period.readingDay;
    await db.savePeriod(period);
    const idx = state.periods.findIndex(p => p.id === period.id);
    if (idx >= 0) state.periods[idx] = period;
    ui.renderPeriod(period, state.accounts, state.sortConfig, state.lockStartReadings);
    return;
  }

  const billingDay = state.rateTable[0][4] ?? 3;
  document.getElementById('normalize-reading-day').value = period.readingDay ?? billingDay;
  updateNormalizeInfo();
  document.getElementById('normalize-dialog').showModal();
}

function updateNormalizeInfo() {
  const period = state.currentPeriod;
  if (!period) return;
  const readingDay = parseInt(document.getElementById('normalize-reading-day').value);
  const infoEl = document.getElementById('normalize-info');
  if (!readingDay || readingDay < 1 || readingDay > 31) { infoEl.textContent = ''; return; }

  const billingDay = state.rateTable[0][4] ?? 3;
  const [ey, em]  = period.endDate.split('-').map(Number);
  const [sy, sm, sd] = period.startDate.split('-').map(Number);
  const readingDate   = new Date(ey, em - 1, readingDay);
  const startDate     = new Date(sy, sm - 1, sd);
  const actualDays    = Math.round((readingDate - startDate) / 86400000);
  const expectedEnd   = new Date(ey, em - 1, billingDay);
  const expectedStart = new Date(ey, em - 2, billingDay);
  const expectedDays  = Math.round((expectedEnd - expectedStart) / 86400000);

  infoEl.textContent = actualDays > 0
    ? `Actual: ${actualDays} days → Standard: ${expectedDays} days (factor ×${(expectedDays / actualDays).toFixed(4)})`
    : 'Reading day must be after the period start date.';
}

async function confirmNormalize() {
  const period = state.currentPeriod;
  if (!period) return;
  const readingDay = parseInt(document.getElementById('normalize-reading-day').value);
  if (!readingDay || readingDay < 1 || readingDay > 31) {
    alert('Please enter a valid day (1–31).'); return;
  }
  const billingDay = state.rateTable[0][4] ?? 3;
  Object.assign(period, billing.normalizePeriod(period, readingDay, billingDay));
  await db.savePeriod(period);
  const idx = state.periods.findIndex(p => p.id === period.id);
  if (idx >= 0) state.periods[idx] = period;
  document.getElementById('normalize-dialog').close();
  ui.renderPeriod(period, accountsFor(period), state.sortConfig, state.lockStartReadings);
  syncToFile();
}

// ── Email ─────────────────────────────────────────────────────────────────────

function handleEmailClick(accountId) {
  const account = accountsFor(state.currentPeriod).find(a => a.id === accountId);
  const period  = state.currentPeriod;
  if (!account?.email || !period) return;

  const reading = period.readings.find(r => r.accountId === accountId)
    ?? { accountId, startReading: null, endReading: null };

  const subject = encodeURIComponent(`Water Bill — ${period.name}`);
  const body    = encodeURIComponent(billing.buildEmailBody(account, reading, period));
  window.location.href = `mailto:${account.email}?subject=${subject}&body=${body}`;
}

// ── Settings ──────────────────────────────────────────────────────────────────

function openSettings() {
  ui.renderSettings(state.rateTable, state.accounts, !!state.currentPeriod, state.lockStartReadings, state.dataFileHandle, state.githubConfig);
  document.getElementById('settings-dialog').showModal();
}

function closeSettings() {
  document.getElementById('settings-dialog').close();
}

async function saveSettings() {
  const result = ui.collectSettings();
  if (!result) return;
  const { rateTable, accounts, lockStartReadings } = result;

  // Master accounts are not shown in the editor — preserve them as-is
  const masters = state.accounts.filter(a => a.isMaster);
  await Promise.all([
    db.setConfig('rateTable', rateTable),
    db.setConfig('lockStartReadings', lockStartReadings),
    db.replaceAllAccounts([...accounts, ...masters]),
  ]);
  state.lockStartReadings = lockStartReadings;

  state.rateTable  = rateTable;
  state.accounts   = await db.getAccounts();

  // Ensure every account has a reading slot in the current period,
  // and keep the snapshot current (accounts may have been renamed/added/removed).
  const period = state.currentPeriod;
  if (period) {
    const existing = new Set(period.readings.map(r => r.accountId));
    const added    = state.accounts.filter(a => !existing.has(a.id));
    added.forEach(a => period.readings.push({ accountId: a.id, startReading: null, endReading: null }));
    period.accountsSnapshot = JSON.parse(JSON.stringify(state.accounts));
    await db.savePeriod(period);
  }

  const syncKey = document.getElementById('sync-key')?.value.trim() || '';
  const githubConfig = syncKey ? { key: syncKey } : null;
  await db.setConfig('githubConfig', githubConfig);
  state.githubConfig = githubConfig;
  document.getElementById('btn-sync').hidden = !githubConfig;

  closeSettings();
  render();
  syncToFile();
}

// ── Import / Export ───────────────────────────────────────────────────────────

function downloadFile(content, filename, mime) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([content], { type: mime })),
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

function pickFile(accept) {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.onchange = () => resolve(input.files[0] ?? null);
    input.click();
  });
}

function periodRows(period, accounts) {
  const readMap = new Map((period.readings || []).map(r => [r.accountId, r]));
  const nonMaster = accounts.filter(a => !a.isMaster);
  const masters   = accounts.filter(a => a.isMaster);
  const rows = [];

  for (const a of nonMaster) {
    const r = readMap.get(a.id);
    const g = r ? billing.getGallons(r, period.normalizationFactor) : null;
    const amt = g != null ? billing.calcBill(g, period.rateTableSnapshot) : null;
    rows.push([a.name, a.accountHolder || '', r?.startReading ?? '', r?.endReading ?? '', g ?? '', amt ?? '']);
  }

  // Totals
  let totalGal = 0, totalAmt = 0;
  for (const a of nonMaster) {
    const r = readMap.get(a.id);
    if (!r) continue;
    const g = billing.getGallons(r, period.normalizationFactor);
    if (g != null) { totalGal += g; totalAmt += billing.calcBill(g, period.rateTableSnapshot); }
  }
  rows.push(['Total', '', '', '', totalGal, +totalAmt.toFixed(2)]);

  // Master meter(s)
  for (const a of masters) {
    const r = readMap.get(a.id);
    const g = r ? billing.getGallons(r, period.normalizationFactor) : null;
    const amt = g != null ? billing.calcBill(g, period.rateTableSnapshot) : null;
    rows.push([`Master Meter – ${a.name}`, a.accountHolder || '', r?.startReading ?? '', r?.endReading ?? '', g ?? '', amt ?? '']);
  }

  return rows;
}

function buildPeriodSheet(period, accounts) {
  const XLSX = window.XLSX;
  const header = ['Account', 'Account Holder', 'Start Reading', 'End Reading', 'Gallons', 'Amount Due'];
  const data = [header, ...periodRows(period, accounts)];
  return XLSX.utils.aoa_to_sheet(data);
}

function exportCurrentPeriodXLSX() {
  const period = state.currentPeriod;
  if (!period) return;
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildPeriodSheet(period, accountsFor(period)), period.name.slice(0, 31));
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  downloadFile(buf, `water-bill-${period.name}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function exportAllPeriodsXLSX() {
  if (!state.periods.length) { alert('No periods to export.'); return; }
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  for (const p of state.periods) {
    const name = p.name.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, buildPeriodSheet(p, accountsFor(p)), name);
  }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  downloadFile(buf, 'water-billing-history.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

async function exportBackupJSON() {
  const data = await buildBackupData();
  const date = new Date().toISOString().slice(0, 10);
  downloadFile(JSON.stringify(data, null, 2), `water-billing-backup-${date}.json`, 'application/json');
}

async function pickAndImportPeriod() {
  const file = await pickFile('*/*');
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { alert('Invalid file — could not parse JSON.'); return; }
  if (!data.version || !Array.isArray(data.periods)) {
    alert('This does not appear to be a valid Water Billing backup.'); return;
  }
  showPeriodImportUI(data);
}

function showPeriodImportUI(backup) {
  const el = document.getElementById('import-period-ui');
  if (!el) return;
  const exportedDate = backup.exportedAt ? new Date(backup.exportedAt).toLocaleString() : 'unknown date';
  const periods = [...backup.periods].sort((a, b) => (a.endDate ?? '').localeCompare(b.endDate ?? ''));
  const opts = periods.map((p, i) => `<option value="${i}">${p.name ?? p.endDate}</option>`).join('');
  el.innerHTML = `
    <p style="font-size:12px;color:var(--muted);margin-bottom:8px">
      Backup from ${exportedDate} · ${periods.length} period${periods.length !== 1 ? 's' : ''}
    </p>
    <select id="import-period-select" style="padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);font-size:13px;width:100%;margin-bottom:10px">
      <option value="__all__">All data — replaces everything</option>
      ${opts}
    </select>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button id="btn-confirm-period-import" class="btn btn-primary">Import</button>
      <button id="btn-cancel-period-import" class="btn btn-secondary">Cancel</button>
    </div>`;
  el.hidden = false;

  document.getElementById('btn-confirm-period-import').onclick = async () => {
    const val = document.getElementById('import-period-select').value;
    el.hidden = true; el.innerHTML = '';
    if (val === '__all__') {
      if (!confirm(`Restore backup from ${exportedDate}?\n\nThis will replace ALL current accounts, periods, and rates.`)) return;
      await applyBackupData(backup);
      closeSettings();
      [state.periods, state.accounts, state.rateTable, state.lockStartReadings] = await Promise.all([
        db.getPeriods(), db.getAccounts(), db.getConfig('rateTable'),
        db.getConfig('lockStartReadings').then(v => v ?? true),
      ]);
      state.currentPeriodId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
      state.sortConfig = { column: null, dir: 'asc' };
      render();
    } else {
      await importSinglePeriod(periods[Number(val)], backup.accounts ?? []);
    }
  };
  document.getElementById('btn-cancel-period-import').onclick = () => {
    el.hidden = true; el.innerHTML = '';
  };
}

async function importSinglePeriod(period, backupAccounts) {
  if (!period) return;
  // Remap account IDs: match by name against current accounts
  const nameToId = new Map(state.accounts.map(a => [a.name.toLowerCase().trim(), a.id]));
  const idToName = new Map([
    ...(period.accountsSnapshot ?? []).map(a => [a.id, a.name]),
    ...backupAccounts.map(a => [a.id, a.name]),
  ]);
  const remappedReadings = (period.readings ?? []).map(r => {
    const name = idToName.get(r.accountId);
    const currentId = name != null ? nameToId.get(name.toLowerCase().trim()) : undefined;
    return currentId != null ? { ...r, accountId: currentId } : r;
  });
  const toImport = { ...period, readings: remappedReadings };

  const existing = state.periods.find(p => p.endDate === period.endDate);
  if (existing) {
    if (!confirm(`A period "${existing.name}" already exists. Replace it?`)) return;
    toImport.id = existing.id;
  } else {
    delete toImport.id;
  }

  const savedId = await db.savePeriod(toImport);
  const finalPeriod = { ...toImport, id: savedId };
  if (existing) {
    state.periods[state.periods.findIndex(p => p.id === existing.id)] = finalPeriod;
  } else {
    state.periods.push(finalPeriod);
    state.periods.sort((a, b) => a.endDate.localeCompare(b.endDate));
  }
  state.currentPeriodId = savedId;
  closeSettings();
  render();
  syncToFile();
}


async function restoreFromFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { alert('Invalid JSON file.'); return; }
  if (!data.version || !Array.isArray(data.accounts) || !Array.isArray(data.periods)) {
    alert('This does not appear to be a valid Water Billing backup.'); return;
  }
  if (!confirm(`Restore backup from ${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'unknown date'}?\n\nThis will replace ALL current accounts, periods, and rates.`)) return;
  await applyBackupData(data);
  closeSettings();
  [state.periods, state.accounts, state.rateTable, state.lockStartReadings] = await Promise.all([
    db.getPeriods(), db.getAccounts(), db.getConfig('rateTable'),
    db.getConfig('lockStartReadings').then(v => v ?? true),
  ]);
  state.currentPeriodId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
  state.sortConfig = { column: null, dir: 'asc' };
  render();
}

async function pickAndRestoreBackup() {
  const file = await pickFile('*/*');
  if (!file) return;
  await restoreFromFile(file);
}

// ── File system sync ──────────────────────────────────────────────────────────

async function buildBackupData() {
  const [accounts, periods, rateTable, lockStartReadings] = await Promise.all([
    db.getAccounts(), db.getPeriods(), db.getConfig('rateTable'),
    db.getConfig('lockStartReadings'),
  ]);
  return { version: 1, exportedAt: new Date().toISOString(), rateTable, lockStartReadings, accounts, periods };
}

async function applyBackupData(data) {
  if (!data.version || !Array.isArray(data.accounts) || !Array.isArray(data.periods))
    throw new Error('Invalid backup file');
  const rateTable         = data.config?.rateTable ?? data.rateTable;
  const lockStartReadings = data.config?.lockStartReadings ?? data.lockStartReadings ?? false;
  if (rateTable) await db.setConfig('rateTable', rateTable);
  await db.setConfig('lockStartReadings', lockStartReadings);
  await db.replaceAllAccounts(data.accounts);
  await db.replaceAllPeriods(data.periods);
}

async function syncToFile() {
  const handle = state.dataFileHandle;
  if (!handle) return;
  try {
    if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') return;
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(await buildBackupData(), null, 2));
    await writable.close();
  } catch (e) { console.warn('Auto-save to file failed:', e); }
}

async function githubSync() {
  const cfg = state.githubConfig;
  if (!cfg?.key) return;

  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '⟳';

  try {
    const headers = {
      'X-Sync-Key': cfg.key,
      'Accept': 'application/vnd.github.v3+json',
    };

    // Fetch remote file via Worker (404 = first push, not an error)
    let remoteData = null, remoteSha = null;
    const res = await fetch(SYNC_URL, { headers });
    if (res.ok) {
      const json = await res.json();
      remoteSha = json.sha;
      remoteData = JSON.parse(atob(json.content.replace(/\n/g, '')));
    } else if (res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    // Compare remote exportedAt against the last time THIS device synced,
    // not against the current clock (buildBackupData stamps exportedAt = now,
    // which would always look "newer" than anything already on the server).
    const lastSynced     = await db.getConfig('lastGithubSync');
    const lastSyncedTime = lastSynced ? Date.parse(lastSynced) : 0;
    const remoteTime     = remoteData?.exportedAt ? Date.parse(remoteData.exportedAt) : 0;

    if (remoteTime > lastSyncedTime) {
      await applyBackupData(remoteData);
      [state.periods, state.accounts, state.rateTable, state.lockStartReadings] = await Promise.all([
        db.getPeriods(), db.getAccounts(), db.getConfig('rateTable'),
        db.getConfig('lockStartReadings').then(v => v ?? true),
      ]);
      state.currentPeriodId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
      state.sortConfig = { column: null, dir: 'asc' };
      render();
      await db.setConfig('lastGithubSync', remoteData.exportedAt);
    } else {
      const localData = await buildBackupData();
      // UTF-8-safe base64 for GitHub API (proxied via Worker)
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(localData, null, 2))));
      const putRes = await fetch(SYNC_URL, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Water billing sync ${new Date().toISOString().slice(0, 10)}`,
          content,
          ...(remoteSha ? { sha: remoteSha } : {}),
        }),
      });
      if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${putRes.status}`);
      }
      await db.setConfig('lastGithubSync', localData.exportedAt);
    }
    btn.textContent = '✓ Synced';
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
  } catch (e) {
    alert(`Sync failed: ${e.message}`);
    btn.textContent = origText;
    btn.disabled = false;
  }
}

async function chooseDataFile() {
  if (!('showSaveFilePicker' in window)) return;
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'water-billing.json',
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
    });
    const file = await handle.getFile();
    if (file.size > 0 && confirm(`"${handle.name}" already has data. Restore from it?`)) {
      await applyBackupData(JSON.parse(await file.text()));
      [state.accounts, state.periods, state.rateTable, state.lockStartReadings] = await Promise.all([
        db.getAccounts(), db.getPeriods(), db.getConfig('rateTable'),
        db.getConfig('lockStartReadings').then(v => v ?? true),
      ]);
      state.currentPeriodId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
      state.sortConfig = { column: null, dir: 'asc' };
    }
    await db.setConfig('dataFileHandle', handle);
    state.dataFileHandle = handle;
    await syncToFile();
    ui.renderDataTab(!!state.currentPeriodId, handle);
    render();
  } catch (e) { if (e.name !== 'AbortError') console.error(e); }
}

async function unlinkDataFile() {
  await db.setConfig('dataFileHandle', null);
  state.dataFileHandle = null;
  ui.renderDataTab(!!state.currentPeriodId, null);
}

// ── Column resize ─────────────────────────────────────────────────────────────

function initColumnResize(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  table.querySelectorAll('thead th').forEach(th => {
    if (th.classList.contains('action-col')) return;
    const handle = document.createElement('span');
    handle.className = 'col-resize-handle no-print';
    th.appendChild(handle);
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = th.offsetWidth;
      const onMove = e => { th.style.width = Math.max(40, startW + e.clientX - startX) + 'px'; };
      const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ── Service worker ────────────────────────────────────────────────────────────

function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init().catch(err => {
  console.error(err);
  document.body.innerHTML = `<p style="padding:20px;color:red">Failed to start: ${err.message}</p>`;
});
