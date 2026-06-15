#!/usr/bin/env node
// Content-hash version stamper. Cache-busting query strings (`?v=…`) and the
// service-worker CACHE name are derived from each file's content, so a version
// only changes when the file actually changes — no manual bumping, no drift.
//
// Run after editing any asset (and before committing):  node build.mjs
// Idempotent: running it with no source changes produces no diff.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Versioned assets, in dependency order: a file is listed AFTER everything it
// imports, so by the time we hash it, its dependencies' versions are already
// stamped into it and therefore baked into its own hash.
//   ref  — the filename as it appears in `<name>?v=…` references elsewhere
//   deps — other asset names this file imports (stamped in before hashing)
const ASSETS = [
  { name: 'db',      file: 'js/db.js',      ref: 'db.js'      },
  { name: 'billing', file: 'js/billing.js', ref: 'billing.js' },
  { name: 'ui',      file: 'js/ui.js',      ref: 'ui.js',      deps: ['billing'] },
  { name: 'app',     file: 'js/app.js',     ref: 'app.js',     deps: ['db', 'billing', 'ui'] },
  { name: 'styles',  file: 'css/styles.css', ref: 'styles.css' },
];

// Files that reference assets but are not themselves versioned assets.
const CONSUMERS = ['index.html', 'sw.js'];

const hash8 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replace every `<ref>?v=<token>` in `text` with the given version.
function stamp(text, ref, version) {
  const re = new RegExp(`(${escapeRe(ref)}\\?v=)[^"'\\s)]+`, 'g');
  return text.replace(re, `$1${version}`);
}

const byName = Object.fromEntries(ASSETS.map((a) => [a.name, a]));
const versions = {};
const changed = [];

function readWrite(relPath, transform) {
  const abs = join(ROOT, relPath);
  const before = readFileSync(abs, 'utf8');
  const after = transform(before);
  if (after !== before) {
    writeFileSync(abs, after);
    changed.push(relPath);
  }
  return after;
}

// 1) Compute each asset's version in dependency order, stamping in the versions
//    of its dependencies first so they contribute to its hash.
for (const asset of ASSETS) {
  const content = readWrite(asset.file, (text) => {
    for (const dep of asset.deps ?? []) text = stamp(text, byName[dep].ref, versions[dep]);
    return text;
  });
  versions[asset.name] = hash8(content);
}

// 2) Stamp all versions into the plain consumer files.
for (const consumer of CONSUMERS) {
  readWrite(consumer, (text) => {
    for (const asset of ASSETS) text = stamp(text, asset.ref, versions[asset.name]);
    return text;
  });
}

// 3) Derive the service-worker cache name from all versions combined, so any
//    asset change invalidates the whole cache and forces a SW update.
const cacheVersion = hash8(ASSETS.map((a) => versions[a.name]).join('|'));
readWrite('sw.js', (text) =>
  text.replace(/(const CACHE = ')[^']*(';)/, `$1water-billing-${cacheVersion}$2`)
);

// Report.
for (const a of ASSETS) console.log(`  ${a.ref.padEnd(11)} v=${versions[a.name]}`);
console.log(`  CACHE       water-billing-${cacheVersion}`);
console.log(changed.length ? `\nUpdated ${changed.length} file(s): ${changed.join(', ')}` : '\nNo changes — already up to date.');
