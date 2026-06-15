# Water Billing PWA

A Chrome-installable progressive web app (PWA) for tracking water meter readings across ~9 sub-accounts. Replaces a Google Sheets + Apps Script workflow with a zero-server, offline-capable desktop app.

## Running the app

```bash
cd <repo>/billing
python -m http.server 8080
# Then open http://localhost:8080
```

The app runs entirely in the browser:
- **Storage:** IndexedDB (persisted locally)
- **Offline:** Service Worker caches all assets
- **No backend:** All data stays on your device

## Code structure

| File | Purpose |
|------|---------|
| `index.html` | Main shell, dialog/table markup |
| `js/app.js` | Init, event handlers, state management |
| `js/ui.js` | DOM rendering (period, settings, accounts) |
| `js/billing.js` | Billing calculations (tiered rates, prorating) |
| `js/db.js` | IndexedDB wrapper |
| `css/styles.css` | Light/dark theme, responsive layout |
| `sw.js` | Service worker (cache, offline) |
| `manifest.json` | PWA install metadata |

## Cache-busting with content hashes

This PWA uses **content-hash query strings** to cache-bust assets across browser and service-worker caches. When a file changes, its hash must be updated everywhere it's referenced.

### How it works

- Each JS/CSS file gets a **SHA256 hash (first 8 chars)** appended as `?v=...`
- When hashes change, the service worker's cache name changes, forcing a fresh fetch
- `index.html` is **not** hashed (SW forces re-check on page load)

**Files with hashes:**
- `index.html`: references `css/styles.css?v=...` and `js/app.js?v=...`
- `js/app.js`: imports `./ui.js?v=...`
- `sw.js`: 
  - `const CACHE = 'water-billing-<app.js-hash>'`
  - `ASSETS` array lists all cached files with their hashes

### Updating hashes

**Automated (recommended):**
```bash
node update-hashes.js
```
This recomputes all hashes and updates `index.html`, `js/app.js`, and `sw.js` in one pass.

**Manual (not recommended):**
After editing JS/CSS files:
1. Compute SHA256 hashes: `sha256sum js/app.js | cut -c1-8`
2. Update `?v=...` query strings in `index.html`
3. Update import hashes in `js/app.js`
4. Update `ASSETS` array in `sw.js`
5. Bump `const CACHE = 'water-billing-<new-hash>'` in `sw.js` (use app.js hash)

### Example: after editing `js/ui.js`

```bash
$ node update-hashes.js
New hashes:
  css/styles.css: a1b2c3d4
  js/app.js: e5f6a7b8
  js/billing.js: (unchanged)
  js/db.js: (unchanged)
  js/ui.js: c9d0e1f2

✓ Updated index.html
✓ Updated js/app.js imports
✓ Updated sw.js (CACHE name and ASSETS array)

Done! Commit the changes.
```

## Key features

### SMS billing
- **Tap an account's dollar amount** → modal preview of the SMS message
- User can enter or edit the phone number
- Taps "Send" → opens native SMS client with pre-filled body
- Master meter: tapping its amount is a no-op (no SMS capability)

### Accounts editor
- Master meter is **not editable** in Settings → Accounts (seeded by database)
- Regular accounts can have phone, account-holder name, fixed charge, defective flag
- Drag to reorder

### Billing calculations
- **Tiered rates:** first N gallons @ rate A, next N @ rate B, rest @ rate C
- **Flat base charge** (applied to all accounts)
- **Special rounding:** uses `Math.ceil(Math.round(amt * 10000) / 100) / 100` to match Google Sheets ROUNDUP
- **Prorating:** when a period starts/ends mid-month, adjust rate table to match those days

## Debugging

**Service Worker cache issues:**
- If old assets load after changes, do a **hard reload** (Ctrl+Shift+R / Cmd+Shift+R)
- Or manually clear site data in DevTools > Application > Clear storage
- The SW will detect the new `CACHE` name and activate the new version

**Data issues:**
- All data lives in IndexedDB (`WaterBilling` database)
- Export/import in Settings → Data tab backs up all accounts, periods, rate table

**Testing:**
- Open DevTools: Application > Service Workers to see active cache
- Check Console for any init errors
- IndexedDB > WaterBilling to inspect stored data
