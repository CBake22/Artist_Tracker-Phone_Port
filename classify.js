// Port of Classify.py: pure rules, no network, no storage.
const Classify = (() => {
  const VERSION = 10, RECENT_DAYS = 30, NEW_FLAG_DAYS = 7, DUP_DAYS = 7;
  const SUFFIX = /\s-\s(single|ep)$/i;
  const FEAT = /[\(\[]\s*(?:feat\.?|featuring|ft\.?|with)\s+([^\)\]]+)[\)\]]/gi;
  const LIVE = /[\(\[]\s*live\b|\s-\s*live\b|\blive\s+(?:at|in|from|on|session|sessions)\b|\bunplugged\b|\bin concert\b/i;
  const COMP = /\b(?:greatest hits|best of|the essentials?|anthology|the collection|very best|retrospective|b-sides)\b/i;

  // Letters and digits of every script are kept (Japanese, Korean, Cyrillic... must not normalize to ''),
  // but accents are folded on Latin letters only (e-acute -> e). Marks on other scripts (kana voicing,
  // Hangul jamo) are part of the letter, so they stay.
  const norm = s => String(s ?? '').normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
  // Split a credit only when the boundaries are supported by known artist names.
  // Commas are part of many official names (e.g. Tyler, the Creator), so they
  // must never be treated as unconditional collaboration separators.
  // Lookup of normalized name -> official spelling. Build it once and pass it to splitCredits
  // instead of the raw name list when splitting many credits against the same artists.
  function knownMap(knownNames = []) {
    const known = new Map();
    for (const item of knownNames) {
      const name = String(item?.name ?? item ?? '').trim(), key = norm(name);
      if (key && !known.has(key)) known.set(key, name);
    }
    return known;
  }
  function splitCredits(raw, knownNames = []) {
    const value = String(raw ?? '').trim();
    if (!value) return [];
    const known = knownNames instanceof Map ? knownNames : knownMap(knownNames);
    const whole = known.get(norm(value));
    if (whole) return [whole];
    if (!known.size) return [value];

    // Ampersands / "and" are stronger collaboration signals than commas.
    const groups = value.split(/\s*(?:&|\band\b)\s*/i).map(x => x.trim()).filter(Boolean);
    // Track whether any followed artist is actually found. If none is, the
    // original credit is preserved (e.g. "Earth, Wind & Fire" stays one name).
    let hit = false;
    const parsed = [];
    for (const group of groups) {
      const exact = known.get(norm(group));
      if (exact) { parsed.push(exact); hit = true; continue; }
      const parts = group.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
      if (parts.length < 2) { parsed.push(group); continue; }
      // Best segmentation: known (possibly comma-containing) names win;
      // leftover parts become separate single names. If no followed artist
      // is found in the group, it stays whole (e.g. "Tyler, the Creator").
      const best = Array(parts.length + 1).fill(null);
      best[0] = { score: 0, items: [] };
      for (let i = 0; i < parts.length; i++) {
        if (!best[i]) continue;
        const consider = (j, item, gain) => {
          const score = best[i].score + gain;
          if (!best[j] || score > best[j].score) best[j] = { score, items: [...best[i].items, item] };
        };
        consider(i + 1, parts[i], 0);
        for (let j = i + 1; j <= parts.length; j++) {
          const candidate = known.get(norm(parts.slice(i, j).join(', ')));
          if (candidate) consider(j, candidate, j - i);
        }
      }
      const result = best[parts.length];
      if (result && result.score > 0) { parsed.push(...result.items); hit = true; }
      else parsed.push(group);
    }
    if (!hit) return [value];
    return [...new Map(parsed.map(x => [norm(x), x])).values()];
  }

  function classify(name, credited, followed, artistId) {
    name = String(name ?? '');
    const m = SUFFIX.exec(name);
    const kind = !m ? 'Album' : (m[1].toLowerCase() === 'ep' ? 'EP' : 'Single');
    const base = m ? name.slice(0, m.index) : name;
    const fn = norm(followed), cn = norm(credited);
    const guests = [...base.matchAll(FEAT)].flatMap(x => splitCredits(x[1], [followed]));
    const primary = splitCredits(credited, [followed]);
    const isOwnPrimary = primary.some(x => norm(x) === fn);
    const isFeaturedGuest = guests.some(x => norm(x) === fn);
    const isFeature = isFeaturedGuest || (!!cn && cn !== 'various artists' && !isOwnPrimary);
    let variant = '';
    if (LIVE.test(base)) variant = 'live';
    else if (kind !== 'Single' && (COMP.test(base) || cn === 'various artists')) variant = 'compilation';
    return { kind, is_feature: isFeature ? 1 : 0, variant, dedupe_key: `${artistId}|${kind}|${variant}|${norm(base) || base.trim().toLowerCase()}` };  // emoji-only titles never share an empty key
  }

  function categoryOf(kind, isFeature, variant) {
    if (isFeature) return 'feature';
    if (variant === 'live' || variant === 'compilation') return variant;
    const k = String(kind || '').toLowerCase();
    return ['album', 'ep', 'single'].includes(k) ? k : 'album';
  }

  // Dates are handled as whole-day numbers (days since 1970-01-01).
  function parseDate(s) {
    const t = String(s || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const [year, month, day] = t.split('-').map(Number);
    const ms = Date.UTC(year, month - 1, day);
    const d = new Date(ms);
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
      ? Math.floor(ms / 864e5) : null;
  }
  const todayNum = () => { const n = new Date(); return Math.floor(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / 864e5); };
  const isRecent = (s, today = todayNum()) => { const d = parseDate(s); return d !== null && d >= today - RECENT_DAYS; };
  const isRepeat = (key, s, seen) => {
    const d = parseDate(s);
    return !!(key && d !== null && (seen[key] || []).some(p => Math.abs(d - p) <= DUP_DAYS));
  };

  return { VERSION, NEW_FLAG_DAYS, DUP_DAYS, norm, knownMap, splitCredits, classify, categoryOf, parseDate, isRecent, isRepeat };
})();