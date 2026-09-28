// Géométrie du réseau entier — sert de fond vectoriel à la carte.
//
// Objectif : pouvoir dessiner TOUTES les lignes même quand aucun fond de
// carte (tuiles raster) n'est disponible (réseau bloqué, adblocker, hors
// ligne). On renvoie donc une géométrie unique, simplifiée et fusionnée :
// un réseau complet pèse ~450 Ko en JSON brut, on veut ~10× moins.
//
// Sources : data/route_variants.json (tracés par sens) + data/routes.json
// (couleur et mode de chaque ligne).
import { GRACE_S } from './core.mjs';

// Douglas-Peucker, en mètres. La projection est équirectangulaire locale
// autour de la latitude du segment : à l'échelle d'une ville, l'erreur
// d'un degré de longitude par rapport aux mètres est constante sur toute
// la Toulouse métropolitaine (< 0,2 %), donc inutile de faire plus.
const M_PER_DEG_LAT = 111_320;

// 5 décimales ≈ 1,1 m : assez pour un fond de ville, et 15 % de JSON en moins.
const round5 = (n) => Math.round(n * 1e5) / 1e5;

function perpDist(p, a, b, lat0) {
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  const px = p[1] * kx, py = p[0] * ky;
  const ax = a[1] * kx, ay = a[0] * ky;
  const bx = b[1] * kx, by = b[0] * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function douglasPeucker(pts, tolM) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let far = -1, farD = tolM;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(pts[i], pts[lo], pts[hi], pts[lo][0]);
      if (d > farD) { farD = d; far = i; }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([lo, far], [far, hi]);
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// --- simplification en mémoire, par arrondi de grille --------------------
// Un hexagone de grille de `cell` mètres indexe les points déjà simplifiés :
// deux lignes qui passent au même endroit partagent le même point, ce qui
// divise encore la taille du JSON (et laisse la carte plus lisible).
// La latitude de référence est FIXE et non calculée par tracé : sans elle
// deux formes voisines ne partagent jamais la même clé, et la déduplication
// ne réduit rien.
const REF_LAT = 43.6; // Toulouse — l'écart avec n'importe quel tracé est < 0,15°

function snapKey(p, cell) {
  const ky = M_PER_DEG_LAT * cell;
  const kx = M_PER_DEG_LAT * Math.cos((REF_LAT * Math.PI) / 180) * cell;
  return `${Math.round(p[0] * ky)}|${Math.round(p[1] * kx)}`;
}

function simplifyShape(shape, tolM, cellM) {
  const raw = Array.isArray(shape) && shape.length >= 2 ? shape : null;
  if (!raw) return [];
  const pts = [];
  for (const p of raw) {
    const lat = Number(p?.[0]), lon = Number(p?.[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([round5(lat), round5(lon)]);
  }
  if (pts.length < 2) return [];
  const tol = Math.max(0, Number(tolM) || 0);
  const simplified = tol > 0 ? douglasPeucker(pts, tol) : pts;
  if (!(cellM > 0)) return simplified;
  const out = [];
  const seen = new Set();
  for (const p of simplified) {
    const k = snapKey(p, cellM);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  // une déduplication agressive peut laisser un seul point : on garde les extrémités
  if (out.length < 2) return [pts[0], pts[pts.length - 1]];
  return out;
}

// Construit (et met en cache) la géométrie complète du réseau.
// `routes`  : data/routes.json (route_id, short_name, color, type)
// `variants`: data/route_variants.json (tracés par sens)
export function buildNetwork({ routes, variants, routeById, modeOf }, opts = {}) {
  const tolM = Number.isFinite(opts.tolM) ? opts.tolM : 6;
  const cellM = Number.isFinite(opts.cellM) ? opts.cellM : 5;
  const byRoute = new Map();
  for (const [routeId, list] of Object.entries(variants)) {
    const r = routeById?.get(routeId) ?? routes.find((x) => x.route_id === routeId);
    if (!r) continue;
    const shapes = [];
    for (const v of list) {
      const shape = simplifyShape(v?.shape, tolM, cellM);
      if (shape.length >= 2) shapes.push(shape);
    }
    if (!shapes.length) continue;
    byRoute.set(routeId, {
      route_id: routeId,
      line: r.short_name ?? routeId,
      color: `#${r.color || '8892a0'}`,
      mode: modeOf ? modeOf(r) : undefined,
      shapes,
    });
  }
  return {
    lines: [...byRoute.values()],
    points: byRoute.size,
    tol_m: tolM,
    cell_m: cellM,
    grace_s: GRACE_S,
  };
}
