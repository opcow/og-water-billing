const DB_NAME = 'WaterBilling';
const DB_VERSION = 1;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('accounts')) {
        db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true })
          .createIndex('sortOrder', 'sortOrder');
      }
      if (!db.objectStoreNames.contains('periods')) {
        db.createObjectStore('periods', { keyPath: 'id', autoIncrement: true })
          .createIndex('endDate', 'endDate');
      }
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config');
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
  });
}

// Wraps a single IDB operation in a transaction. fn(store, txn) must return a
// request, or null to signal completion via txn.oncomplete.
function idb(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const txn = db.transaction(storeName, mode);
    const store = txn.objectStore(storeName);
    const req = fn(store, txn);
    if (req) {
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    } else {
      txn.oncomplete = () => resolve();
      txn.onerror = e => reject(e.target.error);
    }
  }));
}

// ── Config ────────────────────────────────────────────────────────────────────

export const getConfig = key => idb('config', 'readonly', s => s.get(key));
export const setConfig = (key, val) => idb('config', 'readwrite', s => s.put(val, key));

// ── Accounts ──────────────────────────────────────────────────────────────────

export const getAccounts = () =>
  idb('accounts', 'readonly', s => s.getAll())
    .then(list => list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));

export const saveAccount = acc =>
  idb('accounts', 'readwrite', s => acc.id ? s.put(acc) : s.add(acc));

export const deleteAccount = id => idb('accounts', 'readwrite', s => s.delete(id));

export function replaceAllAccounts(accounts) {
  return idb('accounts', 'readwrite', (store, txn) => {
    store.clear();
    for (const a of accounts) {
      // Keep id if present so existing readings stay linked; omit id for new ones.
      const rec = { ...a };
      if (!rec.id) delete rec.id;
      store.put(rec);
    }
    return null;
  });
}

// ── Periods ───────────────────────────────────────────────────────────────────

export const getPeriods = () =>
  idb('periods', 'readonly', s => s.getAll())
    .then(list => list.sort((a, b) => a.endDate.localeCompare(b.endDate)));

export const getPeriod = id => idb('periods', 'readonly', s => s.get(id));

export const savePeriod = period =>
  idb('periods', 'readwrite', s => period.id ? s.put(period) : s.add(period));

export const deletePeriod = id => idb('periods', 'readwrite', s => s.delete(id));

export function replaceAllPeriods(periods) {
  return idb('periods', 'readwrite', (store) => {
    store.clear();
    for (const p of periods) {
      const rec = { ...p };
      if (!rec.id) delete rec.id;
      store.put(rec);
    }
    return null;
  });
}

// ── Seed ──────────────────────────────────────────────────────────────────────

const DEFAULT_RATE_TABLE = [
  [2000, 3.61, 1000, 20.44, 3],
  [4999, 9.62, 1000],
  ['-', 10.82, 1000],
];

const DEFAULT_ACCOUNTS = [
  { name: '#2', accountHolder: '', email: '', phone: '', isMaster: false, sortOrder: 0 },
  { name: '#3', accountHolder: '', email: '', phone: '', isMaster: false, sortOrder: 1 },
  { name: '#4', accountHolder: '', email: '', phone: '', isMaster: false, sortOrder: 2 },
  { name: '#5', accountHolder: '', email: '', phone: '', isMaster: false, sortOrder: 3 },
  { name: '#6', accountHolder: '', email: '', phone: '', isMaster: false, sortOrder: 4 },
  { name: '#10', accountHolder: '', email: '', phone: '', isMaster: false, sortOrder: 5 },
  { name: '#11', accountHolder: '', email: '', phone: '', isMaster: false, sortOrder: 6 },
  { name: 'Pool Co.', accountHolder: '', email: '', phone: '', isMaster: false, sortOrder: 7 },
  { name: 'Emily', accountHolder: '', email: '', phone: '', isMaster: false, sortOrder: 8 },
  { name: 'Master', accountHolder: '', email: '', phone: '', isMaster: true, sortOrder: 99 },
];

export async function seedIfEmpty() {
  const [accounts, rateTable] = await Promise.all([
    getAccounts(),
    getConfig('rateTable'),
  ]);
  if (accounts.length === 0) {
    for (const a of DEFAULT_ACCOUNTS) await saveAccount(a);
  }
  if (!rateTable) {
    await setConfig('rateTable', DEFAULT_RATE_TABLE);
  }
}
