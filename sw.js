// Offline app shell. Pages load instantly from the cache; each launch quietly checks GitHub for newer
// copies (a tiny conditional request) and tells the page to reload once if anything changed.
const V = 'tracker-v9';
const SHELL = ['./', 'index.html', 'classify.js', 'store.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const tag = r => r.headers.get('etag') || r.headers.get('last-modified') || '';
const notify = () => self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage('updated')));

self.addEventListener('install', e => e.waitUntil(
  // cache:'reload' skips the browser's HTTP cache so a stale copy can never be stored
  caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;  // iTunes calls bypass the cache
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
    if (hit) { e.waitUntil(net); return hit; }  // instant from cache, refresh in the background
    return net;
  }));
});