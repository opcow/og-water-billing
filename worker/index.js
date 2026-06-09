const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
};

// Caps PUT bodies; the GitHub contents API rejects large files anyway, so
// anything bigger than this is junk or abuse.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function keyMatches(given, expected) {
  if (!expected || !given) return false;
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (!keyMatches(request.headers.get('X-Sync-Key'), env.SYNC_KEY)) {
      return new Response('Unauthorized', { status: 401, headers: CORS });
    }

    const [owner, repo] = env.GITHUB_REPO.split('/');
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${env.FILE_PATH}`;
    const ghHeaders = {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'water-billing-sync',
    };

    if (request.method === 'GET') {
      const ifNoneMatch = request.headers.get('If-None-Match');
      const fetchHeaders = { ...ghHeaders, ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}) };
      const res = await fetch(apiUrl, { headers: fetchHeaders });
      if (res.status === 304) {
        return new Response(null, { status: 304, headers: CORS });
      }
      const etag = res.headers.get('ETag');
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}), ...CORS },
      });
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BODY_BYTES) {
        return new Response('Payload too large', { status: 413, headers: CORS });
      }
      const res = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body,
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    return new Response('Method not allowed', { status: 405, headers: CORS });
  },
};
