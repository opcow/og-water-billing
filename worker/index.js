const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (request.headers.get('X-Sync-Key') !== env.SYNC_KEY) {
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
      const res = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: await request.text(),
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    return new Response('Method not allowed', { status: 405, headers: CORS });
  },
};
