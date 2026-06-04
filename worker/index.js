const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
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
      const res = await fetch(apiUrl, { headers: ghHeaders });
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
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
