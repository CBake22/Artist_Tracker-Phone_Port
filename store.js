// Browser replacement for Itunes.py + Db.py + Main.py. Exposes localApi(), autoCheck().
const BASE = 'https://itunes.apple.com';
const CHECK_EVERY_MS = 6 * 3600 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- iTunes client (fetch, with JSONP fallback if the browser blocks CORS) ----------
function jsonp(url) {
  return new Promise((res, rej) => {
    const cb = '_jp' + Math.random().toString(36).slice(2), s = document.createElement('script');
    const done = () => { clearTimeout(t); delete window[cb]; s.remove(); };
    const t = setTimeout(() => { done(); rej(new Error('timeout')); }, 10000);
    window[cb] = d => { done(); res(d); };
    s.onerror = () => { done(); rej(new Error('network error')); };
    s.src = url + '&callback=' + cb;
    document.head.append(s);
  });
}
async function get(path, params) {
  const url = BASE + path + '?' + new URLSearchParams(params);
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      let data;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        data = await r.json();
      } catch (e) { if (e instanceof TypeError) data = await jsonp(url); else throw e; }
      if (!data || typeof data !== 'object') throw new Error('unexpected response');
      return data;
    } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw new Error('iTunes API unavailable: ' + last.message);
}
async function searchArtists(term, limit = 10) {
  const d = await get('/search', { term, entity: 'musicArtist', limit, country: 'us' });
  return (d.results || []).filter(a => a.artistId && a.artistName).map(a => ({
    artist_id: a.artistId, name: a.artistName, url: a.artistLinkUrl, genre: a.primaryGenreName }));
}
function parseRelease(x, followed, artistId) {
  const cid = parseInt(x.collectionId, 10), name = String(x.collectionName ?? '').trim();
  if (!cid || !name) return null;
  const date = String(x.releaseDate || '').slice(0, 10), url = x.collectionViewUrl || '';
  const credited = String(x.artistName || '');
  return {
    collection_id: cid, name,
    release_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    url: url.startsWith('https://') ? url : null,
    artwork_url: String(x.artworkUrl100 || '').replace('100x100', '600x600'),
    type: String(x.collectionType || 'Album'), credited_artist: credited,
    genre: String(x.primaryGenreName || ''), track_count: parseInt(x.trackCount, 10) || 0,
    explicit: String(x.collectionExplicitness || ''),
    ...Classify.classify(name, credited, followed, artistId),
  };
}
async function lookupArtist(id, limit = 200) {
  const results = (await get('/lookup', { id, entity: 'album', sort: 'recent', limit })).results || [];
  const a = results.find(x => x.wrapperType === 'artist');
  if (!a || !a.artistId || !a.artistName) return null;
  const releases = []; let skipped = 0;
  for (const x of results) {
    if (x.wrapperType !== 'collection') continue;
    const r = parseRelease(x, a.artistName, a.artistId);
    r ? releases.push(r) : skipped++;
  }
  releases.sort((p, q) => q.release_date.localeCompare(p.release_date));
  return { artist_id: a.artistId, name: a.artistName, url: a.artistLinkUrl, releases, skipped };
}

