import * as db      from './db.js?v=df952e74';
import * as billing from './billing.js?v=1ca74bc0';
import * as ui      from './ui.js?v=a8fc934b';

const SYNC_URL = 'https://water-billing-sync.opcow.workers.dev';

const EYE_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A10.4 10.4 0 0 1 12 4c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.4 3.3M6.6 6.6A17.6 17.6 0 0 0 2 11s3.5 7 10 7a10.4 10.4 0 0 0 4.1-.8M9.5 9.5a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  periods: [],
  accounts: [],
  masterMeter: null,
  rateTable: null,
  currentPeriodId: null,
  lockStartReadings: false,
  sortConfig: { column: null, dir: 'asc' },
  dataFileHandle: null,
  githubConfig: null,
  smsTemplate: null,
  maxSheets: 12,
  showMasterSection: true,
  localDirty: false,
  get currentPeriod() {
    return this.periods.find(p => p.id === this.currentPeriodId) ?? null;
  },
};

let saveTimer      = null;
let longPressTimer = null;
let popoverYear    = null;
let lastAutoSyncTime = 0;
const undoHistory = [];
const redoStack   = [];
let snapshotPending = false;

// Returns the account list appropriate for a given period: the snapshot
// captured at creation time (preserving historical accuracy) or, for
// periods created before snapshots existed, the current live list.
function accountsFor(period) {
  return period?.accountsSnapshot ?? state.accounts;
}

// Returns the account behind a long-press menu: id 0 is the master meter.
function menuAccount(accountId) {
  return accountId === 0 ? state.masterMeter : state.accounts.find(a => a.id === accountId);
}

// Persisted so unsynced edits survive a tab close (a 304 from the remote
// would otherwise never trigger a push).
function setLocalDirty(dirty) {
  state.localDirty = dirty;
  return db.setConfig('localDirty', dirty);
}

// Re-reads everything that applyBackupData may have replaced.
async function reloadStateFromDB() {
  [state.periods, state.accounts, state.rateTable, state.masterMeter] = await Promise.all([
    db.getPeriods(), db.getAccounts(), db.getConfig('rateTable'), db.getConfig('masterMeter'),
  ]);
  state.lockStartReadings = true;
  state.currentPeriodId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
  state.sortConfig = { column: null, dir: 'asc' };
}

function buildSyncUrl() {
  const key = state.githubConfig?.key ?? '';
  return `${location.origin}${location.pathname}#sync=${encodeURIComponent(key)}`;
}

function showQRDialog() {
  const el = document.getElementById('qr-canvas');
  el.innerHTML = '';
  const syncUrl = buildSyncUrl();
  new QRCode(el, { text: syncUrl, width: 300, height: 300 });
  document.getElementById('qr-link-input').value = syncUrl;
  document.getElementById('qr-dialog').showModal();
}

async function applySyncKey(key) {
  state.githubConfig = { key };
  await db.setConfig('githubConfig', state.githubConfig);
  document.getElementById('btn-sync').hidden = false;
  render();
  await githubSync();
}

// Route a key pasted into the URL hash (#sync=<key>), on initial load or when
// the hash changes on an already-open page.
function consumeSyncHash() {
  if (!location.hash.startsWith('#sync=')) return;
  const key = decodeURIComponent(location.hash.slice(6));
  history.replaceState(null, '', location.pathname + location.search);
  if (!key) return;

  const currentKey = state.githubConfig?.key ?? null;
  if (currentKey === key) return;          // same key already set — nothing to do
  if (!currentKey) { applySyncKey(key); return; }   // no existing key — apply silently
  offerPendingSyncKey(key);                // different existing key — ask before overwrite
}

