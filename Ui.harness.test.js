// Run with: node ui_harness.js   (headless: real index.html script + store.js against a fake DOM and in-memory storage)
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const html = fs.readFileSync('index.html', 'utf8');
const inline = html.match(/<script>\n?([\s\S]*?)<\/script>/)[1];
const store = fs.readFileSync('store.js', 'utf8').replace('const ready = DB.reclassify().then(() => DB.migrateSeen());', 'const ready = Promise.resolve();');

// ---- permissive fake DOM: remembers what was appended, ignores everything else
const created = [], nodes = new Map();
function makeNode() {
  const props = { __n: 0, hidden: false, disabled: false, value: '', textContent: '', style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false } };
  return new Proxy(function () {}, {
    get(t, k) {
      if (k in props) return props[k];
      switch (k) {
        case 'append': return (...a) => { props.__n += a.length; };
        case 'replaceChildren': return (...a) => { props.__n = a.length; };
        case 'querySelector': return () => makeNode();
        case 'querySelectorAll': return () => [];
        case 'getAttribute': return () => null;
        case 'matches': return () => false;
        case 'remove': case 'addEventListener': case 'setAttribute': case 'removeAttribute':
        case 'click': case 'focus': case 'dispatchEvent': return () => {};
      }
      return undefined;
    },
    set(t, k, v) { props[k] = v; return true; },
  });
}
const sel = s => nodes.get(s) || (nodes.set(s, makeNode()), nodes.get(s));
const document = { hidden: false, title: '', body: makeNode(), head: makeNode(),
  createElement: () => { const n = makeNode(); created.push(n); return n; },
  querySelector: sel,
  querySelectorAll: s => s === '.filters input:checked' ? ['album', 'ep', 'single', 'feature', 'live'].map(value => ({ value })) : [],
  addEventListener() {} };

// ---- in-memory stand-in for IndexedDB transactions
const mk = keyPath => { const m = new Map(); const rq = v => { const r = {}; setTimeout(() => { r.result = v; r.onsuccess && r.onsuccess(); }, 0); return r; };
  const cl = x => structuredClone(x);
  return { m, get: k => rq(cl(m.get(k))), getAll: () => rq([...m.values()].map(cl)),
    index: () => ({ getAll: id => rq([...m.values()].filter(v => (v.artist_ids || [v.artist_id]).includes(id)).map(cl)) }),
    put: v => { m.set(v[keyPath], cl(v)); return rq(); }, delete: k => { m.delete(k); return rq(); } }; };
const S = { artists: mk('artist_id'), releases: mk('collection_id'), meta: mk('key') };

const counts = {};
const ctx = vm.createContext({ __S: S, console, setTimeout, clearTimeout, setInterval: () => 0, structuredClone, AbortController, URLSearchParams, URL,
  document, navigator: {}, indexedDB: { open: () => ({}) }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  window: { scrollTo() {}, addEventListener() {} }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {}, back() {} },
  addEventListener() {}, Option: function (text, value) { this.text = text; this.value = value; }, Event: function () {}, File: function () {},
  __w: (name, fn) => function (...a) { counts[name] = (counts[name] || 0) + 1; return fn.apply(this, a); } });
const run = code => vm.runInContext(code, ctx);
vm.runInContext(fs.readFileSync('classify.js', 'utf8') + '\n' + store, ctx);
run('tx = async (stores, mode, fn) => fn(...[].concat(stores).map(s => __S[s]));');
vm.runInContext(inline, ctx);   // the page's own script, started against an empty database

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const daysFromNow = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const Classify = run('Classify');
const reset = () => { for (const k of Object.keys(counts)) delete counts[k]; };
['renderFeed', 'renderUpcoming', 'renderFollowing', 'renderResults', 'renderProfile', 'load'].forEach(n => run(`${n} = __w('${n}', ${n});`));
const spy = { n: 0 }; const origSplit = Classify.splitCredits;
Classify.splitCredits = (...a) => { spy.n++; return origSplit(...a); };