// ---------- IndexedDB ----------
const dbp = new Promise((res, rej) => {
  const q = indexedDB.open('release-tracker', 2);
  q.onupgradeneeded = e => {
    const d = q.result;
    if (e.oldVersion < 1) {
      d.createObjectStore('artists', { keyPath: 'artist_id' });
      const releases = d.createObjectStore('releases', { keyPath: 'collection_id' });
      releases.createIndex('artist_id', 'artist_id');
      releases.createIndex('artist_ids', 'artist_ids', { multiEntry: true });
      d.createObjectStore('meta', { keyPath: 'key' });
    } else if (e.oldVersion < 2) {
      const releases = q.transaction.objectStore('releases');
      releases.createIndex('artist_ids', 'artist_ids', { multiEntry: true });
      // Convert existing single-owner rows without deleting or re-fetching any data.
      releases.openCursor().onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;
        const row = cursor.value;
        if (!Array.isArray(row.artist_ids)) row.artist_ids = [row.artist_id];
        cursor.update(row);
        cursor.continue();
      };
    }
  };
  q.onsuccess = () => res(q.result);
  q.onerror = () => rej(q.error);
});
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const creditedOwnerIds = (credited, arts) => {
  const hay = ' ' + Classify.norm(credited) + ' ';
  return arts.filter(a => { const name = Classify.norm(a.name); return name && hay.includes(' ' + name + ' '); }).map(a => Number(a.artist_id));
};
async function tx(stores, mode, fn) {
  const t = (await dbp).transaction(stores, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); });
  const out = await fn(...[].concat(stores).map(s => t.objectStore(s)));
  await done;
  return out;
}
const DB = {
  artists: () => tx('artists', 'readonly', s => req(s.getAll()))
    .then(a => a.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }))),
  allReleases: () => tx('releases', 'readonly', s => req(s.getAll())),
  artistReleases: id => tx('releases', 'readonly', s => req(s.index('artist_ids').getAll(id))),
  addArtist: a => tx('artists', 'readwrite', async s => { if (!await req(s.get(a.artist_id))) s.put(a); }),
  removeArtist: id => tx(['releases', 'artists'], 'readwrite', async (r, a) => {
    const rows = await req(r.index('artist_ids').getAll(id));
    for (const row of rows) {
      const owners = (Array.isArray(row.artist_ids) ? row.artist_ids : [row.artist_id]).filter(x => Number(x) !== Number(id));
      if (!owners.length) r.delete(row.collection_id);
      else r.put({ ...row, artist_ids: owners, artist_id: owners[0] });
    }
    a.delete(id);
  }),
  // `detected` and first_seen_at are only set on first insert, like the SQL upsert.
  addReleases: (id, list) => tx(['releases', 'artists'], 'readwrite', async (s, a) => {
    const followed = await req(a.getAll());
    for (const r of list) {
      const old = await req(s.get(r.collection_id));
      const owners = new Set([...(old?.artist_ids || (old ? [old.artist_id] : [])), id,
        ...creditedOwnerIds(r.credited_artist, followed)].map(Number));
      s.put({ ...old, ...r, artist_id: old?.artist_id ?? id, artist_ids: [...owners],
              detected: old ? old.detected : (r.detected || 0),
              first_seen_at: old ? old.first_seen_at : Date.now() });
    }
  }),
  getMeta: k => tx('meta', 'readonly', async s => (await req(s.get(k)))?.value),
  setMeta: (k, v) => tx('meta', 'readwrite', async s => { s.put({ key: k, value: String(v) }); }),
  reclassify: () => tx(['meta', 'releases', 'artists'], 'readwrite', async (m, r, a) => {
    const v = await req(m.get('classifier_version'));
    if (v && v.value === String(Classify.VERSION)) return 0;
    const arts = new Map((await req(a.getAll())).map(x => [x.artist_id, x]));
    const rows = await req(r.getAll());
    const followed = [...arts.values()];
    for (const x of rows) {
      const ar = arts.get(x.artist_id); if (!ar) continue;
      const owners = new Set([...(x.artist_ids || [x.artist_id]),
        ...creditedOwnerIds(x.credited_artist || '', followed)].map(Number));
      r.put({ ...x, ...Classify.classify(x.name, x.credited_artist || '', ar.name, ar.artist_id),
        artist_ids: [...owners] });
    }
    m.put({ key: 'classifier_version', value: String(Classify.VERSION) });
    return rows.length;
  }),
};
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});  // ask iOS not to evict
const ready = DB.reclassify().catch(e => console.error('reclassify failed', e));