function offerPendingSyncKey(key) {
  document.getElementById('sync-key-banner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'sync-key-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:var(--blue);color:white;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;z-index:999;box-shadow:0 2px 8px rgba(0,0,0,0.2)';
  banner.innerHTML = `<span>Apply sync key?</span><div style="display:flex;gap:8px"><button id="btn-sync-yes" class="btn" style="font-size:12px;padding:4px 12px;background:white;color:var(--blue);border:none;border-radius:var(--radius);cursor:pointer;font-weight:bold">Yes</button><button id="btn-sync-no" class="btn" style="font-size:12px;padding:4px 12px;background:transparent;color:white;border:1px solid white;border-radius:var(--radius);cursor:pointer">No</button></div>`;
  document.body.insertBefore(banner, document.body.firstChild);

  const onYes = async () => {
    banner.remove();
    await applySyncKey(key);
  };

  const onNo = () => {
    banner.remove();
  };

  document.getElementById('btn-sync-yes').addEventListener('click', onYes);
  document.getElementById('btn-sync-no').addEventListener('click', onNo);
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await db.seedIfEmpty();
  [state.periods, state.accounts, state.masterMeter, state.rateTable, state.smsTemplate, state.maxSheets, state.showMasterSection, state.localDirty] = await Promise.all([
    db.getPeriods(),
    db.getAccounts(),
    db.getConfig('masterMeter'),
    db.getConfig('rateTable'),
    db.getConfig('smsTemplate').then(v => v ?? null),
    db.getConfig('maxSheets').then(v => v ?? 12),
    db.getConfig('showMasterSection').then(v => v ?? true),
    db.getConfig('localDirty').then(v => v ?? false),
  ]);
  state.lockStartReadings = true;
  if (state.periods.length > 0) {
    state.currentPeriodId = state.periods[state.periods.length - 1].id;
  }

  // Reconnect to the linked data file and auto-restore if IDB was cleared
  const fileHandle = await db.getConfig('dataFileHandle');
  if (fileHandle) {
    state.dataFileHandle = fileHandle;
    try {
      const perm = await fileHandle.queryPermission({ mode: 'readwrite' });
      // requestPermission throws without a user gesture; the handle stays
      // linked and writes resume once the user grants access later.
      if (perm === 'prompt') await fileHandle.requestPermission({ mode: 'readwrite' }).catch(() => {});
      if (state.periods.length === 0) {
        const file = await fileHandle.getFile();
        if (file.size > 0) {
          await applyBackupData(JSON.parse(await file.text()));
          await reloadStateFromDB();
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
  document.getElementById('btn-theme').innerHTML = themeIconHTML(
    document.documentElement.classList.contains('dark'));

  window.addEventListener('hashchange', consumeSyncHash);
  consumeSyncHash();
}

// ── Render ────────────────────────────────────────────────────────────────────

function updatePeriodNavButtons() {
  const idx = state.periods.findIndex(p => p.id === state.currentPeriodId);
  document.getElementById('btn-period-prev').disabled = idx <= 0;
  document.getElementById('btn-period-next').disabled = idx < 0 || idx >= state.periods.length - 1;
}

function updateLockReadingsButton() {
  const btn = document.getElementById('btn-toggle-lock-readings');
  if (btn) {
    btn.textContent = state.lockStartReadings ? 'Unlock Start Readings' : 'Lock Start Readings';
  }
}

function render() {
  const hasPeriods = state.periods.length > 0;
  document.getElementById('empty-state').hidden  = hasPeriods;
  document.getElementById('period-view').hidden  = !hasPeriods;
  document.getElementById('btn-prorate').hidden     = !hasPeriods;
  document.getElementById('btn-print').hidden         = !hasPeriods;
  document.getElementById('btn-delete-period').hidden = !hasPeriods;
  document.getElementById('btn-sync').hidden = !state.githubConfig?.key;

  if (!hasPeriods) return;

  ui.renderPeriodPicker(state.periods, state.currentPeriodId);
  ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
  updatePeriodNavButtons();
}

// ── Events ────────────────────────────────────────────────────────────────────

function showSyncLinkFallback(syncUrl) {
  const input = document.getElementById('qr-link-input');
  input.value = syncUrl;
  input.style.display = 'block';
  input.select();
  input.focus();
  document.execCommand('copy');
}

function goToPrevPeriod() {
  const idx = state.periods.findIndex(p => p.id === state.currentPeriodId);
  if (idx <= 0) return;
  state.currentPeriodId = state.periods[idx - 1].id;
  undoHistory.length = 0; redoStack.length = 0; updateUndoButtons();
  ui.renderPeriodPicker(state.periods, state.currentPeriodId);
  ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
  updatePeriodNavButtons();
}

function goToNextPeriod() {
  const idx = state.periods.findIndex(p => p.id === state.currentPeriodId);
  if (idx < 0 || idx >= state.periods.length - 1) return;
  state.currentPeriodId = state.periods[idx + 1].id;
  undoHistory.length = 0; redoStack.length = 0; updateUndoButtons();
  ui.renderPeriodPicker(state.periods, state.currentPeriodId);
  ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
  updatePeriodNavButtons();
}

// The stack slide animation lives inside setupEvents (it closes over the carousel
// DOM/gesture helpers), but creation flows in other top-level functions need it, so
// setupEvents assigns it here once wired.
let animateStackTo = null;

// Animate from the sheet at fromIdx forward to the newest sheet, one slide at a
// time (the "flipbook" effect when creating a sheet from an older one). Falls back
// to an instant render if the animation isn't available or there's nothing to play.
async function slideToNewest(fromIdx) {
  const targetIdx = state.periods.length - 1;
  if (!animateStackTo || fromIdx < 0 || fromIdx >= targetIdx) { render(); return; }
  // Start from the sheet we were viewing, then step forward to the new one.
  state.currentPeriodId = state.periods[fromIdx].id;
  render();
  for (let i = fromIdx; i < targetIdx; i++) {
    await animateStackTo('next', '.15s');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function setupEvents() {
  // Period picker popover
  document.getElementById('btn-period-picker').addEventListener('click', e => {
    e.stopPropagation();
    const popover = document.getElementById('period-popover');
    if (!popover.hidden) { popover.hidden = true; return; }
    const p = state.currentPeriod;
    popoverYear = p ? Number(p.endDate.slice(0, 4)) : new Date().getFullYear();
    ui.renderPeriodPopover(state.periods, state.currentPeriodId, popoverYear);
    popover.hidden = false;
  });

  // Arrow buttons get the animated stack transition (wired below, near the swipe
  // gesture, so they share its ghost/animation helpers).

  document.getElementById('popover-prev-year').addEventListener('click', e => {
    e.stopPropagation();
    popoverYear--;
    ui.renderPeriodPopover(state.periods, state.currentPeriodId, popoverYear);
  });

  document.getElementById('popover-next-year').addEventListener('click', e => {
    e.stopPropagation();
    popoverYear++;
    ui.renderPeriodPopover(state.periods, state.currentPeriodId, popoverYear);
  });

  document.getElementById('popover-month-grid').addEventListener('click', e => {
    const btn = e.target.closest('.popover-month');
    if (!btn || !btn.dataset.periodId) return;
    state.currentPeriodId = Number(btn.dataset.periodId);
    undoHistory.length = 0; redoStack.length = 0; updateUndoButtons();
    document.getElementById('period-popover').hidden = true;
    ui.renderPeriodPicker(state.periods, state.currentPeriodId);
    ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
    updatePeriodNavButtons();
  });

  document.addEventListener('click', e => {
    const popover = document.getElementById('period-popover');
    // Only close on clicks outside the popover; clicks within it (incl. empty
    // space) shouldn't dismiss it. The toggle button handles its own state.
    if (!popover.contains(e.target)) popover.hidden = true;
  });

  // ── Stack-of-papers swipe between sheets ────────────────────────────────────
  // The later-dated sheet is always the top of the stack, and exactly one sheet
  // moves per gesture: that top sheet. Swiping right (→ older) slides the current
  // pane off to the right, revealing the older ghost held still underneath. Swiping
  // left (→ newer) slides the newer ghost in from the right, covering the current
  // pane which stays put. On a committed swipe the live pane is re-rendered to that
  // neighbor and the ghost removed with transitions disabled, so it lands seamlessly
  // with no snap-back. Only the first/last sheet rubber-bands (the "no more" cue).
  const periodViewport = document.getElementById('period-viewport');
  const periodTrack    = document.getElementById('period-track');
  const periodView     = document.getElementById('period-view');
  const reduceMotion   = window.matchMedia('(prefers-reduced-motion: reduce)');

  let gesture = null; // active gesture state, or null when idle

  const currentIdx = () => state.periods.findIndex(p => p.id === state.currentPeriodId);

  // Run cb once on el's transform transition end, with a timeout fallback in case
  // transitionend doesn't fire (e.g. the value didn't actually change).
  function onceSettled(el, cb) {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', handler);
      cb();
    };
    const handler = ev => {
      if (ev.target === el && ev.propertyName === 'transform') run();
    };
    el.addEventListener('transitionend', handler);
    setTimeout(run, 550);   // fallback; must exceed the longest transition (.45s)
  }

  periodViewport.addEventListener('touchstart', e => {
    if (gesture && gesture.animating) return; // ignore during a settle animation
    gesture = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      horizontal: false,
      dir: null,           // 'next' | 'prev'
      ghost: null,
      mover: null,         // element that translates this gesture
      atEdge: false,
      animating: false,
      width: periodViewport.clientWidth,
    };
  });

  periodViewport.addEventListener('touchmove', e => {
    const g = gesture;
    if (!g || g.animating) return;
    const dx = g.startX - e.touches[0].clientX;
    const dy = g.startY - e.touches[0].clientY;

    if (!g.horizontal) {
      if (Math.abs(dx) > 8) {
        g.horizontal = true;
        // Decide direction and prepare the neighbor + mover once.
        const idx = currentIdx();
        g.dir = dx > 0 ? 'next' : 'prev';
        const neighbor = state.periods[g.dir === 'next' ? idx + 1 : idx - 1];
        if (neighbor && !reduceMotion.matches) {
          g.ghost = ui.buildGhost(neighbor, accountsFor(neighbor), state.masterMeter,
            state.sortConfig, state.lockStartReadings, state.showMasterSection);
          periodTrack.appendChild(g.ghost);
          if (g.dir === 'next') {
            // Newer ghost is the top sheet: it slides in from the right over the
            // (stationary) current pane.
            g.ghost.style.zIndex = '2';
            g.ghost.style.transform = `translateX(${g.width}px)`;
            g.ghost.classList.add('sheet-lift');
            g.mover = g.ghost;
          } else {
            // Older ghost sits underneath, revealed; the current pane is the top
            // sheet and slides off to the right.
            g.ghost.style.zIndex = '0';
            g.ghost.style.transform = 'translateX(0)';
            periodView.style.zIndex = '1';
            periodView.classList.add('sheet-lift');
            g.mover = periodView;
          }
          g.mover.style.transition = 'none';
        } else {
          g.atEdge = !neighbor;     // first/last sheet → rubber-band the live pane
          g.mover = periodView;
          g.mover.style.transition = 'none';
          if (g.atEdge) periodView.classList.add('sheet-lift');
        }
      } else if (Math.abs(dy) > 8) {
        gesture = null;             // vertical scroll — abandon the gesture
        return;
      } else {
        return;                     // direction not yet decided
      }
    }

    e.preventDefault();             // committed horizontal — block vertical scroll
    if (reduceMotion.matches) return;
    let move;
    if (g.atEdge)               move = -dx * 0.35;                 // damped bounce
    else if (g.dir === 'next')  move = Math.max(0, g.width - dx);  // ghost slides in
    else                        move = Math.max(0, -dx);           // pane slides off
    g.mover.style.transform = `translateX(${move}px)`;
  }, { passive: false });

  periodViewport.addEventListener('touchend', e => {
    const g = gesture;
    if (!g || !g.horizontal) { gesture = null; return; }

    const dx = g.startX - e.changedTouches[0].clientX;
    const threshold = Math.max(60, g.width * 0.15);

    // Reduced motion: no ghost/slide — just navigate instantly if past threshold.
    if (reduceMotion.matches) {
      const idx = currentIdx();
      const neighbor = state.periods[dx > 0 ? idx + 1 : idx - 1];
      if (Math.abs(dx) > threshold && neighbor) {
        if (dx > 0) goToNextPeriod(); else goToPrevPeriod();
      }
      gesture = null;
      return;
    }

    // Restore the live pane to a clean state after a gesture finishes.
    const cleanup = () => {
      if (g.ghost) g.ghost.remove();
      periodView.style.transition = '';
      periodView.style.transform  = '';
      periodView.style.zIndex     = '';
      periodView.classList.remove('sheet-lift');
      gesture = null;
    };

    g.mover.style.transition = 'transform .25s ease-out';

    if (g.ghost && Math.abs(dx) > threshold) {
      // Committed: finish the slide, then swap the live pane to that sheet and drop
      // the ghost — seamless landing, no snap-back.
      g.animating = true;
      if (g.dir === 'next') {
        g.ghost.style.transform = 'translateX(0)';
        onceSettled(g.ghost, () => { goToNextPeriod(); cleanup(); });
      } else {
        periodView.style.transform = `translateX(${g.width}px)`;
        onceSettled(periodView, () => { goToPrevPeriod(); cleanup(); });
      }
    } else {
      // Spring the moving sheet back to rest (also the at-edge rubber-band).
      g.animating = true;
      g.mover.style.transform = g.dir === 'next' && g.ghost
        ? `translateX(${g.width}px)`   // newer ghost retreats off the right
        : 'translateX(0)';             // current pane settles back
      onceSettled(g.mover, cleanup);
    }
  });

  // Same stack animation, but triggered by the arrow buttons (no touch). Builds the
  // ghost, plays the slide from a standstill (a forced reflow makes the transition
  // run), then swaps the live pane — identical landing to a committed swipe.
  // Returns a Promise that resolves when the animation completes. Assigned to the
  // module-level binding so creation flows can reuse it.
  animateStackTo = function (dir, duration = '.45s') {
    return new Promise(resolve => {
      const idx = currentIdx();
      const neighbor = state.periods[dir === 'next' ? idx + 1 : idx - 1];
      if (!neighbor) { resolve(); return; }
      if (reduceMotion.matches) {
        if (dir === 'next') goToNextPeriod(); else goToPrevPeriod();
        resolve();
        return;
      }
      if (gesture && gesture.animating) { resolve(); return; }
      gesture = { animating: true };

      const width = periodViewport.clientWidth;
      const ghost = ui.buildGhost(neighbor, accountsFor(neighbor), state.masterMeter,
        state.sortConfig, state.lockStartReadings, state.showMasterSection);
      periodTrack.appendChild(ghost);

      const cleanup = () => {
        ghost.remove();
        periodView.style.transition = '';
        periodView.style.transform  = '';
        periodView.style.zIndex     = '';
        periodView.classList.remove('sheet-lift');
        gesture = null;
        resolve();
      };

      if (dir === 'next') {
        // Newer ghost slides in from the right, covering the current pane.
        ghost.style.zIndex = '2';
        ghost.style.transform = `translateX(${width}px)`;
        ghost.classList.add('sheet-lift');
        void ghost.offsetWidth;                 // commit the start state
        ghost.style.transition = `transform ${duration} ease-out`;
        ghost.style.transform = 'translateX(0)';
        onceSettled(ghost, () => { goToNextPeriod(); cleanup(); });
      } else {
        // Current pane slides off to the right, revealing the older ghost beneath.
        ghost.style.zIndex = '0';
        ghost.style.transform = 'translateX(0)';
        periodView.style.zIndex = '1';
        periodView.classList.add('sheet-lift');
        periodView.style.transition = 'none';
        periodView.style.transform = 'translateX(0)';
        void periodView.offsetWidth;            // commit the start state
        periodView.style.transition = `transform ${duration} ease-out`;
        periodView.style.transform = `translateX(${width}px)`;
        onceSettled(periodView, () => { goToPrevPeriod(); cleanup(); });
      }
    });
  };
  document.getElementById('btn-period-prev').addEventListener('click', () => animateStackTo('prev'));
  document.getElementById('btn-period-next').addEventListener('click', () => animateStackTo('next'));

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
      ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
    }
  });

  // New period / first period
  document.getElementById('btn-new-period').addEventListener('click', handleNewPeriod);
  document.getElementById('btn-delete-period').addEventListener('click', handleDeletePeriod);
  document.getElementById('btn-first-period').addEventListener('click', () => openPeriodDialog(true));

  // Prorate
  document.getElementById('btn-prorate').addEventListener('click', handleProrate);

  // Print
  document.getElementById('btn-print').addEventListener('click', () => window.print());

  // Theme toggle
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Settings
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('close-settings').addEventListener('click', closeSettings);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-cancel-settings').addEventListener('click', closeSettings);

  // Toggle lock readings
  document.getElementById('btn-toggle-lock-readings').addEventListener('click', () => {
    state.lockStartReadings = !state.lockStartReadings;
    updateLockReadingsButton();
    if (state.currentPeriod) {
      ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
    }
  });
  // Prorate dialog
  document.getElementById('close-prorate-dialog').addEventListener('click', () => document.getElementById('prorate-dialog').close());
  document.getElementById('btn-cancel-prorate').addEventListener('click',  () => document.getElementById('prorate-dialog').close());
  document.getElementById('btn-confirm-prorate').addEventListener('click', confirmProrate);
  document.getElementById('prorate-reading-day').addEventListener('input', updateProrateInfo);
  document.getElementById('prorate-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) document.getElementById('prorate-dialog').close();
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
    if (e.target.matches('#btn-clear-sms-sent'))      clearSmsSentStatus();
    if (e.target.matches('#btn-reset-app'))           resetApp();
  });

  // GitHub sync
  document.getElementById('btn-sync').addEventListener('click', () => githubSync());

  // QR code dialog (use event delegation for dynamic button visibility)
  document.addEventListener('click', e => {
    if (e.target.id === 'btn-show-qr') showQRDialog();
    if (e.target.id === 'close-qr-dialog') document.getElementById('qr-dialog').close();
    if (e.target.id === 'btn-copy-sync-link') {
      const syncUrl = buildSyncUrl();
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(syncUrl).catch(() => showSyncLinkFallback(syncUrl));
      } else {
        showSyncLinkFallback(syncUrl);
      }
    }
    const toggleKeyBtn = e.target.closest('#btn-toggle-sync-key');
    if (toggleKeyBtn) {
      const input  = document.getElementById('sync-key');
      const masked = input.classList.toggle('masked');
      toggleKeyBtn.title = masked ? 'Show key' : 'Hide key';
      toggleKeyBtn.innerHTML = masked ? EYE_SVG : EYE_OFF_SVG;
    }
  });

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
    document.getElementById(bodyId).addEventListener('focusin', e => {
      if (e.target.matches('.reading-input')) snapshotPending = true;
    });
  }

  // Undo / Redo buttons
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);

  // Undo / Redo keyboard shortcuts (e.key is 'Z' when Shift is held, so
  // compare lowercased). Leave native text-undo alone in non-reading fields.
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    if (e.target.matches('input, textarea') && !e.target.matches('.reading-input')) return;
    e.preventDefault();
    if (key === 'z' && !e.shiftKey) undo();
    else redo();
  });

  // Tap an amount cell to open the Send Text overlay (master meter excluded)
  document.addEventListener('click', e => {
    const amtCell = e.target.closest('td.col-amt[data-account-id]');
    if (!amtCell || amtCell.textContent.trim() === '—') return;
    const accountId = Number(amtCell.dataset.accountId);
    if (accountId === 0) return;
    openSmsDialog(accountId);
  });

  // Long-press handler — start reading cells
  let pressStartPos = null;
  let pressedCell = null;
  document.addEventListener('pointerdown', e => {
    const startCell = e.target.closest('td.col-start');

    if (startCell && state.lockStartReadings) {
      pressedCell = { type: 'start', cell: startCell };
      pressStartPos = { x: e.clientX, y: e.clientY };
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        pressStartPos = null;
        showStartMenu(pressedCell.cell);
        pressedCell = null;
      }, 500);
    }
  });
  document.addEventListener('pointermove', e => {
    if (!longPressTimer || !pressStartPos) return;
    if (Math.abs(e.clientX - pressStartPos.x) > 8 || Math.abs(e.clientY - pressStartPos.y) > 8) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      pressStartPos = null;
      pressedCell = null;
    }
  });
  document.addEventListener('pointerup',     () => { clearTimeout(longPressTimer); longPressTimer = null; pressStartPos = null; pressedCell = null; });
  document.addEventListener('pointercancel', () => { clearTimeout(longPressTimer); longPressTimer = null; pressStartPos = null; pressedCell = null; });

  // Dismiss start menu on outside press
  document.addEventListener('pointerdown', e => {
    const startMenu = document.getElementById('start-menu');
    if (!startMenu.hidden && !startMenu.contains(e.target)) startMenu.hidden = true;
  }, { capture: true });

  // Suppress native context menu on name, amount, and start cells (prevents iOS long-press copy menu)
  document.addEventListener('contextmenu', e => {
    if (e.target.closest('td.col-name[data-account-id]') || e.target.closest('td.col-amt[data-account-id]') || e.target.closest('td.col-start')) e.preventDefault();
  });

  // Reposition start menu when soft keyboard appears / disappears
  window.visualViewport?.addEventListener('resize', () => {
    const startMenu = document.getElementById('start-menu');
    if (!startMenu.hidden) repositionMenu(startMenu);
  });

  // Send text dialog buttons
  document.getElementById('btn-send-sms').addEventListener('click', async () => {
    const dialog    = document.getElementById('sms-dialog');
    const accountId = Number(dialog.dataset.accountId);
    const account   = menuAccount(accountId);
    if (!account) { dialog.close(); return; }

    if (!account.phone) {
      const phone = document.getElementById('sms-phone').value.trim();
      if (!phone) return;
      account.phone = phone;
      if (accountId === 0) {
        await db.setConfig('masterMeter', state.masterMeter);
      } else {
        await db.saveAccount(account);
        const snap = state.currentPeriod?.accountsSnapshot?.find(a => a.id === accountId);
        if (snap) snap.phone = phone;
      }
      const amtEl = document.getElementById(`amt-${accountId}`);
      if (amtEl) amtEl.classList.add('sms-trigger');
    }
    dialog.close();
    handleTextClick(accountId);
  });
  document.getElementById('btn-cancel-sms').addEventListener('click', () => document.getElementById('sms-dialog').close());
  document.getElementById('close-sms-dialog').addEventListener('click', () => document.getElementById('sms-dialog').close());
  document.getElementById('sms-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.target.close();
  });

  // Start readings menu unlock button
  document.getElementById('start-menu-unlock').addEventListener('click', () => {
    state.lockStartReadings = false;
    updateLockReadingsButton();
    if (state.currentPeriod) {
      ui.renderPeriod(state.currentPeriod, accountsFor(state.currentPeriod), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
    }
    document.getElementById('start-menu').hidden = true;
  });

  // Remove buttons in settings — event delegation
  document.getElementById('rate-table-body').addEventListener('click', e => {
    if (e.target.matches('.remove-tier')) {
      e.target.closest('.tier-row').remove();
      ui.updateTierLabels();
    }
  });
  // Keep the "2,001 –" range labels in sync while tier bounds are edited
  document.getElementById('rate-table-body').addEventListener('input', e => {
    if (e.target.matches('.tier-bound')) ui.updateTierLabels();
  });
  document.getElementById('accounts-editor').addEventListener('click', e => {
    if (e.target.matches('.remove-account')) e.target.closest('.account-row').remove();
  });

  // Auto-sync: upload when foreground + local changes + 5min elapsed
  const autoSync = () => {
    if (!state.githubConfig?.key || document.hidden) return;
    const now = Date.now();
    if (now - lastAutoSyncTime < 5 * 60 * 1000) return;
    lastAutoSyncTime = now;
    githubSync(true);
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.githubConfig?.key) {
      lastAutoSyncTime = 0;
      githubSync(true);
    }
  });
  setInterval(autoSync, 60 * 1000);
}

