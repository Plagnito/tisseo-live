// Logique partagée par les API, la carte et les tests. Les valeurs inconnues
// restent inconnues, en particulier pour les horaires et l'accessibilité.
export const parisDay = (value = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const clean = (v) => String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const norm = (v) => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const knownYes = (v) => /^(yes|oui|true|1|designated|only)$/i.test(String(v));
export function facts(r = {}) {
  return { opening_hours: clean(r.opening_hours), wheelchair: knownYes(r.wheelchair) ? 'yes' : /^(no|non)$/i.test(r.wheelchair) ? 'no' : r.wheelchair === 'limited' ? 'limited' : 'unknown',
    vegetarian: knownYes(r.vegetarian || r['diet:vegetarian']) || knownYes(r.vegan || r['diet:vegan']),
    free_access: /^(no|non|0)$/i.test(String(r.fee)) || knownYes(r.gratuit) || knownYes(r.acces_libre) ? true : null };
}
export function openingState(hours, now = Date.now()) {
  if (!hours) return 'unknown';
  if (hours.trim() === '24/7') return 'open';
  // Sous-ensemble hebdomadaire explicite OSM. PH/SH, saisons, commentaires,
  // rendez-vous et syntaxe non reconnue n'autorisent aucune conclusion.
  const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const part = (k) => parts.find((p) => p.type === k)?.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  const minute = Number(part('hour')) * 60 + Number(part('minute'));
  let open = false;
  for (const raw of hours.split(';')) {
    const match = raw.trim().match(/^(?:(Mo|Tu|We|Th|Fr|Sa|Su)((?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)\s+)?(off|closed|\d{2}:\d{2}-\d{2}:\d{2}(?:,\s*\d{2}:\d{2}-\d{2}:\d{2})*)$/);
    if (!match) return 'unknown';
    const allowed = new Set(match[1] ? [] : days.map((_, i) => i));
    if (match[1]) for (const range of (match[1] + match[2]).split(',')) {
      const [a, b = a] = range.split('-').map((s) => days.indexOf(s));
      for (let i = a; ; i = (i + 1) % 7) { allowed.add(i); if (i === b) break; }
    }
    if (/^(off|closed)$/.test(match[3])) { if (allowed.has(day)) open = false; continue; }
    for (const range of match[3].split(',')) {
      const [start, end] = range.trim().split('-').map((s) => { const [h, m] = s.split(':').map(Number); return h <= 24 && m < 60 && !(h === 24 && m) ? h * 60 + m : NaN; });
      if (!Number.isFinite(start + end)) return 'unknown';
      if (end > start ? allowed.has(day) && minute >= start && minute < end : (allowed.has(day) && minute >= start) || (allowed.has((day + 6) % 7) && minute < end)) open = true;
    }
  }
  return open ? 'open' : 'closed';
}
export function eventOnDay(p, day = parisDay()) {
  if (p.sessions?.length) return p.sessions.some((s) => parisDay(s.begin) <= day && parisDay(s.end) >= day);
  return Boolean(p.start_date && p.start_date <= day && p.end_date >= day);
}
export function eventTonight(p, day = parisDay(), now = Date.now()) {
  return Boolean(p.sessions?.some((s) => {
    const begin = parisDay(s.begin), end = parisDay(s.end);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(s.end)));
    return begin <= day && end >= day && (end > day || hour >= 18) && Date.parse(s.end) > now;
  }));
}
export function eventTags(text, ageMin, ageMax) {
  const n = norm(text), tags = [];
  if (/gratuit|entree libre|acces libre/.test(n) && !/non gratuit/.test(n)) tags.push('free');
  if (/famille|enfant|jeune public/.test(n) || (ageMax != null && Number(ageMax) <= 16)) tags.push('family');
  if (/concert|musique|jazz|recital/.test(n)) tags.push('concert');
  if (/exposition|expos?\b|vernissage/.test(n)) tags.push('exhibition');
  return tags;
}
export function deduplicateEvents(items) {
  const map = new Map();
  for (const p of items) {
    const key = `${norm(p.name)}|${p.lat.toFixed(3)}|${p.lon.toFixed(3)}|${p.start_date}|${p.end_date}`;
    const old = map.get(key);
    if (!old) map.set(key, p);
    else map.set(key, { ...old, sessions: old.sessions?.length ? old.sessions : p.sessions, tags: [...new Set([...(old.tags || []), ...(p.tags || [])])],
      sources: [...(old.sources || [{ url: old.source_url }]), { url: p.source_url }].filter((s, i, a) => s.url && a.findIndex((x) => x.url === s.url) === i) });
  }
  return [...map.values()];
}
// Allège un événement avant de l'envoyer au navigateur.
//
// Une exposition ouverte chaque jour pendant six mois porte des centaines de
// séances, et certaines descriptions font plusieurs pages. À l'échelle d'une
// grande ville, l'agenda pesait 3,2 Mo et 25 000 séances (Paris, 02/10/2026) :
// de quoi figer un téléphone à la seule lecture. On garde les prochaines séances
// (elles sont triées, les passées déjà écartées) — bien plus qu'il n'en faut
// pour « ce soir » et « cette semaine » — et le début des textes. Les dates de
// début et de fin de l'événement, elles, ont été calculées sur TOUTES les séances.
export function slimEvent(p, { sessions = 40, text = 700 } = {}) {
  const cut = (s) => (typeof s === 'string' && s.length > text ? `${s.slice(0, text).replace(/\s+\S*$/, '')}…` : s);
  const out = { ...p, description: cut(p.description) };
  if (p.details?.some((d) => d.value?.length > text)) out.details = p.details.map((d) => ({ ...d, value: cut(d.value) }));
  if (p.sessions?.length > sessions) { out.sessions = p.sessions.slice(0, sessions); out.sessions_total = p.sessions.length; }
  return out;
}
export function inPolygon(lon, lat, geometry) {
  const ringContains = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x, y] = ring[i], [a, b] = ring[j];
      if ((y > lat) !== (b > lat) && lon < (a - x) * (lat - y) / (b - y) + x) inside = !inside;
    }
    return inside;
  };
  const polygonContains = (p) => ringContains(p[0]) && !p.slice(1).some(ringContains);
  return geometry?.type === 'Polygon' ? polygonContains(geometry.coordinates) : geometry?.type === 'MultiPolygon' ? geometry.coordinates.some(polygonContains) : false;
}
export function walkingBand(p, features) {
  return features.filter((f) => inPolygon(p.lon, p.lat, f.geometry)).map((f) => Number(f.properties.contour)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
}
