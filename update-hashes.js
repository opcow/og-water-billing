#!/usr/bin/env node
/**
 * Update content-hash query strings for cache-busting.
 *
 * This app uses SHA256 content hashes (first 8 chars) as query params (?v=...) on
 * JS and CSS assets to cache-bust the service worker. When files change, this script
 * recomputes hashes and updates all references:
 *   - index.html: <link href="...?v=..."> and <script src="...?v=...">
 *   - js/app.js: import statements with ?v=...
 *   - sw.js: ASSETS array and CACHE name
 *
 * Usage:
 *   node update-hashes.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

// Files to hash (relative to ROOT)
const FILES = [
  'css/styles.css',
  'js/app.js',
  'js/billing.js',
  'js/db.js',
  'js/ui.js',
];

// Compute SHA256 hash (first 8 chars)
function hash(filePath) {
  const content = fs.readFileSync(path.join(ROOT, filePath), 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

// Build a map of file → new hash
const newHashes = {};
FILES.forEach(file => {
  newHashes[file] = hash(file);
});

console.log('New hashes:');
Object.entries(newHashes).forEach(([file, h]) => {
  console.log(`  ${file}: ${h}`);
});

// Update index.html
let indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const indexUpdates = [
  { file: 'css/styles.css', pattern: /href="css\/styles\.css\?v=[\da-f]{8}"/ },
  { file: 'js/app.js', pattern: /src="js\/app\.js\?v=[\da-f]{8}"/ },
];
indexUpdates.forEach(({ file, pattern }) => {
  const newHash = newHashes[file];
  indexHtml = indexHtml.replace(pattern, `$&`.replace(/\?v=[\da-f]{8}/, `?v=${newHash}`));
});
// Simpler: just direct replacement
indexHtml = indexHtml.replace(
  /href="css\/styles\.css\?v=[\da-f]{8}"/,
  `href="css/styles.css?v=${newHashes['css/styles.css']}"`
);
indexHtml = indexHtml.replace(
  /src="js\/app\.js\?v=[\da-f]{8}"/,
  `src="js/app.js?v=${newHashes['js/app.js']}"`
);
fs.writeFileSync(path.join(ROOT, 'index.html'), indexHtml, 'utf8');
console.log('\n✓ Updated index.html');

// Update js/app.js imports
let appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
appJs = appJs.replace(
  /from '\.\/ui\.js\?v=[\da-f]{8}'/,
  `from './ui.js?v=${newHashes['js/ui.js']}'`
);
fs.writeFileSync(path.join(ROOT, 'js/app.js'), appJs, 'utf8');
console.log('✓ Updated js/app.js imports');

// Update sw.js: ASSETS array and CACHE name
let swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const appHash = newHashes['js/app.js'];
swJs = swJs.replace(
  /const CACHE = 'water-billing-[\da-f]{8}'/,
  `const CACHE = 'water-billing-${appHash}'`
);
const assetMap = {
  'css/styles.css': newHashes['css/styles.css'],
  'js/app.js': newHashes['js/app.js'],
  'js/billing.js': newHashes['js/billing.js'],
  'js/db.js': newHashes['js/db.js'],
  'js/ui.js': newHashes['js/ui.js'],
};
Object.entries(assetMap).forEach(([file, h]) => {
  const pattern = new RegExp(
    `('./${file}\\?v=)[\\da-f]{8}(')`
  );
  swJs = swJs.replace(pattern, `$1${h}$2`);
});
fs.writeFileSync(path.join(ROOT, 'sw.js'), swJs, 'utf8');
console.log('✓ Updated sw.js (CACHE name and ASSETS array)');

console.log('\nDone! Commit the changes.');
