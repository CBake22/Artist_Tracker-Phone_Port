const fs = require('fs'), vm = require('vm'), assert = require('assert');
const J=(a,b,m)=>assert.strictEqual(JSON.stringify(a),JSON.stringify(b),m);
const SKIP = !!process.env.SKIP;
let store = fs.readFileSync('store.js','utf8');
if (SKIP) store = store.replace('const COLD_EVERY_MS = 0;', 'const COLD_EVERY_MS = 24 * 3600 * 1000;');
const src = fs.readFileSync('classify.js','utf8') + '\n' + store + `
;(async () => { const SKIP = ${SKIP};
  // ---- in-memory fake of the transaction layer
  const mk = keyPath => { const m = new Map(); const rq = v => { const r = {}; setTimeout(() => { r.result = v; r.onsuccess && r.onsuccess(); }, 0); return r; };
    return { m, get: k => rq(structuredClone(m.get(k))), getAll: () => rq([...m.values()].map(x => structuredClone(x))),
      index: () => ({ getAll: id => rq([...m.values()].filter(v => (v.artist_ids||[v.artist_id]).includes(id)).map(x => structuredClone(x))) }),
      put: v => { m.set(v[keyPath], structuredClone(v)); return rq(); }, delete: k => { m.delete(k); return rq(); } }; };
  const S = { artists: mk('artist_id'), releases: mk('collection_id'), meta: mk('key') };
  tx = async (stores, mode, fn) => fn(...[].concat(stores).map(s => S[s]));
  const R = (id, owner, name, credit, date, extra={}) => ({ collection_id:id, artist_id:owner, artist_ids:[owner], name, primary_artist_credit:credit, credited_artist:credit,
    release_date:date, artwork_url:'https://x/600x600bb.jpg', ...Classify.classify(name, credit, 'Nas', owner), ...extra });

  // ---- #3 partial reclassify
  await DB.addArtist({ artist_id: 1, name: 'Nas' });
  S.releases.m.set(10, R(10,1,'Collab','Nas, Westside Gunn & Rome Streetz','2024-01-01'));
  S.releases.m.set(11, R(11,1,'Solo','Nas','2024-02-01'));
  S.releases.m.set(12, R(12,1,'Remix (feat. Westside Gunn)','Nas','2024-03-01'));
  S.releases.m.set(13, R(13,1,'Nasty Thing','Drake','2024-03-01'));
  S.meta.m.set('classifier_version', { key:'classifier_version', value:'old' });
  const before = JSON.stringify(S.releases.m.get(11));
  await DB.addArtist({ artist_id: 2, name: 'Westside Gunn' });
  J(S.releases.m.get(10).artist_ids.sort(), [1,2], 'collab gains new owner');
  J(S.releases.m.get(12).artist_ids.sort(), [1,2], 'feat gains new owner');
  assert.strictEqual(S.releases.m.get(12).artwork_url, 'https://x/300x300bb.jpg', 'touched row migrated');
  assert.strictEqual(JSON.stringify(S.releases.m.get(11)), before, 'unrelated row untouched');
  assert.strictEqual(S.meta.m.get('classifier_version').value, 'old', 'partial run does not mark version current');
  console.log('partial reclassify ok');
  // word boundary: "Nas" must not match "Nasty"
  const n13 = S.releases.m.get(13).artwork_url; 
  await DB.addArtist({ artist_id: 3, name: 'Nas' }); // same name different id: touches Nas rows but not 'Nasty Thing' title-only? title contains 'nasty' only
  assert.strictEqual(S.releases.m.get(13).artwork_url, n13, 'Nasty not matched by Nas');
  console.log('word boundary ok');
  // full pass migrates artwork and sets version
  await DB.reclassify(true);
  assert.strictEqual(S.releases.m.get(11).artwork_url, 'https://x/300x300bb.jpg');
  assert.strictEqual(S.meta.m.get('classifier_version').value, String(Classify.VERSION));
  console.log('full reclassify ok');

  // ---- #6 addReleases parallel reads keep first_seen/detected
  await DB.addReleases(1, [{ collection_id: 11, name:'Solo', credited_artist:'Nas', detected:1 }, { collection_id: 99, name:'New', credited_artist:'Nas', detected:1 }]);
  assert.strictEqual(S.releases.m.get(99).detected, 1);
  assert.notStrictEqual(S.releases.m.get(11).detected, 1, 'old row keeps its detected flag');
  console.log('addReleases ok');

  // ---- #2 dueArtists
  const now = Date.now(), day = 864e5, iso = n => isoDaysAgo(n);
  S.releases.m.clear(); S.meta.m.clear();
  S.releases.m.set(1, R(1,1,'Recent','A',iso(10)));            // artist 1 active
  S.releases.m.set(2, R(2,2,'Old','B',iso(400)));              // artist 2 cold
  S.releases.m.set(3, R(3,3,'Old','C',iso(400)));              // artist 3 cold but favorite
  S.releases.m.set(4, R(4,4,'Old','D',iso(400)));              // artist 4 cold, failed
  S.releases.m.set(5, R(5,5,'Old','E',iso(400)));              // artist 5 cold, checked 2 days ago
  S.releases.m.set(6, R(6,6,'Soon','F',iso(-20)));             // artist 6 upcoming -> hot
  S.meta.m.set('favorites', { key:'favorites', value: JSON.stringify(['3']) });
  const arts = [1,2,3,4,5,6,7].map(i => ({ artist_id: i, name: 'x'+i }));
  const ok = (ago, extra={}) => ({ status:'success', checked_at: now - ago, ...extra });
  const st = { 1: ok(60e3), 2: ok(60e3), 3: ok(60e3), 4: { status:'error', checked_at: now-60e3 }, 5: ok(2*day), 6: ok(60e3, { full_at: now - 20*day }) };
  const due = await dueArtists(arts, st); if (!SKIP) { assert.strictEqual(due.length, 7, 'nobody skipped'); console.log('no-skip dueArtists ok (7 of 7)'); } else {
  const ids = due.map(d => d.artist.artist_id);
  J(ids, [1,3,4,5,6,7], 'cold+recent (2) skipped; hot/fav/failed/stale/new due');
  const full = Object.fromEntries(due.map(d => [d.artist.artist_id, d.full]));
  J(full, {1:false,3:false,4:true,5:false,6:true,7:true}, 'full refresh only when >14d or never');
  console.log('dueArtists ok:', ids.join(','), JSON.stringify(full)); }

  // ---- end-to-end checkReleases with a stubbed network
  S.releases.m.clear(); S.meta.m.clear();
  const calls = [];
  get = async (p, params) => { calls.push(params.limit); return { results: [{ wrapperType:'artist', artistId: params.id, artistName:'x'+params.id, artistLinkUrl:'https://a' }] }; };
  const arts2 = [1,2,3].map(i => ({ artist_id: i, name: 'x'+i }));
  for (const a of arts2) S.artists.m.set(a.artist_id, a);
  let r1 = await checkReleases();
  J([r1.succeeded, r1.deferred], [3, 0]); J(calls, [200,200,200]);
  calls.length = 0;
  let r2 = await checkReleases();   // immediately again: everyone cold (no releases) and fresh
  if (SKIP) { J([r2.succeeded, r2.deferred], [0, 3]); assert.strictEqual(calls.length, 0); }
  else { J([r2.succeeded, r2.deferred], [3, 0]); J(calls, [30,30,30], 'routine limit when nobody is skipped'); }
  const stat = JSON.parse(S.meta.m.get('artist_check_status').value);
  assert.ok(stat[1].full_at, 'full_at recorded');
  // make 1 stale (25h old, routine since full_at recent)
  stat[1].checked_at -= 25*3600e3; S.meta.m.set('artist_check_status', { key:'artist_check_status', value: JSON.stringify(stat) });
  calls.length = 0; let r3 = await checkReleases();
  if (!SKIP) { J([r3.succeeded, r3.deferred], [3, 0]); console.log('checkReleases e2e ok (no skipping)'); return; }
  J([r3.succeeded, r3.deferred], [1, 2]); J(calls, [30], 'routine limit used');
  console.log('checkReleases e2e ok');
})().then(() => console.log('ALL OK'), e => { console.error('FAIL', e); process.exitCode = 1; });
`;
const ctx = vm.createContext({ console, setTimeout, clearTimeout, structuredClone, J, process, navigator: {}, indexedDB: { open: () => ({}) }, assert, URLSearchParams });
vm.runInContext(src, ctx);