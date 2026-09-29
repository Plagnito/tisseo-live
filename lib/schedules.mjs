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
  // Par (ligne, sens) : les horaires bruts, arrêt par arrêt et motif par
  // motif. Indispensable pour RECONSTRUIRE une course entière (du premier
  // au dernier arrêt) et pas seulement lister des départs autour d'un arrêt.
  const byRoute = new Map();
  let entries = 0;
  for (const [routeId, dirs] of Object.entries(raw.lines)) {
    const route = routeById?.get?.(routeId);
    for (const [dir, d] of Object.entries(dirs)) {
      byRoute.set(`${routeId}|${dir}`, {
        route_id: routeId, dir, headsign: d.headsign || '', stops: d.stops ?? {},
      });
    }
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
  // Amplitude de service par ligne et par motif : [premier, dernier] passage
  // (secondes depuis minuit, > 86400 après minuit). Sert à écarter d'un
  // itinéraire une ligne qui ne roule pas à l'heure demandée.
  const spans = new Map(); // routeId -> Map(pi -> [min, max])
  for (const [routeId, dirs] of Object.entries(raw.lines)) {
    const m = new Map();
    for (const d of Object.values(dirs)) {
      for (const perPat of Object.values(d.stops ?? {})) {
        for (const [pi, secs] of Object.entries(perPat)) {
          if (!secs?.length) continue;
          const cur = m.get(Number(pi));
          const lo = secs[0], hi = secs[secs.length - 1];
          if (!cur) m.set(Number(pi), [lo, hi]);
          else { if (lo < cur[0]) cur[0] = lo; if (hi > cur[1]) cur[1] = hi; }
        }
      }
    }
    spans.set(routeId, m);
  }
  return { patternsByDate, byStop, byRoute, spans, entries, patterns: raw.patterns.length };
}

// La ligne roule-t-elle à `nowSec` (± marge) ? true / false, ou null quand on
// ne sait pas : ligne absente des horaires, ou aucun motif actif ce jour-là
// (GTFS périmé) — l'appelant doit alors NE RIEN exclure.
export function routeActiveAt(idx, routeId, nowSec, marginS = 20 * 60) {
  const m = idx?.spans?.get(routeId);
  if (!m) return null;
  const today = new Date(nowSec * 1000);
  let known = false;
  for (const offset of [0, -1]) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const pis = idx.patternsByDate.get(ymd(day));
    if (!pis?.length) continue;
    known = true;
    const since = nowSec - Math.floor(day.getTime() / 1000);
    for (const pi of pis) {
      const span = m.get(pi);
      if (span && since >= span[0] - marginS && since <= span[1]) return true;
    }
  }
  return known ? false : null;
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
export function scheduleDepartures(idx, stopId, nowSec, limit = 12, horizonS = HORIZON_S) {
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
          if (t > nowSec + horizonS) break;
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
            // Jour de SERVICE (AAAAMMJJ) : un 00:25 appartient souvent au
            // service de la veille (25:25 dans le GTFS).
            service_day: ymd(day),
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
const destKey = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function mergeDepartures(rt, gtfs, limit = 12) {
  const rtList = rt ?? [];
  const out = [...rtList];
  const taken = new Set();
  for (const d of gtfs ?? []) {
    let best = -1, bestDt = Infinity;
    for (let i = 0; i < rtList.length; i++) {
      const r = rtList[i];
      if (r.line !== d.line || taken.has(i)) continue;
      // Même ligne mais autre destination : l'autre sens (au terminus, le bus
      // qui arrive « absorbait » l'horaire de celui qui repart → doublon).
      if (r.destination && d.destination && destKey(r.destination) !== destKey(d.destination)) continue;
      const dt = Math.abs(r.time - d.time);
      if (dt <= MERGE_TOL_S && dt < bestDt) { best = i; bestDt = dt; }
    }
    if (best >= 0) taken.add(best);
    else out.push(d);
  }
  out.sort((a, b) => a.time - b.time);
  return out.slice(0, limit);
}

// Apparie les départs d'un quai (B, secondes triées) aux arrivées à un quai
// plus loin (A) pour un même motif de dates : le GTFS compact n'a plus
// d'identifiant de course. `estS` = durée de trajet de référence.
//
// Piège évité : « la première arrivée après le départ » est FAUSSE dès que
// les véhicules se suivent de plus près que la durée du trajet (métro : une
// rame toutes les 2 min pour 12 min de trajet → on trouvait 2 min). Les
// véhicules ne se doublent pas : on cherche le DÉCALAGE d'indice le plus
// fréquent entre un départ et l'arrivée la plus proche de départ + estS,
// puis on apparie rang pour rang ; un rang hors fenêtre (service partiel)
// retombe sur l'arrivée la plus proche.
export function pairTimes(B, A, estS) {
  if (!B?.length || !A?.length || !(estS > 0)) return [];
  const lo = Math.max(30, estS * 0.5), hi = estS * 2 + 300;
  const nearest = (b) => {
    const target = b + estS;
    let j = lowerBound(A, target);
    if (j > 0 && (j === A.length || target - A[j - 1] < A[j] - target)) j--;
    return j;
  };
  const counts = new Map();
  for (let k = 0; k < B.length; k++) {
    const j = nearest(B[k]);
    const d = A[j] - B[k];
    if (d >= lo && d <= hi) counts.set(j - k, (counts.get(j - k) ?? 0) + 1);
  }
  if (!counts.size) return [];
  const off = [...counts].sort((x, y) => y[1] - x[1])[0][0];
  const out = [];
  for (let k = 0; k < B.length; k++) {
    let j = k + off;
    let d = j >= 0 && j < A.length ? A[j] - B[k] : -1;
    if (d < lo || d > hi) { j = nearest(B[k]); d = A[j] - B[k]; }
    if (d >= lo && d <= hi) out.push([B[k], A[j]]);
  }
  return out;
}
