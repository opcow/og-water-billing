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

export function closeDB() {
  if (_db) { _db.close(); _db = null; }
}

// Closes our connection first so the delete isn't blocked by it; a delete
// blocked only by other tabs is resolved optimistically (it completes once
// those tabs close).
export function deleteDB() {
  closeDB();
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => reject(req.error);
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
  { name: 'Meter 1', accountHolder: '', phone: '', sortOrder: 0 },
  { name: 'Meter 2', accountHolder: '', phone: '', sortOrder: 1 },
  { name: 'Meter 3', accountHolder: '', phone: '', sortOrder: 2 },
  { name: 'Meter 4', accountHolder: '', phone: '', sortOrder: 3 },
  { name: 'Meter 5', accountHolder: '', phone: '', sortOrder: 4 },
  { name: 'Meter 6', accountHolder: '', phone: '', sortOrder: 5 },
  { name: 'Meter 7', accountHolder: '', phone: '', sortOrder: 6 },
  { name: 'Meter 8', accountHolder: '', phone: '', sortOrder: 7 },
  { name: 'Meter 9', accountHolder: '', phone: '', sortOrder: 8 },
];

const DEFAULT_MASTER_METER = {
  id: 0,
  name: 'Master',
  accountHolder: '',
  phone: '',
  meterDefective: false,
  fixedCharge: null,
};

export async function seedIfEmpty() {
  const [accounts, rateTable, masterMeter] = await Promise.all([
    getAccounts(),
    getConfig('rateTable'),
    getConfig('masterMeter'),
  ]);
  if (accounts.length === 0) {
    for (const a of DEFAULT_ACCOUNTS) await saveAccount(a);
  }
  if (!rateTable) {
    await setConfig('rateTable', DEFAULT_RATE_TABLE);
  }
  if (!masterMeter) {
    await setConfig('masterMeter', DEFAULT_MASTER_METER);
  }
}
