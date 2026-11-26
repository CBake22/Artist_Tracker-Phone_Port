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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let response;
        try { response = await fetch(url, { signal: controller.signal }); }
        finally { clearTimeout(timer); }
        if (!response.ok) {
          const err = new Error('HTTP ' + response.status);
          err.status = response.status;
          throw err;
        }
        data = await response.json();
      } catch (e) {
        if (e instanceof TypeError) data = await jsonp(url);
        else throw e;
      }
      if (!data || typeof data !== 'object' || !Array.isArray(data.results))
        throw new Error('Unexpected Apple Music response');
      return data;
    } catch (e) {
      last = e;
      // Do not retry permanent client errors; retry rate limits, server errors and network failures.
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break;
      if (i < 2) await sleep(Math.min(8000, 1000 * (2 ** i)));
    }
  }
  throw new Error('Apple Music request failed: ' + (last?.message || 'unknown error'));
}
const FEATURE_CREDIT_RX = /[\(\[]\s*(?:feat\.?|featuring|ft\.?|with)\s+([^\)\]]+)[\)\]]/gi;
function featuredCredits(title, followedNames = []) {
  const matches = [...String(title || '').matchAll(FEATURE_CREDIT_RX)];
  const raw = matches.flatMap(m => Classify.splitCredits(m[1], followedNames));
  return [...new Map(raw.map(name => [Classify.norm(name), name])).values()];
}
async function searchArtists(term, limit = 10) {
  const d = await get('/search', { term, entity: 'musicArtist', limit, country: 'us' });
  return (d.results || []).filter(a => a.artistId && a.artistName).map(a => ({
    artist_id: a.artistId, name: a.artistName, url: a.artistLinkUrl, genre: a.primaryGenreName }));
}
function parseRelease(x, followed, artistId, followedNames = []) {
  const cid = parseInt(x.collectionId, 10), name = String(x.collectionName ?? '').trim();
  if (!cid || !name) return null;
  const date = String(x.releaseDate || '').slice(0, 10), url = x.collectionViewUrl || '';
  const credited = String(x.artistName || '');
  return {
    collection_id: cid, name, primary_artist_credit: credited, primary_artists: credited ? [credited] : [],
    featured_artists: featuredCredits(name, followedNames),
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
  const followedNames = (await DB.artists()).map(a => a.name);
  const results = (await get('/lookup', { id, entity: 'album', sort: 'recent', limit })).results || [];
  const a = results.find(x => x.wrapperType === 'artist');
  if (!a || !a.artistId || !a.artistName) return null;
  const releases = []; let skipped = 0;
  for (const x of results) {
    if (x.wrapperType !== 'collection') continue;
    const r = parseRelease(x, a.artistName, a.artistId, [...followedNames, a.artistName]);
    r ? releases.push(r) : skipped++;
  }
  releases.sort((p, q) => q.release_date.localeCompare(p.release_date));
  return { artist_id: a.artistId, name: a.artistName, url: a.artistLinkUrl, releases, skipped };
}

// ---------- IndexedDB ----------
const dbp = new Promise((res, rej) => {
  const q = indexedDB.open('release-tracker', 3);
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
const ownerIds = row => {
  const ids = Array.isArray(row?.artist_ids) && row.artist_ids.length ? row.artist_ids : [row?.artist_id];
  return [...new Set(ids.map(Number).filter(x => Number.isSafeInteger(x) && x > 0))];
};
const creditedOwnerIds = (credits, arts) => {
  const knownNames = arts.map(a => a.name);
  const parsed = (Array.isArray(credits) ? credits : [credits])
    .flatMap(credit => Classify.splitCredits(credit, knownNames));
  const credited = new Set(parsed.map(Classify.norm).filter(Boolean));
  return arts.filter(a => credited.has(Classify.norm(a.name))).map(a => Number(a.artist_id));
};
async function tx(stores, mode, fn) {
  const t = (await dbp).transaction(stores, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); });
  const out = await fn(...[].concat(stores).map(s => t.objectStore(s)));
  await done;
  return out;
}
// ---------- "seen" state for New releases ----------
// Seen ids live in the meta store ('seen_releases', a JSON array of collection ids).
async function mergeSeen(metaStore, ids) {
  let list = [];
  try { list = JSON.parse((await req(metaStore.get('seen_releases')))?.value || '[]'); } catch {}
  const set = new Set(list.map(Number));
  for (const id of ids) { const n = Number(id); if (Number.isSafeInteger(n) && n > 0) set.add(n); }
  metaStore.put({ key: 'seen_releases', value: JSON.stringify([...set]) });
}
// Before seen-tracking, a release stopped being "New" after NEW_FLAG_DAYS. Releases that were
// already past that window count as seen, so updating does not make old releases look new.
const legacySeenIds = rows => rows
  .filter(x => x?.detected && (x.first_seen_at || 0) < Date.now() - Classify.NEW_FLAG_DAYS * 864e5)
  .map(x => x.collection_id);

const DB = {
  artists: () => tx('artists', 'readonly', s => req(s.getAll()))
    .then(a => a.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }))),
  allReleases: () => tx('releases', 'readonly', s => req(s.getAll())),
  artistReleases: id => tx('releases', 'readonly', s => req(s.index('artist_ids').getAll(id))),
  addArtist: async a => {
    await tx('artists', 'readwrite', async s => { if (!await req(s.get(a.artist_id))) s.put(a); });
    await DB.reclassify(true);
  },
  removeArtist: id => tx(['releases', 'artists'], 'readwrite', async (r, a) => {
    const rows = await req(r.index('artist_ids').getAll(id));
    for (const row of rows) {
      const owners = ownerIds(row).filter(x => x !== Number(id));
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
      const owners = new Set([...ownerIds(old), Number(id),
        ...creditedOwnerIds([r.credited_artist, ...(r.featured_artists || [])].filter(Boolean), followed)].filter(Number.isSafeInteger));
      s.put({ ...old, ...r, artist_id: old?.artist_id ?? id, artist_ids: [...owners],
              detected: old ? old.detected : (r.detected || 0),
              first_seen_at: old ? old.first_seen_at : Date.now() });
    }
  }),
  exportData: () => tx(['artists', 'releases', 'meta'], 'readonly', async (a, r, m) => ({
    artists: await req(a.getAll()), releases: await req(r.getAll()), meta: await req(m.getAll())
  })),
  restoreData: async data => {
    const result = await tx(['artists', 'releases', 'meta'], 'readwrite', async (a, r, m) => {
    for (const artist of data.artists || []) {
      const id = Number(artist.artist_id);
      if (!Number.isSafeInteger(id) || id <= 0 || typeof artist.name !== 'string' || !artist.name.trim()) continue;
      const old = await req(a.get(id));
      a.put({ ...old, ...artist, artist_id: id });
    }
    for (const release of data.releases || []) {
      const id = Number(release.collection_id);
      if (!Number.isSafeInteger(id) || id <= 0 || typeof release.name !== 'string' || !release.name.trim()) continue;
      const old = await req(r.get(id));
      const incomingOwners = Array.isArray(release.artist_ids) && release.artist_ids.length ? release.artist_ids : [release.artist_id];
      const owners = new Set([...ownerIds(old), ...incomingOwners.map(Number)].filter(x => Number.isSafeInteger(x) && x > 0));
      const preferred = Number(old?.artist_id ?? release.artist_id);
      const primaryId = owners.has(preferred) ? preferred : [...owners][0];
      if (!owners.size || !primaryId) continue;
      const merged = { ...old, ...release, collection_id: id,
        artist_ids: [...owners], artist_id: primaryId,
        detected: old ? old.detected : (release.detected || 0),
        first_seen_at: old?.first_seen_at || release.first_seen_at || Date.now() };
      r.put(merged);
    }
    // Favorites and seen state are merged below / by the UI rather than overwritten.
    const SKIP_META = new Set(['classifier_version', 'favorites', 'seen_releases', 'seen_migrated']);
    for (const item of data.meta || []) if (item?.key && !SKIP_META.has(item.key)) m.put(item);
    const seenItem = (data.meta || []).find(item => item?.key === 'seen_releases');
    let seenIds = [];
    if (seenItem) { try { seenIds = JSON.parse(seenItem.value || '[]'); } catch {} }
    else seenIds = legacySeenIds(data.releases || []);  // backup from before seen-tracking
    await mergeSeen(m, seenIds);
    m.put({ key: 'seen_migrated', value: '1' });
    m.put({ key: 'classifier_version', value: '0' });
    return { artists: (data.artists || []).length, releases: (data.releases || []).length };
    });
    await DB.reclassify(true);
    return result;
  },
  getMeta: k => tx('meta', 'readonly', async s => (await req(s.get(k)))?.value),
  seenIds: async () => {
    try { return new Set(JSON.parse(await DB.getMeta('seen_releases') || '[]').map(Number)); }
    catch { return new Set(); }
  },
  markSeen: ids => tx('meta', 'readwrite', async m => { await mergeSeen(m, ids); }),
  migrateSeen: () => tx(['meta', 'releases'], 'readwrite', async (m, r) => {
    if (await req(m.get('seen_migrated'))) return;
    await mergeSeen(m, legacySeenIds(await req(r.getAll())));
    m.put({ key: 'seen_migrated', value: '1' });
  }),
  setMeta: (k, v) => tx('meta', 'readwrite', async s => { s.put({ key: k, value: String(v) }); }),
  reclassify: (force = false) => tx(['meta', 'releases', 'artists'], 'readwrite', async (m, r, a) => {
    const v = await req(m.get('classifier_version'));
    if (!force && v && v.value === String(Classify.VERSION)) return 0;
    const arts = new Map((await req(a.getAll())).map(x => [x.artist_id, x]));
    const rows = await req(r.getAll());
    const followed = [...arts.values()];
    for (const x of rows) {
      const ar = arts.get(x.artist_id); if (!ar) continue;
      // Rebuild inferred ownership from the primary lookup owner and parsed credits.
      // This removes false collaborator links created by the old comma-splitting parser.
      const featured = featuredCredits(x.name, followed.map(a => a.name));
      const credited = x.primary_artist_credit || x.credited_artist || '';
      const owners = new Set([Number(x.artist_id),
        ...creditedOwnerIds([credited, ...featured].filter(Boolean), followed)].filter(Number.isSafeInteger));
      r.put({ ...x, ...Classify.classify(x.name, credited, ar.name, ar.artist_id),
        primary_artist_credit: credited,
        primary_artists: credited ? [credited] : [],
        featured_artists: featured,
        artist_ids: [...owners] });
    }
    m.put({ key: 'classifier_version', value: String(Classify.VERSION) });
    return rows.length;
  }),
};
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});  // ask iOS not to evict
const ready = DB.reclassify().then(() => DB.migrateSeen());

