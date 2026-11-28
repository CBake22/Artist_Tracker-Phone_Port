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
const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const daysFromNow = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const Classify = run("Classify");
(async () => {
  await tick(100);
  const N = 400, PER = 30; let id = 1000, seed = 3; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const name = a => "Artist " + a;
  for (let a = 1; a <= N; a++) S.artists.m.set(a, { artist_id: a, name: name(a), url: "https://a" });
  const add = (owner, title, credit, date, owners) => { const r = { collection_id: ++id, artist_id: owner, artist_ids: owners, name: title, primary_artist_credit: credit,
    credited_artist: credit, featured_artists: [], release_date: date, artwork_url: "https://x/300x300bb.jpg", url: "https://c/" + id, track_count: 5, genre: "Pop",
    detected: 0, first_seen_at: 1, ...Classify.classify(title, credit, name(owner), owner) }; S.releases.m.set(r.collection_id, r); };
  for (let a = 1; a <= N; a++) for (let k = 0; k < PER; k++) {
    const date = daysFromNow(-(3 + rnd(3650)));
    if (k % 10 === 0) { const b = 1 + rnd(N); add(a, "Collab " + a + "-" + k, name(a) + " & " + name(b), date, b === a ? [a] : [a, b]); }
    else add(a, "Rec " + a + "-" + k, name(a), date, [a]);
  }
  for (let k = 0; k < 150; k++) { const a = 1 + rnd(N); add(a, "Up " + k, name(a), daysFromNow(1 + rnd(300)), [a]); }
  await run("load()"); await tick(50);
  const T = (label, fn, reps = 5) => { fn(); const t0 = process.hrtime.bigint(); for (let i = 0; i < reps; i++) fn(); const ms = Number(process.hrtime.bigint() - t0) / 1e6 / reps; console.log(label.padEnd(44), ms.toFixed(1).padStart(8), "ms"); return ms; };
  console.log("releases in memory:", run("releases.length"), " artists:", run("artists.length"));
  T("renderAll (tracker open)", () => run("renderAll()"));
  run("selectTab(\"upcoming\")");
  T("renderAll (upcoming open, 150 upcoming)", () => run("renderAll()"));
  run("selectTab(\"artists\")");
  T("renderAll (artists open)", () => run("renderAll()"));
  run("selectTab(\"tracker\")");
  let f = 0; T("toggleFavorite (tracker open)", () => run("toggleFavorite(" + (1 + (f++ % 5)) + ")"), 10);
  run("selectTab(\"artists\")"); f = 0;
  T("toggleFavorite (artists open)", () => run("toggleFavorite(" + (1 + (f++ % 5)) + ")"), 10);
})().then(() => {}, e => { process.stderr.write("FAIL " + (e && e.stack || e) + "\n"); process.exitCode = 1; });