// ── Reading input handler ─────────────────────────────────────────────────────

function handleReadingInput(e) {
  if (!e.target.matches('.reading-input')) return;
  const accountId = Number(e.target.dataset.accountId);
  const val = e.target.value.trim();
  const period = state.currentPeriod;
  if (!period) return;
  if (snapshotPending) { snapshotReadings(); snapshotPending = false; }

  const field = e.target.dataset.field === 'start' ? 'startReading' : 'endReading';

  // endReadingAt doubles as the reading's last-modified stamp for sync
  // merging, so bump it on start-reading edits too — otherwise a corrected
  // start reading loses to a stale copy from another device.
  if (accountId === 0) {
    if (!period.masterReading) period.masterReading = { startReading: null, endReading: null, endReadingAt: null };
    period.masterReading[field] = val === '' ? null : Number(val);
    period.masterReading.endReadingAt = Date.now();
    ui.updateMasterRow(period, state.masterMeter);
  } else {
    let reading = period.readings.find(r => r.accountId === accountId);
    if (!reading) {
      reading = { accountId, startReading: null, endReading: null, endReadingAt: null };
      period.readings.push(reading);
    }
    reading[field] = val === '' ? null : Number(val);
    reading.endReadingAt = Date.now();
    ui.updateRow(accountId, period, accountsFor(period));
    ui.updateTotals(period, accountsFor(period));
  }

  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(period), 600);
}