// ---------- release list (collapses repeat editions) ----------
async function listReleases() {
  const [rows, arts] = await Promise.all([DB.allReleases(), DB.artists()]);
  const names = new Map(arts.map(a => [a.artist_id, a.name]));
  rows.sort((a, b) => (!a.release_date - !b.release_date) ||
    b.release_date.localeCompare(a.release_date) || b.collection_id - a.collection_id);
  const kept = [], lastDate = {}, lastRow = {};
  for (const r of rows) {
    r.artist_ids = [...new Set((Array.isArray(r.artist_ids) ? r.artist_ids : [r.artist_id]).map(Number))];
    r.artist_names = r.artist_ids.map(id => names.get(id)).filter(Boolean);
    r.artist_name = names.get(r.artist_id) || r.artist_names[0] || '';
    r.is_feature = !!r.is_feature;
    r.is_new = !!r.detected && (Date.now() - (r.first_seen_at || 0)) <= Classify.NEW_FLAG_DAYS * 864e5;
    const key = r.dedupe_key, d = Classify.parseDate(r.release_date), prev = lastDate[key];
    if (key && prev != null && d !== null && Math.abs(prev - d) <= Classify.DUP_DAYS) {
      lastRow[key].is_new = lastRow[key].is_new || r.is_new;
      continue;
    }
    if (key) { lastDate[key] = d; lastRow[key] = r; }
    r.category = Classify.categoryOf(r.kind, r.is_feature, r.variant);
    kept.push(r);
  }
  return kept;
}

// ---------- checking for new releases ----------
async function checkArtist(artist) {
  const data = await lookupArtist(artist.artist_id);
  if (!data) return 0;
  const existing = await DB.artistReleases(artist.artist_id);
  const known = new Set(existing.map(r => r.collection_id)), seen = {};
  for (const r of existing) {
    const d = Classify.parseDate(r.release_date);
    if (r.dedupe_key && d !== null) (seen[r.dedupe_key] ||= []).push(d);
  }
  let found = 0;
  for (const r of data.releases) {  // newest first
    if (!known.has(r.collection_id)) {
      r.detected = Classify.isRecent(r.release_date) && !Classify.isRepeat(r.dedupe_key, r.release_date, seen) ? 1 : 0;
      found += r.detected;
    }
    const d = Classify.parseDate(r.release_date);
    if (d !== null) (seen[r.dedupe_key] ||= []).push(d);
  }
  await DB.addReleases(artist.artist_id, data.releases);
  return found;
}
let checking = false;
async function checkReleases() {
  if (checking) return;
  checking = true;
  try {
    for (const a of await DB.artists()) {
      try { await checkArtist(a); } catch (e) { console.error('Check failed for', a.name, e); }
      await sleep(300);  // stay well under iTunes' rate limit
    }
    await DB.setMeta('last_check', Date.now());
  } finally { checking = false; }
}
// Called on open and when the app returns to the foreground. Returns true if it ran.
async function autoCheck() {
  await ready;
  if (checking || !(await DB.artists()).length) return false;
  if (Date.now() - Number(await DB.getMeta('last_check') || 0) < CHECK_EVERY_MS) return false;
  await checkReleases();
  return true;
}

// ---------- same routes the old FastAPI server exposed ----------
async function follow(id) {
  const data = await lookupArtist(id);
  if (!data) throw new Error('Artist not found');
  await DB.addArtist({ artist_id: data.artist_id, name: data.name, url: data.url });
  await DB.addReleases(data.artist_id, data.releases);  // seeded silently, no "New" flags
  return { followed: data.name, releases_stored: data.releases.length, skipped: data.skipped };
}
async function localApi(path, opts = {}) {
  await ready;
  const method = (opts.method || 'GET').toUpperCase(), u = new URL(path, 'http://x'), p = u.pathname;
  let m;
  if (p === '/artists' && method === 'GET') return DB.artists();
  if (p === '/releases') return listReleases();
  if (p === '/search') return searchArtists(u.searchParams.get('q') || '');
  if (p === '/check-now') { await checkReleases(); return { status: 'done' }; }
  if ((m = p.match(/^\/artists\/(\d+)\/follow$/))) return follow(+m[1]);
  if ((m = p.match(/^\/artists\/(\d+)$/)) && method === 'DELETE') { await DB.removeArtist(+m[1]); return { unfollowed: +m[1] }; }
  throw new Error('Not found');
}
