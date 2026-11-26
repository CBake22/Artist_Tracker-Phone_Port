// Offline app shell plus bounded runtime caching for Apple Music artwork.
const V = 'tracker-v16';
const ART = 'tracker-artwork-v1';
const SHELL = ['./', 'index.html', 'classify.js', 'store.js', 'manifest.json'];
const ART_HOSTS = new Set(['is1-ssl.mzstatic.com','is2-ssl.mzstatic.com','is3-ssl.mzstatic.com','is4-ssl.mzstatic.com','is5-ssl.mzstatic.com','is6-ssl.mzstatic.com','is7-ssl.mzstatic.com','is8-ssl.mzstatic.com','is9-ssl.mzstatic.com','is10-ssl.mzstatic.com','is11-ssl.mzstatic.com','is12-ssl.mzstatic.com','is13-ssl.mzstatic.com','is14-ssl.mzstatic.com','is15-ssl.mzstatic.com','is16-ssl.mzstatic.com','is17-ssl.mzstatic.com','is18-ssl.mzstatic.com','is19-ssl.mzstatic.com','is20-ssl.mzstatic.com','is21-ssl.mzstatic.com','is22-ssl.mzstatic.com','is23-ssl.mzstatic.com','is24-ssl.mzstatic.com','is25-ssl.mzstatic.com','is26-ssl.mzstatic.com','is27-ssl.mzstatic.com','is28-ssl.mzstatic.com','is29-ssl.mzstatic.com','is30-ssl.mzstatic.com','is31-ssl.mzstatic.com','is32-ssl.mzstatic.com','is33-ssl.mzstatic.com','is34-ssl.mzstatic.com','is35-ssl.mzstatic.com','is36-ssl.mzstatic.com','is37-ssl.mzstatic.com','is38-ssl.mzstatic.com','is39-ssl.mzstatic.com','is40-ssl.mzstatic.com']);
const tag = r => r.headers.get('etag') || r.headers.get('last-modified') || '';
const notify = () => self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage('updated')));
async function trimArtwork(cache, max = 250) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key);
}
self.addEventListener('install', e => e.waitUntil(
  caches.open(V).then(async c => {
    // A missing optional icon must not prevent the app shell from installing.
    await Promise.all(SHELL.map(async u => { try { const r = await fetch(new Request(u, { cache: 'reload' })); if (r.ok) await c.put(u, r); } catch {} }));
  }).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== ART).map(k => caches.delete(k)))).then(() => clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const url = new URL(r.url);
  if (url.origin !== location.origin && ART_HOSTS.has(url.hostname) && r.destination === 'image') {
    e.respondWith(caches.open(ART).then(async cache => {
      const hit = await cache.match(r);
      const refresh = fetch(r).then(async response => {
        if (response.ok || response.type === 'opaque') { await cache.put(r, response.clone()); await trimArtwork(cache); }
        return response;
      }).catch(() => hit);
      if (hit) { e.waitUntil(refresh); return hit; }
      return refresh;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r.url, { cache: 'no-cache' }).then(async res => {
      if (res.ok) {
        const changed = hit && tag(hit) !== tag(res);
        await c.put(r, res.clone());
        if (changed) notify();
      }
      return res;
    }).catch(() => hit);
    if (hit) { e.waitUntil(net); return hit; }
    return net;
  }));
});