(async () => {
  await tick(100);   // let the page's initial load() (empty database) finish
  // ---- seed 3 artists: 18 past releases + 1 collab + 45 upcoming
  const names = { 1: 'Alpha', 2: 'Beta', 3: 'Gamma' };
  let id = 1000;
  const row = (owner, name, credit, date, owners = [owner]) => ({ collection_id: ++id, artist_id: owner, artist_ids: owners, name, primary_artist_credit: credit,
    credited_artist: credit, featured_artists: [], release_date: date, artwork_url: 'https://x/300x300bb.jpg', url: 'https://c/' + id, track_count: 5,
    genre: 'Pop', detected: 0, first_seen_at: 1, ...Classify.classify(name, credit, names[owner], owner) });
  for (const [a, n] of Object.entries(names)) S.artists.m.set(+a, { artist_id: +a, name: n, url: 'https://a' });
  for (const a of [1, 2, 3]) for (let k = 0; k < 6; k++) { const r = row(a, names[a] + ' rec ' + k, names[a], daysFromNow(-(20 + k * 30 + a))); S.releases.m.set(r.collection_id, r); }
  { const r = row(1, 'Collab', 'Alpha & Beta', daysFromNow(-12), [1, 2]); S.releases.m.set(r.collection_id, r); }
  const upDates = [];
  for (let k = 1; k <= 45; k++) { const r = row(1, 'Up ' + k, 'Alpha', daysFromNow(k)); S.releases.m.set(r.collection_id, r); upDates.push(r.release_date); }

  // ---- T1: load renders only the visible tab, header and badges are right
  reset(); await run('load()'); await tick(); if (!counts.renderFeed) throw new Error('load failed: ' + sel('#status').textContent);
  assert.strictEqual(run('activeView'), 'tracker');
  assert.deepStrictEqual({ ...counts, load: undefined }, { renderFeed: 1, load: undefined }, 'only the tracker view rendered: ' + JSON.stringify(counts));
  assert.strictEqual(sel('#count').textContent, '19 releases · 3 followed artists');
  assert.strictEqual(String(sel('#upCount').textContent), '45');
  console.log('T1 load renders visible view only ok');

  // ---- T2: tabs render lazily, once, and are not re-rendered when nothing changed
  reset(); run("selectTab('upcoming')");
  assert.strictEqual(counts.renderUpcoming, 1);
  const first40 = [...upDates].sort().slice(0, 40), months = new Set(first40.map(d => d.slice(0, 7)));
  assert.strictEqual(sel('#upcomingFeed').__n, months.size + 40 + 1, 'headers + 40 rows + show-more button');
  run("selectTab('upcoming')"); assert.strictEqual(counts.renderUpcoming, 1, 'no re-render when not dirty');
  created.filter(n => String(n.textContent).startsWith('Show more')).pop().onclick();
  assert.strictEqual(counts.renderUpcoming, 2);
  assert.strictEqual(sel('#upcomingFeed').__n, new Set(upDates.map(d => d.slice(0, 7))).size + 45, 'all rows after Show more, no button left');
  run("selectTab('artists')"); assert.strictEqual(counts.renderFollowing, 1); assert.strictEqual(counts.renderResults, 1);
  run("selectTab('tracker')"); assert.strictEqual(counts.renderFeed || 0, 0, 'tracker was not dirty');
  console.log('T2 lazy tabs + upcoming paging ok');

  // ---- T3: a change while another tab is open only renders that tab; the others render when opened
  run("selectTab('artists')"); reset();
  run('toggleFavorite(1)'); await tick();
  assert.deepStrictEqual([counts.renderFollowing, counts.renderFeed || 0, counts.renderUpcoming || 0], [1, 0, 0]);
  run("selectTab('tracker')"); assert.strictEqual(counts.renderFeed, 1);
  run("selectTab('upcoming')"); assert.strictEqual(counts.renderUpcoming, 1);
  console.log('T3 dirty views render on open ok');

  // ---- T4: header count stays correct while the tracker is not visible
  run("selectTab('artists'); artistFilter = 'favorites'; renderAll();");
  assert.strictEqual(sel('#count').textContent, '7 releases · 1 favorite artist');
  run("artistFilter = 'all'; renderAll();");
  assert.strictEqual(sel('#count').textContent, '19 releases · 3 followed artists');
  console.log('T4 header updates from another tab ok');

  // ---- T5: credit parsing is cached per release until the followed list changes
  run("selectTab('tracker')"); run('artistsChanged()'); spy.n = 0; run('renderFeed()');
  const cold = spy.n; spy.n = 0; run('renderFeed()');
  assert.ok(cold > 0 && spy.n === 0, `cold=${cold} warm=${spy.n}`);
  console.log('T5 credit cache ok (cold', cold, 'splits, warm 0)');

  // ---- T6: profile renders once when opened, again on a change while open
  run('renderAll()'); reset(); run('showProfile(1)');
  assert.strictEqual(counts.renderProfile, 1, 'opened profile drawn exactly once');
  run('toggleFavorite(1)'); await tick(); assert.strictEqual(counts.renderProfile, 2);
  run("selectTab('tracker')");
  console.log('T6 profile rendering ok');

  // ---- T7: undo restores everything; commit mirrors the database without reloading
  const snapshot = () => JSON.stringify(run('releases').map(r => [r.collection_id, r.artist_id, [...r.artist_ids].sort()]));
  const before = snapshot(), a3 = run("artists.find(a => a.artist_id === 3)");
  await run('removeArtistWithUndo')(a3);
  assert.strictEqual(run('artists.length'), 2); assert.ok(run('releases.length') < JSON.parse(before).length);
  created.filter(n => n.textContent === 'Undo').pop().onclick();
  assert.strictEqual(run('artists.length'), 3); assert.strictEqual(snapshot(), before, 'undo restores every row');
  const a2 = run("artists.find(a => a.artist_id === 2)");
  reset(); await run('removeArtistWithUndo')(a2); await run('commitRemoval()'); await tick();
  assert.strictEqual(counts.load || 0, 0, 'no database reload after a removal');
  const fromDb = await run("api('/releases')");
  const key = r => JSON.stringify([r.collection_id, r.artist_id, [...r.artist_ids].sort(), r.artist_name, [...(r.artist_names || [])]]);
  const mem = run('releases').map(key).sort(), db = fromDb.map(key).sort();
  assert.deepStrictEqual(mem, db, 'in-memory list equals a fresh read from the database');
  assert.ok(!db.some(k => JSON.parse(k)[2].includes(2)), 'artist 2 owns nothing anymore');
  console.log('T7 removal without reload ok');

  // ---- T8: after a check, reload only when data changed
  reset(); await run('syncAfterCheck({ found: 0, changed: 0, succeeded: 2 })'); assert.strictEqual(counts.load || 0, 0);
  await run('syncAfterCheck({ found: 0, changed: 3 })'); await tick(); assert.strictEqual(counts.load, 1);
  await run('syncAfterCheck({ found: 1, changed: 1 })'); await tick(); assert.strictEqual(counts.load, 2);
  console.log('T8 conditional reload ok');

  // ---- T9: settleOrder equals the old full sort
  run("favoriteArtistIds = new Set(['1', '4'])");
  const oldCmp = (a, b) => { const da = a.release_date || '', db = b.release_date || '';
    if (da !== db) { if (!da) return 1; if (!db) return -1; return da < db ? 1 : -1; }
    return run('isFavorite')(b) - run('isFavorite')(a); };
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let t = 0; t < 300; t++) {
    const list = Array.from({ length: 40 }, (_, i) => ({ collection_id: i, artist_id: 1 + rnd(5), artist_ids: [1 + rnd(5)], release_date: rnd(8) ? '2024-01-0' + (1 + rnd(4)) : '' }));
    list.sort((a, b) => (!a.release_date - !b.release_date) || b.release_date.localeCompare(a.release_date) || b.collection_id - a.collection_id);
    const expected = [...list].sort(oldCmp).map(r => r.collection_id), got = run('settleOrder')([...list]).map(r => r.collection_id);
    assert.deepStrictEqual(got, expected);
  }
  console.log('T9 settleOrder matches the old sort (300 random lists) ok');
})().then(() => console.log('ALL OK'), e => { process.stderr.write('FAIL ' + (e && e.stack || e) + '\n'); process.exitCode = 1; });