// Port of Classify.py: pure rules, no network, no storage.
const Classify = (() => {
  const VERSION = 6, RECENT_DAYS = 30, NEW_FLAG_DAYS = 7, DUP_DAYS = 7;
  const SUFFIX = /\s-\s(single|ep)$/i;
  const FEAT = /[\(\[]\s*(?:feat\.?|featuring|ft\.?|with)\s+([^\)\]]+)[\)\]]/gi;
  const LIVE = /[\(\[]\s*live\b|\s-\s*live\b|\blive\s+(?:at|in|from|on|session|sessions)\b|\bunplugged\b|\bin concert\b/i;
  const COMP = /\b(?:greatest hits|best of|the essentials?|anthology|the collection|very best|retrospective|b-sides)\b/i;

  const norm = s => String(s ?? '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  // Split a credit only when the boundaries are supported by known artist names.
  // Commas are part of many official names (e.g. Tyler, the Creator), so they
  // must never be treated as unconditional collaboration separators.
  function splitCredits(raw, knownNames = []) {
    const value = String(raw ?? '').trim();
    if (!value) return [];
    const known = new Map();
    for (const item of knownNames) {
      const name = String(item?.name ?? item ?? '').trim(), key = norm(name);
      if (key && !known.has(key)) known.set(key, name);
    }
    const whole = known.get(norm(value));
    if (whole) return [whole];
    if (!known.size) return [value];

    // Ampersands / "and" are stronger collaboration signals than commas.
    // Each comma-delimited phrase is split only if every part can be grouped
    // into exact followed-artist names (so "Tyler, the Creator" stays intact).
    const groups = value.split(/\s*(?:&|\band\b)\s*/i).map(x => x.trim()).filter(Boolean);
    const matchedGroup = groups.some(group => known.has(norm(group)));
    // Without a followed-artist match, an ampersand may be part of a solo name
    // such as "Earth, Wind & Fire"; preserve the original credit.
    if (groups.length > 1 && !matchedGroup) return [value];
    if (groups.length > 1 && groups.some(group => group.includes(',') && !known.has(norm(group)))) return [value];
    const parsed = [];
    for (const group of groups) {
      const exact = known.get(norm(group));
      if (exact) { parsed.push(exact); continue; }
      const parts = group.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
      if (parts.length < 2) { parsed.push(group); continue; }
      const paths = Array(parts.length + 1).fill(null);
      paths[0] = [];
      for (let i = 0; i < parts.length; i++) {
        if (!paths[i]) continue;
        for (let j = i + 1; j <= parts.length; j++) {
          const candidate = known.get(norm(parts.slice(i, j).join(', ')));
          if (candidate) paths[j] = [...paths[i], candidate];
        }
      }
      if (paths[parts.length]) parsed.push(...paths[parts.length]);
      else parsed.push(group);
    }
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
    return { kind, is_feature: isFeature ? 1 : 0, variant, dedupe_key: `${artistId}|${kind}|${variant}|${norm(base)}` };
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

  return { VERSION, NEW_FLAG_DAYS, DUP_DAYS, norm, splitCredits, classify, categoryOf, parseDate, isRecent, isRepeat };
})();
