# gs_billing

Static water-billing PWA. No bundler — files are served as-is.

## Versioning / cache busting

Cache-busting `?v=…` query strings and the service-worker `CACHE` name are
**generated from file content hashes** — don't edit them by hand. After changing
any asset (`js/*.js`, `css/styles.css`) and before committing:

```sh
node build.mjs
```

The script restamps every reference in `index.html`, `sw.js`, and the JS imports
so versions can never drift. It's idempotent: a no-op run reports no changes.
