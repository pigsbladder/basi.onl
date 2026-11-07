// Cloudflare Pages Function: GET /api/where
// Tells the calculator which U.S. state Cloudflare thinks the visitor is in, so it can offer
// "Looks like you're in Texas. Use Texas?" The answer is only a suggestion and is never stored or logged.
export function onRequestGet({ request }) {
  const cf = request.cf || {};
  const state = cf.country === 'US' && /^[A-Z]{2}$/.test(cf.regionCode || '') ? cf.regionCode : null;
  return new Response(JSON.stringify({ state }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}
