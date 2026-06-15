# Bug Report

## Bugs

### 1. `handleNewPeriod` next-period date calculation is wrong
**File:** `js/app.js:720`

```js
new Date(...latest.endDate.split('-').map((v, i) => i === 1 ? +v - 1 : +v))
```

Mutates the month index for JS's 0-indexed months, then at line 722 computes `nextDay` as `min(billingDay, daysInFeb)`. The resulting `nextEnd` month can drift by a full cycle near month boundaries. The "New Sheet" button bypasses the `startDate` validation at line 807 and silently produces a wrong date when the previous end date falls near month boundaries.

### 2. `trimOldPeriods` doesn't preserve `fixedCharge` or `meterDefective`
**File:** `js/app.js:688-697`

Only `phone` and `accountHolder` are merged back from deleted period snapshots into current accounts. If an account had a `fixedCharge` or `meterDefective` set in an old period and the current account doesn't, that configuration is silently lost.

### 3. `githubSync` has no concurrency guard
**File:** `js/app.js:1383`

Auto-sync (every 60s via `setInterval`) and manual sync can overlap, causing conflicting PUTs and data races. `btn.disabled` only blocks the button, not the interval.

---

## Security & Robustness

### 4. Service worker `new URL()` can throw
**File:** `sw.js:39`

If a browser extension or internal request has a malformed URL, the fetch handler crashes the entire SW. Wrap in `try/catch`.

### 5. Legacy `btoa(unescape(encodeURIComponent(...)))` for base64
**File:** `js/app.js:1361`

Produces incorrect output for characters outside BMP. Use `Uint8Array` + `String.fromCharCode` instead.

### 6. No rate limiting on sync API
**File:** `worker/index.js`

The Worker accepts PUT bodies up to 5MB with no throttling per IP or per key. Abuse could hit GitHub API rate limits and lock the account.

---

## UX & Data Integrity

### 7. File import picker uses `'*/*'`
**File:** `js/app.js:1162, 1262`

Should be `'.json'` or `'application/json'` to prevent picking non-JSON files.

### 8. Popover closes on accidental clicks
**File:** `js/app.js:256, 262, 268`

Year nav buttons use `e.stopPropagation()` to prevent the document close handler, but clicking empty space in the popover still closes it.

### 9. `rateTable[0]` assumed to exist throughout codebase
**Files:** `js/app.js:857`, `js/billing.js:2`, `js/ui.js:239-241`

If the rate table is ever empty or corrupt, the app throws. No defensive checks.

---

## Maintainability

### 10. Cache version drift
**File:** `sw.js:1`

Cache version `water-billing-v98` and asset query strings (`?v=33`, `?v=96`, etc.) are manually bumped in independent locations. They will inevitably drift, causing stale assets or failed SW updates.

### 11. Import version strings must be manually updated
**File:** `js/app.js:1-3`

`?v=6`, `?v=8`, `?v=22` on module imports must be bumped when the corresponding files change — easy to forget.

### 12. `_periodIsFirst` global defaults to `true`
**File:** `js/app.js:761`

If `init()` fails mid-load and the user somehow triggers the period dialog before state loads, they get a first-period dialog instead of a normal one.
