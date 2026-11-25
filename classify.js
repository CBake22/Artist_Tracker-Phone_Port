// Port of Classify.py: pure rules, no network, no storage.
const Classify = (() => {
  const VERSION = 5, RECENT_DAYS = 30, NEW_FLAG_DAYS = 7, DUP_DAYS = 7;
  const SUFFIX = /\s-\s(single|ep)$/i;
  const FEAT = /[\(\[]\s*(?:feat\.?|featuring|ft\.?|with)\s+([^\)\]]+)[\)\]]/gi;
  const LIVE = /[\(\[]\s*live\b|\s-\s*live\b|\blive\s+(?:at|in|from|on|session|sessions)\b|\bunplugged\b|\bin concert\b/i;
  const COMP = /\b(?:greatest hits|best of|the essentials?|anthology|the collection|very best|retrospective|b-sides)\b/i;

  const norm = s => String(s ?? '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const has = (hay, needle) => !!needle && (' ' + hay + ' ').includes(' ' + needle + ' ');

  function classify(name, credited, followed, artistId) {
    name = String(name ?? '');
    const m = SUFFIX.exec(name);
    const kind = !m ? 'Album' : (m[1].toLowerCase() === 'ep' ? 'EP' : 'Single');
    const base = m ? name.slice(0, m.index) : name;
    const fn = norm(followed), cn = norm(credited);
    const guests = [...base.matchAll(FEAT)].map(x => norm(x[1])).join(' ');
    const isFeature = has(guests, fn) || (!!cn && cn !== 'various artists' && !has(cn, fn));
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
    const ms = Date.parse(t + 'T00:00:00Z');
    return isNaN(ms) ? null : Math.floor(ms / 864e5);
  }
  const todayNum = () => { const n = new Date(); return Math.floor(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / 864e5); };
  const isRecent = (s, today = todayNum()) => { const d = parseDate(s); return d !== null && d >= today - RECENT_DAYS; };
  const isRepeat = (key, s, seen) => {
    const d = parseDate(s);
    return !!(key && d !== null && (seen[key] || []).some(p => Math.abs(d - p) <= DUP_DAYS));
  };

  return { VERSION, NEW_FLAG_DAYS, DUP_DAYS, norm, classify, categoryOf, parseDate, isRecent, isRepeat };
})();
