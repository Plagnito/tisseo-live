// Repli d'horaires théoriques.
// ---------------------------------------------------------------
// Le GTFS-RT de Tisséo ne couvre pas le métro, et il a des creux sur
// les bus (entre deux passages, fin de service, flux indisponible).
// data/schedules.json — généré par scripts/prepare-gtfs.mjs — contient
// les heures de passage de toutes les lignes, indexées par motif de
// dates (semaine, week-end…) pour couvrir toute la fenêtre publiée par
// le GTFS statique.
// Tout est pur ici : facile à tester avec `node --test`.
// ----------------------------------------------------------------

const DAY_S = 86_400;
const HORIZON_S = 2 * 3600; // au-delà de 2 h, on préfère ne rien promettre
const MERGE_TOL_S = 180; // même bus/tram à l'heure théorique et en RT

// Date locale -> "YYYYMMDD".
export function ymd(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

// raw = data/schedules.json. Construit deux index :
//   patternsByDate : "YYYYMMDD" -> indices de motifs actifs ce jour-là
//   byStop         : stop_id -> entrées { line, destination, perPat }
export function loadSchedules(raw, { routeById, modeOf } = {}) {
  if (!raw || !raw.lines || !Array.isArray(raw.patterns)) return null;
  const patternsByDate = new Map();
  raw.patterns.forEach((days, pi) => {
    for (const d of days) {
      const arr = patternsByDate.get(d);
      if (arr) arr.push(pi);
      else patternsByDate.set(d, [pi]);
    }
  });
  const byStop = new Map();
  let entries = 0;
  for (const [routeId, dirs] of Object.entries(raw.lines)) {
    const route = routeById?.get?.(routeId);
    for (const [dir, d] of Object.entries(dirs)) {
      for (const [stopId, perPat] of Object.entries(d.stops ?? {})) {
        const list = byStop.get(stopId) ?? [];
        list.push({
          route_id: routeId,
          dir,
          line: route?.short_name ?? routeId,
          color: route?.color ?? '666666',
          text_color: route?.text_color ?? 'ffffff',
          mode: modeOf ? modeOf(route) : undefined,
          destination: d.headsign || '',
          perPat,
        });
        byStop.set(stopId, list);
        entries++;
      }
    }
  }
  return { patternsByDate, byStop, entries, patterns: raw.patterns.length };
}

// Premier index i tel que arr[i] >= target (arr trié), sinon arr.length.
function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Prochains passages théoriques à un arrêt à l'instant `nowSec` (epoch).
// On regarde hier (certains départs passent minuit : 25:10 = 01:10) et
// aujourd'hui, uniquement les motifs de dates actifs.
export function scheduleDepartures(idx, stopId, nowSec, limit = 12) {
  if (!idx || !stopId) return [];
  const entries = idx.byStop.get(stopId);
  if (!entries?.length) return [];
  const out = [];
  const today = new Date(nowSec * 1000);
  for (const offset of [0, -1]) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const pis = idx.patternsByDate.get(ymd(day));
    if (!pis?.length) continue;
    const midnight = Math.floor(day.getTime() / 1000);
    for (const e of entries) {
      for (const pi of pis) {
        const secs = e.perPat[pi];
        if (!secs?.length) continue;
        const from = lowerBound(secs, nowSec - midnight);
        for (let i = from; i < secs.length; i++) {
          const t = midnight + secs[i];
          if (t > nowSec + HORIZON_S) break;
          if (t < nowSec) continue;
          out.push({
            route_id: e.route_id,
            dir: e.dir,
            line: e.line,
            color: e.color,
            text_color: e.text_color,
            mode: e.mode,
            destination: e.destination,
            time: t,
            trip_id: null,
            vehicle: null,
            source: 'gtfs',
          });
        }
      }
    }
  }
  out.sort((a, b) => a.time - b.time || a.line.localeCompare(b.line));
  // Un même passage peut remonter par deux motifs de dates voisins.
  const seen = new Set();
  const deduped = [];
  for (const d of out) {
    const k = `${d.route_id}|${d.dir}|${d.time}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(d);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

// Fusion temps réel + théorique. On garde le RT et on compléte avec les
// horaires théoriques : un passage théorique qui a son twin RT (même ligne,
// ±180 s) est un doublon du même véhicule, sinon c'est un passage que le RT
// ne connaît pas encore — chaque twin RT n'absorbe qu'un seul théorique.
export function mergeDepartures(rt, gtfs, limit = 12) {
  const rtList = rt ?? [];
  const out = [...rtList];
  const taken = new Set();
  for (const d of gtfs ?? []) {
    let best = -1, bestDt = Infinity;
    for (let i = 0; i < rtList.length; i++) {
      const r = rtList[i];
      if (r.line !== d.line || taken.has(i)) continue;
      const dt = Math.abs(r.time - d.time);
      if (dt <= MERGE_TOL_S && dt < bestDt) { best = i; bestDt = dt; }
    }
    if (best >= 0) taken.add(best);
    else out.push(d);
  }
  out.sort((a, b) => a.time - b.time);
  return out.slice(0, limit);
}
