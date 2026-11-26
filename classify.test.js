// Run with: node classify.test.js
// classify.js defines a top-level `const Classify`, so load it in a vm context.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const Classify = vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'classify.js'), 'utf8') + '\n;Classify;');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').join('\n       ')); }
}
// Arrays from the vm context have a different prototype; copy them so deepStrictEqual compares by value.
const split = (credit, known) => Array.from(Classify.splitCredits(credit, known));

console.log('splitCredits');
test('empty and nullish credits', () => {
  assert.deepStrictEqual(split('', ['Nas']), []);
  assert.deepStrictEqual(split(null, ['Nas']), []);
});
test('no followed artists: credit is kept whole', () => {
  assert.deepStrictEqual(split('Mez, J. Cole & Anderson .Paak', []), ['Mez, J. Cole & Anderson .Paak']);
});
test('Hell Nah: comma + ampersand with two followed artists', () => {
  assert.deepStrictEqual(split('Mez, J. Cole & Anderson .Paak', ['J. Cole', 'Anderson .Paak']),
    ['Mez', 'J. Cole', 'Anderson .Paak']);
});
test('Hell Nah: only one followed artist', () => {
  assert.deepStrictEqual(split('Mez, J. Cole & Anderson .Paak', ['J. Cole']),
    ['Mez', 'J. Cole', 'Anderson .Paak']);
});
test('Martin 4sese: followed artists inside a comma group before the ampersand', () => {
  assert.deepStrictEqual(split('Nas, Westside Gunn & Rome Streetz', ['Nas', 'Westside Gunn']),
    ['Nas', 'Westside Gunn', 'Rome Streetz']);
});
test('commas only', () => {
  assert.deepStrictEqual(split('Mez, J. Cole, Anderson .Paak', ['J. Cole', 'Anderson .Paak']),
    ['Mez', 'J. Cole', 'Anderson .Paak']);
});
test('"and" separates like an ampersand', () => {
  assert.deepStrictEqual(split('Nas and Jay-Z', ['Nas']), ['Nas', 'Jay-Z']);
});
test('followed name containing a comma stays intact', () => {
  assert.deepStrictEqual(split('Tyler, the Creator', ['Tyler, the Creator']), ['Tyler, the Creator']);
  assert.deepStrictEqual(split('Tyler, the Creator, Kanye West', ['Tyler, the Creator', 'Kanye West']),
    ['Tyler, the Creator', 'Kanye West']);
});
test('unfollowed comma name is not split', () => {
  assert.deepStrictEqual(split('Tyler, the Creator', ['Kanye West']), ['Tyler, the Creator']);
});
test('unfollowed name with an ampersand is not split', () => {
  assert.deepStrictEqual(split('Earth, Wind & Fire', ['Nas']), ['Earth, Wind & Fire']);
});
test('followed name with an ampersand matches as a whole', () => {
  assert.deepStrictEqual(split('Earth, Wind & Fire', ['Earth, Wind & Fire']), ['Earth, Wind & Fire']);
});
test('matching ignores case and accents, returns the followed spelling', () => {
  assert.deepStrictEqual(split('beyonce & Jay-Z', ['Beyoncé']), ['Beyoncé', 'Jay-Z']);
});
test('duplicate names are collapsed', () => {
  assert.deepStrictEqual(split('Nas & Nas', ['Nas']), ['Nas']);
});

console.log('classify');
test('collaboration credit is the followed artist\'s own release, not a feature', () => {
  const r = Classify.classify('Hell Nah', 'Mez, J. Cole & Anderson .Paak', 'J. Cole', 1);
  assert.strictEqual(r.is_feature, 0);
});
test('another artist\'s release is a feature', () => {
  assert.strictEqual(Classify.classify('Some Song', 'Drake', 'J. Cole', 1).is_feature, 1);
});
test('(feat. X) in the title marks a feature for the followed guest', () => {
  assert.strictEqual(Classify.classify('Song (feat. J. Cole)', 'Drake', 'J. Cole', 1).is_feature, 1);
});
test('various artists is not a feature', () => {
  assert.strictEqual(Classify.classify('Mix', 'Various Artists', 'J. Cole', 1).is_feature, 0);
});
test('kind comes from the Apple title suffix', () => {
  assert.strictEqual(Classify.classify('Thing - Single', 'Nas', 'Nas', 1).kind, 'Single');
  assert.strictEqual(Classify.classify('Thing - EP', 'Nas', 'Nas', 1).kind, 'EP');
  assert.strictEqual(Classify.classify('Thing', 'Nas', 'Nas', 1).kind, 'Album');
});
test('live and compilation variants', () => {
  assert.strictEqual(Classify.classify('Thing (Live at Red Rocks)', 'Nas', 'Nas', 1).variant, 'live');
  assert.strictEqual(Classify.classify('Greatest Hits', 'Nas', 'Nas', 1).variant, 'compilation');
  assert.strictEqual(Classify.classify('Greatest Hits - Single', 'Nas', 'Nas', 1).variant, '');
});
test('dedupe key ignores the single/EP suffix text and punctuation', () => {
  const a = Classify.classify('Hello, World! - Single', 'Nas', 'Nas', 7);
  assert.strictEqual(a.dedupe_key, '7|Single||hello world');
});
test('categoryOf priorities', () => {
  assert.strictEqual(Classify.categoryOf('Album', true, 'live'), 'feature');
  assert.strictEqual(Classify.categoryOf('Album', false, 'live'), 'live');
  assert.strictEqual(Classify.categoryOf('EP', false, ''), 'ep');
  assert.strictEqual(Classify.categoryOf('???', false, ''), 'album');
});

console.log('dates');
test('parseDate accepts real dates and rejects impossible ones', () => {
  assert.strictEqual(Classify.parseDate('1970-01-02'), 1);
  assert.strictEqual(Classify.parseDate('2024-02-29') !== null, true);
  assert.strictEqual(Classify.parseDate('2023-02-29'), null);
  assert.strictEqual(Classify.parseDate('2024-02-30'), null);
  assert.strictEqual(Classify.parseDate('not a date'), null);
  assert.strictEqual(Classify.parseDate(''), null);
});
test('isRecent uses a 30 day window', () => {
  const today = Classify.parseDate('2026-06-30');
  assert.strictEqual(Classify.isRecent('2026-06-01', today), true);
  assert.strictEqual(Classify.isRecent('2026-05-31', today), true);
  assert.strictEqual(Classify.isRecent('2026-05-30', today), false);
  assert.strictEqual(Classify.isRecent('2026-07-15', today), true);  // announced, upcoming
});
test('isRepeat matches the same key within 7 days only', () => {
  const seen = { k: [Classify.parseDate('2026-06-10')] };
  assert.strictEqual(Classify.isRepeat('k', '2026-06-16', seen), true);
  assert.strictEqual(Classify.isRepeat('k', '2026-06-18', seen), false);
  assert.strictEqual(Classify.isRepeat('other', '2026-06-10', seen), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);