function handleReadingKeydown(e) {
  if (e.key !== 'Enter' || !e.target.matches('.reading-input')) return;
  e.preventDefault();
  e.target.blur();
}

async function flushSave(period) {
  await db.savePeriod(period);
  const idx = state.periods.findIndex(p => p.id === period.id);
  if (idx >= 0) state.periods[idx] = period;
  await setLocalDirty(true);
  syncToFile();
}

// ── Undo / Redo ───────────────────────────────────────────────────────────────

function snapshotReadings() {
  const period = state.currentPeriod;
  if (!period) return;
  undoHistory.push(JSON.parse(JSON.stringify(period.readings)));
  if (undoHistory.length > 50) undoHistory.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

function updateUndoButtons() {
  document.getElementById('btn-undo').disabled = undoHistory.length === 0;
  document.getElementById('btn-redo').disabled = redoStack.length === 0;
}

function undo() {
  const period = state.currentPeriod;
  if (!period || !undoHistory.length) return;
  redoStack.push(JSON.parse(JSON.stringify(period.readings)));
  period.readings = undoHistory.pop();
  snapshotPending = true;
  flushSave(period);
  ui.renderPeriod(period, accountsFor(period), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
  updateUndoButtons();
}

function redo() {
  const period = state.currentPeriod;
  if (!period || !redoStack.length) return;
  undoHistory.push(JSON.parse(JSON.stringify(period.readings)));
  period.readings = redoStack.pop();
  snapshotPending = true;
  flushSave(period);
  ui.renderPeriod(period, accountsFor(period), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
  updateUndoButtons();
}

// ── Sheet history trim ────────────────────────────────────────────────────────

async function trimOldPeriods() {
  const max = state.maxSheets ?? 12;
  if (state.periods.length <= max) return;
  const toDelete = state.periods.slice(0, state.periods.length - max);

  // Merge account info from deleted periods into master accounts to preserve configured data
  const idToCurrentAccount = new Map(state.accounts.map(a => [a.id, a]));
  toDelete.forEach(period => {
    (period.accountsSnapshot || []).forEach(snap => {
      const current = idToCurrentAccount.get(snap.id);
      if (current) {
        // Preserve configured fields from snapshot if current ones are empty
        if (snap.phone && !current.phone) current.phone = snap.phone;
        if (snap.accountHolder && !current.accountHolder) current.accountHolder = snap.accountHolder;
        if (snap.fixedCharge != null && current.fixedCharge == null) current.fixedCharge = snap.fixedCharge;
        if (snap.meterDefective && !current.meterDefective) current.meterDefective = snap.meterDefective;
      } else {
        // Account exists in old period but not in current list — preserve it
        idToCurrentAccount.set(snap.id, snap);
      }
    });
  });

  // Save merged accounts back
  const merged = Array.from(idToCurrentAccount.values());
  await db.replaceAllAccounts(merged);
  state.accounts = merged;

  await Promise.all(toDelete.map(p => db.deletePeriod(p.id)));
  state.periods = state.periods.slice(state.periods.length - max);
  if (!state.periods.find(p => p.id === state.currentPeriodId)) {
    state.currentPeriodId = state.periods[state.periods.length - 1]?.id ?? null;
    render();
  }
}

// ── New period ────────────────────────────────────────────────────────────────

async function handleNewPeriod() {
  const latest = state.periods[state.periods.length - 1];
  if (!latest) return;

  const billingDay = state.rateTable?.[0]?.[4] ?? 3;
  const prevEnd    = new Date(...latest.endDate.split('-').map((v, i) => i === 1 ? +v - 1 : +v));
  const nm         = new Date(prevEnd.getFullYear(), prevEnd.getMonth() + 1, 1);
  const nextDay    = Math.min(billingDay, new Date(nm.getFullYear(), nm.getMonth() + 1, 0).getDate());
  const nextEnd    = new Date(nm.getFullYear(), nm.getMonth(), nextDay);

  const name = billing.monthLabel(nextEnd);
  if (state.periods.some(p => p.name === name)) {
    alert(`A sheet for ${name} already exists.`);
    return;
  }

  const period = billing.newPeriod(latest, state.accounts, state.masterMeter, state.rateTable);
  period.endDate          = billing.toDateStr(nextEnd);
  period.name             = name;
  period.accountsSnapshot = JSON.parse(JSON.stringify(state.accounts));

  const fromIdx = state.periods.findIndex(p => p.id === state.currentPeriodId);
  const id = await db.savePeriod(period);
  period.id = id;
  state.periods.push(period);
  state.currentPeriodId = id;
  await setLocalDirty(true);
  await slideToNewest(fromIdx);
  await trimOldPeriods();
  syncToFile();
}

async function handleDeletePeriod() {
  const period = state.currentPeriod;
  if (!period) return;
  if (!confirm(`Delete the "${period.name}" period? This cannot be undone.`)) return;

  await db.deletePeriod(period.id);
  state.periods = state.periods.filter(p => p.id !== period.id);
  state.currentPeriodId = state.periods.length ? state.periods[state.periods.length - 1].id : null;
  await setLocalDirty(true);
  render();
  syncToFile();
}

// ── Period creation dialog ────────────────────────────────────────────────────

let _periodIsFirst = false;

function openPeriodDialog(isFirst) {
  _periodIsFirst = isFirst;
  document.getElementById('period-end-date').value = '';
  document.getElementById('period-dialog-title').textContent = isFirst ? 'Create First Sheet' : 'New Sheet';
  document.getElementById('period-dialog').showModal();
}

function closePeriodDialog() {
  document.getElementById('period-dialog').close();
}

async function confirmPeriod() {
  const endStr = document.getElementById('period-end-date').value;
  if (!endStr) { alert('Please enter the end date.'); return; }

  const [y, m, d] = endStr.split('-').map(Number);
  const name = billing.monthLabel(new Date(y, m - 1, d));
  const fromIdx = state.periods.findIndex(p => p.id === state.currentPeriodId);
  let period;

  if (_periodIsFirst) {
    // Treat the chosen day as the billing day going forward
    if (state.rateTable?.[0]) {
      state.rateTable[0][4] = d;
      await db.setConfig('rateTable', state.rateTable);
    }
    // Start = one month before the end date, plus one day. Clamp to the
    // previous month's length so e.g. May 31 starts May 1, not May 2.
    const prevMonthLen = new Date(y, m - 1, 0).getDate();
    const startDate = new Date(y, m - 2, Math.min(d, prevMonthLen));
    startDate.setDate(startDate.getDate() + 1);
    period = {
      name,
      startDate: billing.toDateStr(startDate),
      endDate:   endStr,
      rateTableSnapshot: JSON.parse(JSON.stringify(state.rateTable)),
      accountsSnapshot: JSON.parse(JSON.stringify(state.accounts)),
      readings: state.accounts.map(a => ({ accountId: a.id, startReading: null, endReading: null, endReadingAt: null })),
      masterReading: { startReading: null, endReading: null, endReadingAt: null },
      normalizationFactor: null,
    };
  } else {
    const latest = state.periods[state.periods.length - 1];
    const prevEnd = new Date(...latest.endDate.split('-').map((v, i) => i === 1 ? +v - 1 : +v));
    const startDate = new Date(prevEnd); startDate.setDate(prevEnd.getDate() + 1);
    if (endStr < billing.toDateStr(startDate)) { alert('End date must be after the previous period end.'); return; }
    if (state.periods.some(p => p.name === name)) { alert(`A sheet for ${name} already exists.`); return; }
    period = billing.newPeriod(latest, state.accounts, state.masterMeter, state.rateTable);
    period.endDate          = endStr;
    period.name             = name;
    period.accountsSnapshot = JSON.parse(JSON.stringify(state.accounts));
  }

  const id = await db.savePeriod(period);
  period.id = id;
  state.periods.push(period);
  state.currentPeriodId = id;
  await setLocalDirty(true);
  if (_periodIsFirst) {
    state.lockStartReadings = false;
    updateLockReadingsButton();
  }
  closePeriodDialog();
  // Animate to the new sheet (flipbook through intermediates if on an older sheet).
  // First sheet ever: nothing to animate from, just render.
  if (_periodIsFirst) render();
  else await slideToNewest(fromIdx);
  await trimOldPeriods();
  syncToFile();
}

// ── Prorate ─────────────────────────────────────────────────────────────────

async function handleProrate() {
  const period = state.currentPeriod;
  if (!period) return;

  if (period.normalizationFactor && period.normalizationFactor !== 1) {
    if (!confirm('Clear normalization and revert to actual readings?')) return;
    period.normalizationFactor = null;
    delete period.readingDay;
    if (period.originalReadings) {
      period.readings = period.originalReadings;
      delete period.originalReadings;
    }
    if (period.originalMasterReading !== undefined) {
      period.masterReading = period.originalMasterReading;
      delete period.originalMasterReading;
    }
    await db.savePeriod(period);
    const idx = state.periods.findIndex(p => p.id === period.id);
    if (idx >= 0) state.periods[idx] = period;
    await setLocalDirty(true);
    ui.renderPeriod(period, accountsFor(period), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
    syncToFile();
    return;
  }

  const billingDay = state.rateTable?.[0]?.[4] ?? 3;
  document.getElementById('prorate-reading-day').value = period.readingDay ?? billingDay;
  updateProrateInfo();
  document.getElementById('prorate-dialog').showModal();
}

function updateProrateInfo() {
  const period = state.currentPeriod;
  if (!period) return;
  const readingDay = parseInt(document.getElementById('prorate-reading-day').value);
  const infoEl = document.getElementById('prorate-info');
  if (!readingDay || readingDay < 1 || readingDay > 31) { infoEl.textContent = ''; return; }

  const billingDay = state.rateTable[0][4] ?? 3;
  const [ey, em]  = period.endDate.split('-').map(Number);
  const [sy, sm, sd] = period.startDate.split('-').map(Number);
  const readingDate   = new Date(ey, em - 1, readingDay);
  const startDate     = new Date(sy, sm - 1, sd);
  // Date range is inclusive of both endpoints, so add 1 day.
  const actualDays    = Math.round((readingDate - startDate) / 86400000) + 1;
  const expectedEnd   = new Date(ey, em - 1, billingDay);
  const expectedStart = new Date(ey, em - 2, billingDay);
  const expectedDays  = Math.round((expectedEnd - expectedStart) / 86400000);

  infoEl.textContent = actualDays > 0
    ? `Actual: ${actualDays} days → Standard: ${expectedDays} days (factor ×${(expectedDays / actualDays).toFixed(4)})`
    : 'Reading day must be after the period start date.';
}

async function confirmProrate() {
  const period = state.currentPeriod;
  if (!period) return;
  const readingDay = parseInt(document.getElementById('prorate-reading-day').value);
  if (!readingDay || readingDay < 1 || readingDay > 31) {
    alert('Please enter a valid day (1–31).'); return;
  }
  const billingDay = state.rateTable[0][4] ?? 3;
  Object.assign(period, billing.proratePeriod(period, readingDay, billingDay));
  await db.savePeriod(period);
  const idx = state.periods.findIndex(p => p.id === period.id);
  if (idx >= 0) state.periods[idx] = period;
  await setLocalDirty(true);
  document.getElementById('prorate-dialog').close();
  ui.renderPeriod(period, accountsFor(period), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
  syncToFile();
}

// ── Text ──────────────────────────────────────────────────────────────────────

function clearSmsSentStatus() {
  const period = state.currentPeriod;
  if (!period) return;
  period.readings.forEach(r => { delete r.smsSentAt; });
  if (period.masterReading) delete period.masterReading.smsSentAt;
  flushSave(period);
  ui.renderPeriod(period, accountsFor(period), state.masterMeter, state.sortConfig, state.lockStartReadings, state.showMasterSection);
}

function repositionMenu(menu) {
  const mH   = menu.offsetHeight;
  const mW   = menu.offsetWidth;
  const aBot = parseFloat(menu.dataset.anchorBottom);
  const aTop = parseFloat(menu.dataset.anchorTop);
  const aLeft = parseFloat(menu.dataset.anchorLeft);
  const vH   = window.visualViewport?.height ?? window.innerHeight;
  const vW   = window.visualViewport?.width  ?? window.innerWidth;
  const top  = (aBot + 6 + mH <= vH - 8)
    ? aBot + 6
    : Math.max(8, aTop - mH - 6);
  const left = Math.max(8, Math.min(aLeft, vW - mW - 8));
  menu.style.top  = top  + 'px';
  menu.style.left = left + 'px';
}

function openSmsDialog(accountId) {
  const period = state.currentPeriod;
  if (!period) return;

  const account = menuAccount(accountId);
  if (!account) return;

  let reading;
  if (accountId === 0) {
    reading = period.masterReading;
  } else {
    reading = period.readings.find(r => r.accountId === accountId)
      || { accountId, startReading: null, endReading: null, endReadingAt: null };
  }

  const dialog = document.getElementById('sms-dialog');
  dialog.dataset.accountId = accountId;
  document.getElementById('sms-dialog-preview').textContent = billing.buildSMSBody(account, reading, period, state.smsTemplate);

  const phoneRow   = document.getElementById('sms-phone-row');
  const phoneInput = document.getElementById('sms-phone');
  if (account.phone) {
    phoneRow.style.display = 'none';
  } else {
    phoneInput.value = '';
    phoneRow.style.display = '';
  }

  dialog.showModal();
  if (!account.phone) phoneInput.focus();
}

function showStartMenu(cell) {
  const menu = document.getElementById('start-menu');
  const rect = cell.getBoundingClientRect();
  menu.dataset.anchorTop    = rect.top;
  menu.dataset.anchorBottom = rect.bottom;
  menu.dataset.anchorLeft   = rect.left;
  menu.hidden = false;
  repositionMenu(menu);
}

function handleTextClick(accountId) {
  const period  = state.currentPeriod;
  if (!period) return;

  let account, reading;

  if (accountId === 0) {
    account = state.masterMeter;
    reading = period.masterReading;
  } else {
    account = accountsFor(period).find(a => a.id === accountId);
    reading = period.readings.find(r => r.accountId === accountId);
    if (!reading) {
      reading = { accountId, startReading: null, endReading: null, endReadingAt: null };
      period.readings.push(reading);
    }
  }

  if (!account?.phone) return;

  const body = encodeURIComponent(billing.buildSMSBody(account, reading, period, state.smsTemplate));

  if (accountId === 0) {
    period.masterReading.smsSentAt = Date.now();
  } else {
    reading.smsSentAt = Date.now();
  }
  flushSave(period);
  const amtEl = document.getElementById(`amt-${accountId}`);
  if (amtEl) amtEl.classList.add('sms-sent');

  window.location.href = `sms:${account.phone}?body=${body}`;
}

// ── Settings ──────────────────────────────────────────────────────────────────

function themeIconHTML(dark) {
  const name = dark ? 'day-night-light' : 'day-night-dark';
  return `<img src="icons/${name}.png" style="height:22px;width:auto;display:block" alt="">`;
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
  document.getElementById('btn-theme').innerHTML = themeIconHTML(dark);
}

function openSettings() {
  ui.renderSettings(state.rateTable, state.accounts, state.masterMeter, !!state.currentPeriod, state.dataFileHandle, state.githubConfig, state.smsTemplate, state.maxSheets, state.showMasterSection);
  updateLockReadingsButton();
  document.getElementById('settings-dialog').showModal();
}

function closeSettings() {
  document.getElementById('settings-dialog').close();
}

async function saveSettings() {
  const result = ui.collectSettings();
  if (!result) return;
  const { rateTable, accounts, smsTemplate } = result;

  await Promise.all([
    db.setConfig('rateTable', rateTable),
    db.setConfig('smsTemplate', smsTemplate),
    db.replaceAllAccounts(accounts),
  ]);
  state.smsTemplate = smsTemplate;
  state.maxSheets = result.maxSheets;
  state.showMasterSection = result.showMasterSection;
  await db.setConfig('maxSheets', result.maxSheets);
  await db.setConfig('showMasterSection', result.showMasterSection);
  await setLocalDirty(true);

  state.rateTable  = rateTable;
  state.accounts   = await db.getAccounts();

  // Ensure every account has a reading slot in the current period,
  // and keep the snapshot current (accounts may have been renamed/added/removed).
  const period = state.currentPeriod;
  if (period) {
    const existing = new Set(period.readings.map(r => r.accountId));
    const added    = state.accounts.filter(a => !existing.has(a.id));
    added.forEach(a => period.readings.push({ accountId: a.id, startReading: null, endReading: null, endReadingAt: null }));
    period.accountsSnapshot = JSON.parse(JSON.stringify(state.accounts));
    await db.savePeriod(period);
  }

  const syncKey = document.getElementById('sync-key')?.value.trim() || '';
  const githubConfig = syncKey ? { key: syncKey } : null;
  const keyWasJustSaved = !state.githubConfig && githubConfig;
  await db.setConfig('githubConfig', githubConfig);
  state.githubConfig = githubConfig;
  document.getElementById('btn-sync').hidden = !githubConfig;

  await trimOldPeriods();
  closeSettings();
  render();
  syncToFile();

  if (keyWasJustSaved) {
    githubSync();
  }
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

// Amount logic must match ui.js accountAmount: a fixed charge overrides
// everything; otherwise at least the base charge is owed, so this never
// returns null. A defective meter's readings don't count.
function periodAmount(account, gallons, period) {
  if (account.fixedCharge != null) return account.fixedCharge;
  if (account.meterDefective) gallons = null;
  return billing.calcBill(gallons ?? 0, period.rateTableSnapshot);
}

function periodRows(period, accounts, masterMeter) {
  const readMap = new Map((period.readings || []).map(r => [r.accountId, r]));
  const rows = [];
  let totalGal = 0, totalAmt = 0;

  for (const a of accounts) {
    const r = readMap.get(a.id);
    const g = r ? billing.getGallons(r) : null;
    const amt = periodAmount(a, g, period);
    if (!a.meterDefective) totalGal += g ?? 0;
    totalAmt += amt;
    rows.push([a.name, a.accountHolder || '', r?.startReading ?? '', r?.endReading ?? '', a.meterDefective ? '' : (g ?? ''), amt]);
  }

  rows.push(['Total', '', '', '', totalGal, +totalAmt.toFixed(2)]);

  // Master meter
  if (masterMeter) {
    const r = period.masterReading;
    const g = r ? billing.getGallons(r) : null;
    const amt = periodAmount(masterMeter, g, period);
    rows.push([`Master Meter – ${masterMeter.name}`, masterMeter.accountHolder || '', r?.startReading ?? '', r?.endReading ?? '', masterMeter.meterDefective ? '' : (g ?? ''), amt]);
  }

  return rows;
}

function buildPeriodSheet(period, accounts, masterMeter) {
  const XLSX = window.XLSX;
  const header = ['Account', 'Account Holder', 'Start Reading', 'End Reading', 'Gallons', 'Amount Due'];
  const data = [header, ...periodRows(period, accounts, masterMeter)];
  return XLSX.utils.aoa_to_sheet(data);
}

function exportCurrentPeriodXLSX() {
  const period = state.currentPeriod;
  if (!period) return;
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildPeriodSheet(period, accountsFor(period), state.masterMeter), period.name.slice(0, 31));
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  downloadFile(buf, `water-bill-${period.name}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function exportAllPeriodsXLSX() {
  if (!state.periods.length) { alert('No periods to export.'); return; }
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  for (const p of state.periods) {
    const name = p.name.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, buildPeriodSheet(p, accountsFor(p), state.masterMeter), name);
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
  const file = await pickFile('.json,application/json');
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
  const opts = periods.map((p, i) => `<option value="${i}">${ui.esc(p.name ?? p.endDate)}</option>`).join('');
  el.innerHTML = `
    <p style="font-size:12px;color:var(--muted);margin-bottom:8px">
      Backup from ${ui.esc(exportedDate)} · ${periods.length} period${periods.length !== 1 ? 's' : ''}
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
      await reloadStateFromDB();
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
  await reloadStateFromDB();
  render();
}

async function pickAndRestoreBackup() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  await restoreFromFile(file);
}

// ── File system sync ──────────────────────────────────────────────────────────

// Merges otherPeriods into basePeriods (matched by name): per-account readings
// with a newer endReadingAt win. With keepOtherOnly, periods that exist only
// in otherPeriods are appended — used on pull so sheets created locally but
// not yet pushed aren't wiped by the remote's structure.
function mergeReadings(basePeriods, otherPeriods, { keepOtherOnly = false } = {}) {
  const otherMap = new Map(otherPeriods.map(p => [p.name, p]));
  let hadNewer = false;
  const merged = basePeriods.map(basePeriod => {
    const otherPeriod = otherMap.get(basePeriod.name);
    if (!otherPeriod) return basePeriod;

    const otherReadingMap = new Map((otherPeriod.readings || []).map(r => [r.accountId, r]));
    const mergedReadings = (basePeriod.readings || []).map(baseReading => {
      const otherReading = otherReadingMap.get(baseReading.accountId);
      if (!otherReading) return baseReading;
      const baseAt  = baseReading.endReadingAt  ?? 0;
      const otherAt = otherReading.endReadingAt ?? 0;
      if (otherAt > baseAt) { hadNewer = true; return otherReading; }
      return baseReading;
    });

    let mergedMasterReading = basePeriod.masterReading ?? { startReading: null, endReading: null, endReadingAt: null };
    if (otherPeriod.masterReading) {
      const baseAt = (basePeriod.masterReading?.endReadingAt) ?? 0;
      const otherAt = otherPeriod.masterReading.endReadingAt ?? 0;
      if (otherAt > baseAt) { hadNewer = true; mergedMasterReading = otherPeriod.masterReading; }
    }

    return { ...basePeriod, readings: mergedReadings, masterReading: mergedMasterReading };
  });

  if (keepOtherOnly) {
    const baseNames = new Set(basePeriods.map(p => p.name));
    const extras = otherPeriods.filter(p => !baseNames.has(p.name));
    if (extras.length) {
      hadNewer = true;
      merged.push(...extras);
      merged.sort((a, b) => a.endDate.localeCompare(b.endDate));
    }
  }
  return { merged, hadNewer };
}

async function buildBackupData() {
  const [accounts, periods, masterMeter, rateTable] = await Promise.all([
    db.getAccounts(), db.getPeriods(), db.getConfig('masterMeter'), db.getConfig('rateTable'),
  ]);
  return { version: 1, exportedAt: new Date().toISOString(), masterMeter, rateTable, accounts, periods };
}

async function applyBackupData(data) {
  if (!data.version || !Array.isArray(data.accounts) || !Array.isArray(data.periods))
    throw new Error('Invalid backup file');
  const rateTable         = data.config?.rateTable ?? data.rateTable;
  const masterMeter       = data.masterMeter;

  if (rateTable) await db.setConfig('rateTable', rateTable);
  if (masterMeter) await db.setConfig('masterMeter', masterMeter);

  const accounts = data.accounts.filter(a => !a.isMaster);
  const periods = data.periods.map(p => {
    const masterAcctId = data.accounts.find(a => a.isMaster)?.id;
    if (masterAcctId && !p.masterReading) {
      const masterReading = p.readings?.find(r => r.accountId === masterAcctId);
      if (masterReading) {
        p.masterReading = { startReading: masterReading.startReading, endReading: masterReading.endReading, endReadingAt: null };
        p.readings = p.readings.filter(r => r.accountId !== masterAcctId);
      }
    }
    return p;
  });

  await db.replaceAllAccounts(accounts);
  await db.replaceAllPeriods(periods);
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

// Uploads the full local backup. Stores the new sha (and a synthesized etag —
// GitHub's contents etag is the weak blob sha; if the format ever differs the
// next GET just misses the 304 and self-corrects) and clears the dirty flag.
async function pushLocal(key, sha) {
  const localData = await buildBackupData();
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(localData, null, 2))));
  const body = { message: `Water billing sync ${new Date().toISOString().slice(0, 10)}`, content };
  if (sha) body.sha = sha;

  const putRes = await fetch(SYNC_URL, {
    method: 'PUT',
    headers: { 'X-Sync-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${putRes.status}`);
  }
  const newSha = (await putRes.json().catch(() => null))?.content?.sha;
  if (newSha) {
    await db.setConfig('lastGithubSha', newSha);
    await db.setConfig('lastGithubEtag', `W/"${newSha}"`);
  }
  await setLocalDirty(false);
  await db.setConfig('lastGithubSync', localData.exportedAt);
}

let _syncing = false;

async function githubSync(isAuto = false) {
  const cfg = state.githubConfig;
  if (!cfg?.key) return;

  // Concurrency guard: the 60s interval, visibilitychange, and the manual
  // button all reach here. Overlapping runs PUT with a stale sha and clobber
  // each other, so skip if one is already in flight.
  if (_syncing) return;
  _syncing = true;

  const btn = document.getElementById('btn-sync');
  const origText = btn.textContent;
  if (!isAuto) {
    btn.disabled = true;
    btn.textContent = '⟳';
  }

  try {
    const headers = {
      'X-Sync-Key': cfg.key,
      'Accept': 'application/vnd.github.v3+json',
    };

    // Fetch remote file via Worker with ETag conditional (404 = first push, not an error)
    const lastGithubEtag = await db.getConfig('lastGithubEtag');
    const lastGithubSha  = await db.getConfig('lastGithubSha');
    if (lastGithubEtag) headers['If-None-Match'] = lastGithubEtag;

    const res = await fetch(SYNC_URL, { headers });
    if (res.status === 304) {
      // Remote unchanged: only push if local is dirty
      if (state.localDirty && lastGithubSha) {
        await pushLocal(cfg.key, lastGithubSha);
      }
    } else if (res.ok) {
      // Remote has new data: extract and store etag + sha
      const json = await res.json();
      const remoteSha  = json.sha;
      const remoteEtag = res.headers.get('ETag');
      // Mirror the encodeURIComponent/unescape used in pushLocal so non-ASCII
      // data (e.g. account holder names) round-trips correctly through base64.
      const remoteData = JSON.parse(decodeURIComponent(escape(atob(json.content.replace(/\n/g, '')))));

      if (remoteEtag) await db.setConfig('lastGithubEtag', remoteEtag);
      if (remoteSha) await db.setConfig('lastGithubSha', remoteSha);

      // Compare timestamps to decide pull vs push
      const lastSynced     = await db.getConfig('lastGithubSync');
      const lastSyncedTime = lastSynced ? Date.parse(lastSynced) : 0;
      const remoteTime     = remoteData?.exportedAt ? Date.parse(remoteData.exportedAt) : 0;

      if (remoteTime > lastSyncedTime) {
        // Pull: accept remote structure, but keep newer local readings and
        // local-only sheets. Strip period ids before the rewrite — remote ids
        // and local-only ids can collide, so let IndexedDB assign fresh ones.
        const { merged, hadNewer } = mergeReadings(remoteData.periods || [], state.periods, { keepOtherOnly: true });
        remoteData.periods = merged.map(({ id, ...rest }) => rest);
        await applyBackupData(remoteData);
        await reloadStateFromDB();
        await setLocalDirty(false);
        render();
        await db.setConfig('lastGithubSync', remoteData.exportedAt);

        // If local had newer readings or extra sheets, push the merged result back
        if (hadNewer) await pushLocal(cfg.key, remoteSha);
      } else if (state.localDirty) {
        // Push: merge any newer remote readings into local first, then send
        const { merged, hadNewer } = mergeReadings(state.periods, remoteData.periods || []);
        if (hadNewer) {
          await db.replaceAllPeriods(merged);
          state.periods = await db.getPeriods();
        }
        await pushLocal(cfg.key, remoteSha);
      }
    } else if (res.status === 404) {
      // First push
      await pushLocal(cfg.key, null);
    } else {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    if (!isAuto) {
      const syncBtn = document.getElementById('btn-sync');
      if (syncBtn) {
        syncBtn.textContent = '✓ Synced';
        setTimeout(() => {
          const btn = document.getElementById('btn-sync');
          if (btn) { btn.textContent = origText; btn.disabled = false; }
        }, 2000);
      }
    }
  } catch (e) {
    if (!isAuto) {
      alert(`Sync failed: ${e.message}`);
      btn.textContent = origText;
      btn.disabled = false;
    }
  } finally {
    _syncing = false;
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
      await reloadStateFromDB();
    }
    await db.setConfig('dataFileHandle', handle);
    state.dataFileHandle = handle;
    await syncToFile();
    ui.renderDataTab(!!state.currentPeriodId, handle, state.githubConfig, state.maxSheets);
    render();
  } catch (e) { if (e.name !== 'AbortError') console.error(e); }
}

async function unlinkDataFile() {
  await db.setConfig('dataFileHandle', null);
  state.dataFileHandle = null;
  ui.renderDataTab(!!state.currentPeriodId, null, state.githubConfig, state.maxSheets);
}

async function resetApp() {
  if (!confirm('Clear all local data and restart? Sync data on GitHub is preserved.')) return;

  try {
    // Close our connection and wait for the delete to finish — reloading
    // while it's pending lets the new page reopen the DB and block it.
    await db.deleteDB();
    // Clear service worker cache
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
    }
    // Reload to start fresh
    location.reload();
  } catch (e) {
    alert(`Reset failed: ${e.message}`);
  }
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