// ---------- release list (collapses repeat editions) ----------
async function listReleases() {
  const [rows, arts, seen] = await Promise.all([DB.allReleases(), DB.artists(), DB.seenIds()]);
  const names = new Map(arts.map(a => [a.artist_id, a.name]));
  rows.sort((a, b) => (!a.release_date - !b.release_date) ||
    b.release_date.localeCompare(a.release_date) || b.collection_id - a.collection_id);
  const kept = [], lastDate = {}, lastRow = {};
  for (const r of rows) {
    r.artist_ids = [...new Set((Array.isArray(r.artist_ids) ? r.artist_ids : [r.artist_id]).map(Number))];
    r.artist_names = r.artist_ids.map(id => names.get(id)).filter(Boolean);
    r.artist_name = names.get(r.artist_id) || r.artist_names[0] || '';
    r.is_feature = !!r.is_feature;
    r.is_new = !!r.detected && !seen.has(Number(r.collection_id));
    r.group_ids = [r.collection_id];  // this row plus any repeat editions collapsed into it
    const key = r.dedupe_key, d = Classify.parseDate(r.release_date), prev = lastDate[key];
    if (key && prev != null && d !== null && Math.abs(prev - d) <= Classify.DUP_DAYS) {
      lastRow[key].is_new = lastRow[key].is_new || r.is_new;
      lastRow[key].group_ids.push(r.collection_id);
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
  const started = Date.now();
  const data = await lookupArtist(artist.artist_id);
  if (!data) throw new Error('Artist was not returned by Apple Music');
  const existing = await DB.artistReleases(artist.artist_id);
  const known = new Set(existing.map(r => r.collection_id)), seen = {};
  for (const r of existing) {
    const d = Classify.parseDate(r.release_date);
    if (r.dedupe_key && d !== null) (seen[r.dedupe_key] ||= []).push(d);
  }
  let found = 0;
  for (const r of data.releases) {
    if (!known.has(r.collection_id)) {
      r.detected = Classify.isRecent(r.release_date) && !Classify.isRepeat(r.dedupe_key, r.release_date, seen) ? 1 : 0;
      found += r.detected;
    }
    const d = Classify.parseDate(r.release_date);
    if (r.dedupe_key && d !== null) (seen[r.dedupe_key] ||= []).push(d);
  }
  await DB.addReleases(artist.artist_id, data.releases);
  return { found, releases: data.releases.length, duration_ms: Date.now() - started };
}
let checking = false;
async function checkReleases() {
  if (checking) return { skipped: true, succeeded: 0, failed: 0, found: 0 };
  checking = true;
  const summary = { skipped: false, succeeded: 0, failed: 0, found: 0, errors: [] };
  try {
    const artists = await DB.artists();
    await DB.setMeta('last_attempt', Date.now());
    let statuses = {};
    try { statuses = JSON.parse(await DB.getMeta('artist_check_status') || '{}'); } catch {}
    for (const a of artists) {
      const started = Date.now();
      try {
        const result = await checkArtist(a);
        summary.succeeded++; summary.found += result.found;
        statuses[a.artist_id] = { status: 'success', checked_at: Date.now(), releases: result.releases,
          new_releases: result.found, duration_ms: result.duration_ms, error: '' };
      } catch (e) {
        summary.failed++; summary.errors.push({ artist: a.name, message: e.message });
        statuses[a.artist_id] = { status: 'error', checked_at: Date.now(), duration_ms: Date.now() - started, error: e.message };
        console.error('Check failed for', a.name, e);
      }
      await DB.setMeta('artist_check_status', JSON.stringify(statuses));
      await sleep(300);
    }
    await DB.setMeta('last_attempt', Date.now());
    if (!summary.failed) await DB.setMeta('last_check', Date.now());
    return summary;
  } finally { checking = false; }
}
// Called on open and when the app returns to the foreground. Returns true if it ran.
async function autoCheck() {
  await ready;
  if (checking || !(await DB.artists()).length) return false;
  const lastAttempt = Number(await DB.getMeta('last_attempt') || await DB.getMeta('last_check') || 0);
  if (Date.now() - lastAttempt < CHECK_EVERY_MS) return false;
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
  if (p === '/check-now' && method === 'POST') return checkReleases();
  if ((m = p.match(/^\/artists\/(\d+)\/follow$/))) return follow(+m[1]);
  if ((m = p.match(/^\/artists\/(\d+)$/)) && method === 'DELETE') { await DB.removeArtist(+m[1]); return { unfollowed: +m[1] }; }
  throw new Error('Not found');
}