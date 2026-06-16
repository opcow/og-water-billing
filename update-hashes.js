#!/usr/bin/env node
/**
 * Update content-hash query strings for cache-busting.
 *
 * This app uses SHA256 content hashes (first 8 chars) as query params (?v=...) on
 * JS and CSS assets to cache-bust the service worker. When files change, this script
 * recomputes hashes and updates all references:
 *   - each module's `import ... from './dep.js?v=...'` statements
 *   - index.html: <link href="...?v=..."> and <script src="...?v=...">
 *   - sw.js: ASSETS array and CACHE name
 *
 * Modules are processed in dependency order: a module is hashed only after the
 * imports inside it have been rewritten to its dependencies' fresh hashes. This
 * matters because rewriting an import changes the file's content (and thus its own
 * hash), so dependents must be hashed last.
 *
 * Usage:
 *   node update-hashes.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

// JS/CSS modules in dependency order (each file listed after every module it
// imports). `imports` names the local modules referenced via `from './x.js?v=...'`.
const MODULES = [
  { file: 'css/styles.css', imports: [] },
  { file: 'js/db.js',       imports: [] },
  { file: 'js/billing.js',  imports: [] },
  { file: 'js/ui.js',       imports: ['js/billing.js'] },
  { file: 'js/app.js',      imports: ['js/db.js', 'js/billing.js', 'js/ui.js'] },
];

function sha8(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

// Rewrite this module's import query strings, then hash its (possibly updated) content.
const hashes = {};
for (const { file, imports } of MODULES) {
  const abs = path.join(ROOT, file);
  let content = fs.readFileSync(abs, 'utf8');
  for (const dep of imports) {
    const base = dep.replace(/^js\//, '').replace(/\./g, '\\.');   // './billing.js'
    const pattern = new RegExp(`(from '\\./${base}\\?v=)[\\da-f]{8}(')`);
    content = content.replace(pattern, `$1${hashes[dep]}$2`);
  }
  fs.writeFileSync(abs, content, 'utf8');
  hashes[file] = sha8(content);
}

console.log('New hashes:');
MODULES.forEach(({ file }) => console.log(`  ${file}: ${hashes[file]}`));

// Update index.html (css + app.js entry point)
let indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
indexHtml = indexHtml.replace(
  /href="css\/styles\.css\?v=[\da-f]{8}"/,
  `href="css/styles.css?v=${hashes['css/styles.css']}"`
);
indexHtml = indexHtml.replace(
  /src="js\/app\.js\?v=[\da-f]{8}"/,
  `src="js/app.js?v=${hashes['js/app.js']}"`
);
fs.writeFileSync(path.join(ROOT, 'index.html'), indexHtml, 'utf8');
console.log('\n✓ Updated index.html');

// Update sw.js: ASSETS array and CACHE name (CACHE keyed off app.js's hash)
let swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
swJs = swJs.replace(
  /const CACHE = 'water-billing-[\da-f]{8}'/,
  `const CACHE = 'water-billing-${hashes['js/app.js']}'`
);
['css/styles.css', 'js/app.js', 'js/billing.js', 'js/db.js', 'js/ui.js'].forEach(file => {
  const pattern = new RegExp(`('\\./${file.replace(/\./g, '\\.')}\\?v=)[\\da-f]{8}(')`);
  swJs = swJs.replace(pattern, `$1${hashes[file]}$2`);
});
fs.writeFileSync(path.join(ROOT, 'sw.js'), swJs, 'utf8');
console.log('✓ Updated sw.js (CACHE name and ASSETS array)');

console.log('\nDone! Commit the changes.');
