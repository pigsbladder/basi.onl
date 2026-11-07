// Cloudflare Worker for basi.onl. Everything is a static file served from this repo, except /api/where.
//
// GET /api/where -> { "state": "TX" } or { "state": null }
// Tells the calculator which U.S. state Cloudflare thinks the visitor is in, so it can offer
// "Looks like you're in Texas. Use Texas?". It is only a suggestion; nothing is stored or logged.
export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/api/where') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
    const cf = request.cf || {};
    const state = cf.country === 'US' && /^[A-Z]{2}$/.test(cf.regionCode || '') ? cf.regionCode : null;
    return new Response(JSON.stringify({ state }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    });
  },
};
