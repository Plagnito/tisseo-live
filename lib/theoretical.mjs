// Véhicules théoriques — ce que le flux temps réel ne couvre pas.
// ---------------------------------------------------------------
// Le GTFS-RT de Tisséo ne publie que des TripUpdate pour les bus, trams et
// Téléo : le métro A/B n'y est pas. On peut quand même le faire bouger à
// partir des horaires du GTFS statique — mais ce sont alors des positions
// THÉORIQUES, pas des positions observées. Elles sont marquées comme telles
// (`theoretical: true`) et l'interface le dit.
//
// Reconstruction d'une course : dans un même motif de dates, le k-ième
// départ d'un arrêt appartient au même véhicule que le k-ième du suivant.
// Vérifié sur les deux lignes de métro (17 677 échantillons, 0 écart
// négatif) : l'ordre des courses est donc reconstructible sans les
// `trip_id`, que le GTFS statique ne fournit pas ici.
//
// Tout est pur et testable : `node --test`.
// ---------------------------------------------------------------
import { positionAlongShape, bearingDeg, GRACE_S } from './core.mjs';
import { ymd } from './schedules.mjs';

const DAY_S = 86_400;

// Jours à considérer : aujourd'hui, plus hier pour les courses qui passent
// après minuit (25:10 = 01:10 le lendemain).
function activeDays(nowSec) {
  const out = [];
  const today = new Date(nowSec * 1000);
  for (const offset of [0, -1]) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    out.push({ day, midnight: Math.floor(day.getTime() / 1000) });
  }
  return out;
}

// Courses théoriques d'une (ligne, sens) en cours à l'instant `nowSec`.
// `orderStops` : les arrêts dans l'ordre du parcours (celui de la variante),
// pour que la course se reconstruise dans le bon sens.
// Renvoie [{ stops: [id], times: [epoch], pattern }].
export function activeRuns(idx, routeId, dir, nowSec, orderStops, opts = {}) {
  if (!idx || !orderStops?.length) return [];
  const graceS = opts.graceS ?? GRACE_S;
  const entry = idx.byRoute?.get(`${routeId}|${dir}`);
  if (!entry) return [];

  const runs = [];
  for (const { day, midnight } of activeDays(nowSec)) {
    const pis = idx.patternsByDate.get(ymd(day));
    if (!pis?.length) continue;
    for (const pi of pis) {
      // Une série de départs par arrêt, dans l'ordre du parcours.
      const series = [];
      for (const stopId of orderStops) {
        const secs = entry.stops[stopId]?.[pi];
        series.push(Array.isArray(secs) && secs.length ? secs : null);
      }
      if (series.some((x) => !x)) continue; // parcours incomplet : on ne devine pas
      const count = Math.max(...series.map((x) => x.length));
      for (let k = 0; k < count; k++) {
        const times = series.map((x) => x[k]);
        if (times.some((t) => t == null)) continue;
        const abs = times.map((s) => midnight + s);
        // Course terminée ou pas encore partie.
        if (nowSec > abs[abs.length - 1] + graceS) continue;
        if (nowSec < abs[0] - graceS) continue;
        runs.push({ stops: orderStops.slice(), times: abs, pattern: pi });
      }
    }
  }
  return runs;
}

// Où en est la course `run` à l'instant `nowSec` ?
// Renvoie null si elle n'est pas en cours, sinon un véhicule au même format
// que ceux du flux temps réel, avec `theoretical: true`.
export function runToVehicle(run, nowSec, ctx) {
  const { stops, route, shapeIndex, stopS, idPrefix = 'theo' } = ctx;
  if (!run || !stops || !route) return null;
  const { times, stops: ids } = run;
  const last = times.length - 1;
  if (nowSec > times[last] + GRACE_S || nowSec < times[0] - GRACE_S) return null;

  let i = 0;
  while (i < last && nowSec > times[i + 1]) i++;
  const t0 = times[i], t1 = times[Math.min(i + 1, last)];
  const span = Math.max(t1 - t0, 1);
  const f = Math.min(Math.max((nowSec - t0) / span, 0), 1);
  const a = stops[ids[i]];
  const b = stops[ids[Math.min(i + 1, last)]] ?? a;
  if (!a) return null;

  let lat = a.lat + ((b?.lat ?? a.lat) - a.lat) * f;
  let lon = a.lon + ((b?.lon ?? a.lon) - a.lon) * f;
  let onRoute = false;
  if (shapeIndex) {
    const on = positionAlongShape(shapeIndex, stopS?.get(ids[i]), stopS?.get(ids[Math.min(i + 1, last)]), f);
    if (on) { lat = on.lat; lon = on.lon; onRoute = true; }
  }

  const nextIdx = Math.min(i + 1, last);
  return {
    id: `${idPrefix}:${ctx.routeId}:${ctx.dir}:${run.pattern}:${times[0]}`,
    route_id: ctx.routeId,
    line: route.short_name ?? ctx.routeId,
    mode: ctx.modeLabel ?? route.mode,
    color: route.color ?? '666666',
    text_color: route.text_color ?? 'ffffff',
    destination: run.headsign || ctx.headsign || '',
    lat, lon,
    status: 'en_route',
    theoretical: true,
    on_route: onRoute || undefined,
    at_stop: null,
    at_stop_id: null,
    from: a.n ?? null,
    to: b?.n ?? null,
    next_stop: b?.n ?? null,
    next_stop_id: ids[nextIdx],
    next_time: t1,
    progress: Math.round(((i + f) / Math.max(last, 1)) * 1000) / 1000,
    bearing: b ? Math.round(bearingDeg(a.lat, a.lon, b.lat, b.lon)) : null,
    remaining: ids.slice(nextIdx).map((id, k) => ({
      id, name: stops[id]?.n ?? id, time: times[nextIdx + k], last: nextIdx + k === last,
    })),
    // Bornes theoriques de la course, pour l'info-bulle.
    depart: times[0],
    arrivee: times[last],
  };
}

// Véhicules théoriques d'une (ligne, sens) à l'instant `nowSec`.
export function theoreticalVehicles(idx, routeId, dir, nowSec, ctx) {
  const runs = activeRuns(idx, routeId, dir, nowSec, ctx.orderStops, ctx);
  const out = [];
  for (const run of runs) {
    const v = runToVehicle(run, nowSec, { ...ctx, routeId, dir, headsign: ctx.headsign ?? run.headsign });
    if (v) out.push(v);
  }
  return out;
}

export { DAY_S };
