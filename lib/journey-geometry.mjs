// Tracé d'un itinéraire, étape par étape.
// ---------------------------------------------------------------
// Le routeur rend des étapes (« marcher de A à B », « ligne L1 de C à D ») sans
// géométrie. L'interface n'en dessinait qu'une à la fois, à la demande, en
// allant chercher le tracé ENTIER de la ligne : on voyait la ligne, pas son
// trajet. Ici chaque étape reçoit le chemin qu'on parcourt réellement :
//   - en véhicule : le tronçon du tracé de la ligne entre l'arrêt de montée et
//     l'arrêt de descente, et les arrêts traversés ;
//   - à pied : le chemin par les rues quand le calculateur piéton répond à
//     temps, sinon la ligne droite (marquée comme telle).
// Tout le trajet peut alors être dessiné d'un coup.
//
// Pur (le calculateur piéton est injecté) et testable : `node --test`.
// ---------------------------------------------------------------
import { buildShapeIndex, projectOnShapeIndex, pointAtDistance, haversineM } from './core.mjs';

const round = (n) => Math.round(n * 1e5) / 1e5;
const DETOUR = 1.3; // même coefficient que le routeur (lib/router.mjs)

// Tronçon d'un tracé entre deux arrêts : [[lat, lon]…], dans le sens du trajet.
// Sans tracé exploitable, la suite des arrêts eux-mêmes.
export function ridePath(variant, fromId, toId, stops) {
  const i = variant.stops.indexOf(fromId);
  const j = variant.stops.indexOf(toId, i + 1);
  if (i < 0 || j <= i) return null;
  const through = variant.stops.slice(i, j + 1).filter((id) => stops[id]);
  const viaStops = through.map((id) => [round(stops[id].lat), round(stops[id].lon)]);
  const idx = buildShapeIndex(variant.shape);
  const a = stops[fromId], b = stops[toId];
  const pa = idx && a ? projectOnShapeIndex(idx, a.lat, a.lon) : null;
  const pb = idx && b ? projectOnShapeIndex(idx, b.lat, b.lon) : null;
  // Un arrêt à plus de 250 m du tracé n'y est pas ; et un tracé en boucle peut
  // projeter l'arrivée AVANT le départ : dans les deux cas, les arrêts font foi.
  const usable = pa && pb && pa.d2 < 250 * 250 && pb.d2 < 250 * 250 && pb.s > pa.s + 20;
  let path = viaStops;
  if (usable) {
    path = [pointAtDistance(idx, pa.s)];
    for (let k = 0; k < idx.pts.length; k++) if (idx.cum[k] > pa.s && idx.cum[k] < pb.s) path.push(idx.pts[k]);
    path.push(pointAtDistance(idx, pb.s));
    path = path.map(([la, lo]) => [round(la), round(lo)]);
  }
  return {
    path,
    on_shape: Boolean(usable),
    distance_m: Math.round(usable ? pb.s - pa.s : viaStops.reduce((d, p, k) => (k ? d + haversineM(viaStops[k - 1][0], viaStops[k - 1][1], p[0], p[1]) : 0), 0)),
    stops: through.map((id) => ({ id, name: stops[id].n, lat: round(stops[id].lat), lon: round(stops[id].lon) })),
  };
}

// Variante empruntée par une étape : celle qui dessert la montée PUIS la descente.
export function variantFor(variants, routeId, fromId, toId) {
  return (variants[routeId] ?? []).find((v) => { const i = v.stops.indexOf(fromId); return i >= 0 && v.stops.indexOf(toId, i + 1) > i; }) ?? null;
}

// Ajoute à chaque étape son tracé (`path`), sa distance, et aux trajets en
// véhicule leurs arrêts (`stops`) et leur direction (`headsign`).
//   walk(from, to) → { geometry: { coordinates: [[lon, lat]…] }, distance_m, duration_s }
//   walkBudgetMs   : délai total accordé au calculateur piéton (toutes marches)
export async function decorateJourney(out, { variants, stops, walk = null, walkBudgetMs = 3500 } = {}) {
  if (!out?.legs) return out;
  const pending = [];
  for (const leg of out.legs) {
    if (leg.type === 'ride') {
      const v = variantFor(variants, leg.route_id, leg.from_id, leg.to_id);
      const g = v ? ridePath(v, leg.from_id, leg.to_id, stops) : null;
      if (g) Object.assign(leg, { path: g.path, on_shape: g.on_shape || undefined, distance_m: g.distance_m, stops: g.stops, headsign: v.headsign || undefined });
      continue;
    }
    const a = leg.from_pos, b = leg.to_pos;
    if (!a || !b) continue;
    const crow = haversineM(a[0], a[1], b[0], b[1]);
    leg.path = [[round(a[0]), round(a[1])], [round(b[0]), round(b[1])]];
    leg.distance_m = Math.round(crow * DETOUR);
    leg.path_estimated = true;
    // En dessous de 60 m (changer de quai), la ligne droite dit tout.
    if (walk && crow >= 60) {
      pending.push(Promise.resolve().then(() => walk({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] })).then((w) => {
        const coords = w?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) return;
        leg.path = coords.map(([lo, la]) => [round(la), round(lo)]);
        if (Number.isFinite(w.distance_m)) leg.distance_m = w.distance_m;
        // Durée par les rues : affichée à titre d'information. Les horaires du
        // trajet, eux, restent ceux du calcul (distance × 1,3 à 4,5 km/h).
        if (Number.isFinite(w.duration_s)) leg.walk_real_s = Math.round(w.duration_s);
        delete leg.path_estimated;
      }).catch(() => { /* ligne droite gardée */ }));
    }
  }
  if (pending.length) {
    let timer;
    await Promise.race([Promise.allSettled(pending), new Promise((r) => { timer = setTimeout(r, walkBudgetMs); })]);
    clearTimeout(timer);
  }
  // Emprise de tout le trajet : l'interface cadre la carte dessus.
  let s = 90, w = 180, n = -90, e = -180;
  for (const leg of out.legs) for (const [la, lo] of leg.path ?? []) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  if (s <= n) out.bounds = [[s, w], [n, e]];
  out.distance_m = out.legs.reduce((d, l) => d + (l.distance_m ?? 0), 0);
  out.walk_m = out.legs.filter((l) => l.type === 'walk').reduce((d, l) => d + (l.distance_m ?? 0), 0);
  return out;
}
