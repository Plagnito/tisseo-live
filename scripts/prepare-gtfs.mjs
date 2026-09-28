// Régénère les données statiques dérivées du GTFS Tisséo :
//   data/routes.json         — les 124 lignes (id, nom, couleur, mode)
//   data/stops.json          — arrêts { nom, lat, lon } par stop_id
//   data/route_variants.json — par ligne et par sens : terminus, liste
//                              ordonnée d'arrêts + tracé simplifié
//   data/schedules.json      — horaires théoriques de TOUTES les lignes,
//                              indexés par motif de dates : repli des
//                              "prochains passages" quand le GTFS-RT ne
//                              couvre pas la ligne (métro) ou qu'il a un creux.
// Usage : npm run prepare-gtfs   (nécessite adm-zip en devDependency)
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GTFS_URL =
  'https://data.toulouse-metropole.fr/explore/dataset/tisseo-gtfs/files/fc1dda89077cf37e4f7521760e0ef4e9/download/';

// Découpe CSV aware des guillemets (un champ de Tisséo contient une virgule).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const push = () => { row.push(field); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') push();
    else if (c === '\n') { push(); if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  push();
  if (row.length > 1 || row[0] !== '') rows.push(row);
  const headers = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

// Douglas-Peucker sur degrés (~111 km/°) — tolérance ~13 m par défaut.
function simplify(points, tol = 0.00012) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const dist2 = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (!len2) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
  };
  while (stack.length) {
    const [s, e] = stack.pop();
    let max = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = dist2(points[i], points[s], points[e]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol * tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Le lien ci-dessus désigne UN fichier (son identifiant change quand Tisséo
// publie une nouvelle version) : on demande d'abord au catalogue open data le
// fichier GTFS courant, le lien figé ne sert que de secours.
const CATALOGUE_URL = 'https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/tisseo-gtfs/records?limit=20';
async function currentGtfsUrl() {
  try {
    const r = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(20_000) });
    const j = await r.json();
    const f = (j.results ?? []).map((x) => x.file).find((x) => /gtfs/i.test(x?.filename ?? '') && x.url);
    if (f) return f.url;
  } catch (err) { console.warn('Catalogue injoignable, lien de secours :', String(err.message || err)); }
  return GTFS_URL;
}

console.log('Téléchargement du GTFS Tisséo…');
const res = await fetch(await currentGtfsUrl(), { signal: AbortSignal.timeout(180_000) });
if (!res.ok) throw new Error(`GTFS HTTP ${res.status}`);
const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
const read = (n) => zip.readAsText(n);

const routes = parseCsv(read('routes.txt')).map((r) => ({
  route_id: r.route_id,
  short_name: r.route_short_name,
  long_name: r.route_long_name,
  color: r.route_color,
  text_color: r.route_text_color,
  type: r.route_type,
}));

const stops = {};
for (const s of parseCsv(read('stops.txt'))) {
  if (!s.stop_lat || !s.stop_lon) continue;
  stops[s.stop_id] = { n: s.stop_name, lat: Number(s.stop_lat), lon: Number(s.stop_lon) };
}

// trips : trip_id -> { route_id, dir, headsign, shape_id, service_id }
const tripInfo = new Map();
for (const t of parseCsv(read('trips.txt'))) {
  tripInfo.set(t.trip_id, { route: t.route_id, dir: t.direction_id, head: t.trip_headsign, shape: t.shape_id, svc: t.service_id });
}

// Le GTFS de Tisséo n'a pas de calendar.txt : les jours de service sont
// entièrement dans calendar_dates.txt (fenêtre glissante d'environ 5 semaines).
// On reconstruit, par service_id, le bit de chaque date publiée.
const svcDates = new Map(); // service_id -> Set(YYYYMMDD)
const allDates = new Set();
for (const e of parseCsv(read('calendar_dates.txt'))) {
  if (!e.date) continue;
  allDates.add(e.date);
  if (e.exception_type !== '1') continue; // 2 = retiré ce jour-là
  if (!svcDates.has(e.service_id)) svcDates.set(e.service_id, new Set());
  svcDates.get(e.service_id).add(e.date);
}
const dates = [...allDates].sort();
// service_id -> motif de dates (dans ce GTFS, calendar.txt est vide : chaque
// service décrit les dates où il circule). Les motifs sont dédupliqués :
// les milliers de services partagent les mêmes motifs (semaine, week-end…).
const svcPattern = new Map();
const patternList = [];
const patternIdx = new Map();
for (const [svc, set] of svcDates) {
  const key = [...set].sort().join(',');
  let pi = patternIdx.get(key);
  if (pi === undefined) {
    pi = patternList.length;
    patternList.push(key.split(','));
    patternIdx.set(key, pi);
  }
  svcPattern.set(svc, pi);
}

// stop_times : passe 1 = comptage par trip, passe 2 = arrêts des trips gagnants
console.log('Analyse des horaires…');
const stLines = read('stop_times.txt').split('\n');
const header = stLines[0].split(',');
const iTrip = header.indexOf('trip_id'), iStop = header.indexOf('stop_id'), iSeq = header.indexOf('stop_sequence');
const iDep = header.indexOf('departure_time');
const counts = new Map();
for (let i = 1; i < stLines.length; i++) {
  const line = stLines[i];
  if (!line) continue;
  const trip = line.slice(0, line.indexOf(','));
  counts.set(trip, (counts.get(trip) ?? 0) + 1);
}
// gagnant = trip le plus long par (route, sens)
const winners = new Map(); // "route|dir" -> { trip, count }
for (const [trip, count] of counts) {
  const info = tripInfo.get(trip);
  if (!info) continue;
  const key = info.route + '|' + info.dir;
  if (!winners.has(key) || winners.get(key).count < count) winners.set(key, { trip, count });
}
const winnerTrips = new Set([...winners.values()].map((w) => w.trip));
const winnerStops = new Map(); // trip -> [[seq, stopId]]
for (let i = 1; i < stLines.length; i++) {
  const line = stLines[i];
  if (!line) continue;
  const p1 = line.indexOf(',');
  const trip = line.slice(0, p1);
  if (!winnerTrips.has(trip)) continue;
  const parts = line.split(',');
  const arr = winnerStops.get(trip) ?? [];
  arr.push([Number(parts[iSeq]), parts[iStop]]);
  winnerStops.set(trip, arr);
}

// Horaires théoriques : le GTFS-RT ne couvre pas le métro, et il a des
// creux sur les bus (entre deux passages, fin de service, flux en rade).
// On publie donc TOUTES les lignes pour servir de repli à "prochains passages".
const schedRoutes = new Set(routes.map((r) => r.route_id));
// Terminus affiché = celui du trip "gagnant" (le plus long) par ligne/sens.
const headsigns = new Map(); // "route|dir" -> terminus
for (const [key, w] of winners) {
  const info = tripInfo.get(w.trip);
  if (info) headsigns.set(key, info.head || '');
}
// Par ligne/sens/arrêt : motif de dates -> heures de passage (secondes depuis
// minuit), triées et sans doublon.
const buckets = new Map(); // "route|dir|stop" -> Map<idxMotif, Set<sec>>
for (let i = 1; i < stLines.length; i++) {
  const line = stLines[i];
  if (!line) continue;
  const parts = line.split(',');
  const info = tripInfo.get(parts[iTrip]);
  if (!info || !schedRoutes.has(info.route)) continue;
  const pi = svcPattern.get(info.svc);
  if (pi === undefined) continue;
  const dep = parts[iDep];
  if (!dep) continue;
  const c = dep.split(':');
  const sec = Number(c[0]) * 3600 + Number(c[1]) * 60 + Number(c[2] || 0);
  const key = `${info.route}|${info.dir}|${parts[iStop]}`;
  let m = buckets.get(key);
  if (!m) { m = new Map(); buckets.set(key, m); }
  let s = m.get(pi);
  if (!s) { s = new Set(); m.set(pi, s); }
  s.add(sec);
}
const lines = {};
let schedEntries = 0;
for (const [key, m] of buckets) {
  const [route, dir, stop] = key.split('|');
  (lines[route] ??= {});
  (lines[route][dir] ??= { headsign: headsigns.get(`${route}|${dir}`) ?? '', stops: {} });
  const out = {};
  for (const [pi, s] of m) {
    out[pi] = [...s].sort((x, y) => x - y);
    schedEntries += s.size;
  }
  lines[route][dir].stops[stop] = out;
}
const schedules = { patterns: patternList, lines };

// shapes : shape_id -> [[lat, lon]] trié par séquence puis simplifié
console.log('Tracés…');
const shapePts = new Map();
for (const s of parseCsv(read('shapes.txt'))) {
  if (!shapePts.has(s.shape_id)) shapePts.set(s.shape_id, []);
  shapePts.get(s.shape_id).push([Number(s.shape_pt_sequence), Number(s.shape_pt_lat), Number(s.shape_pt_lon)]);
}
const shapeCache = new Map();
const getShape = (id) => {
  if (!shapeCache.has(id)) {
    const pts = (shapePts.get(id) ?? []).sort((a, b) => a[0] - b[0]).map((p) => [p[1], p[2]]);
    shapeCache.set(id, simplify(pts).map(([lat, lon]) => [+lat.toFixed(6), +lon.toFixed(6)]));
  }
  return shapeCache.get(id);
};

// assemblage par ligne
const variants = {};
let nbShapes = 0, nbStops = 0;
for (const [key, w] of winners) {
  const [route, dir] = key.split('|');
  const info = tripInfo.get(w.trip);
  const stopList = (winnerStops.get(w.trip) ?? []).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const shape = getShape(info.shape);
  nbShapes += shape.length; nbStops += stopList.length;
  (variants[route] ??= []).push({ dir, headsign: info.head, stops: stopList, shape });
}
for (const v of Object.values(variants)) v.sort((a, b) => a.dir.localeCompare(b.dir));

// GTFS_OUT=data-live : dossier hors git, rafraîchi sur le serveur (voir
// updater/supervisor.cjs). Écriture en .tmp puis renommage : un serveur qui
// redémarre pendant l'écriture ne lit jamais un fichier à moitié écrit.
const dataDir = resolve(__dirname, '..', process.env.GTFS_OUT || 'data');
mkdirSync(dataDir, { recursive: true });
const out = { 'routes.json': routes, 'stops.json': stops, 'route_variants.json': variants, 'schedules.json': schedules };
for (const [name, value] of Object.entries(out)) writeFileSync(join(dataDir, `${name}.tmp`), JSON.stringify(value), 'utf-8');
for (const name of Object.keys(out)) renameSync(join(dataDir, `${name}.tmp`), join(dataDir, name));
console.log(`OK — ${routes.length} lignes, ${Object.keys(stops).length} arrêts, ` +
  `${Object.keys(variants).length} lignes avec tracé (${nbShapes} pts, ${nbStops} arrêts).`);
console.log(`Horaires : ${Object.keys(lines).length} lignes, ${schedEntries} passages théoriques, ` +
  `${patternList.length} motifs de dates (${dates[0]} → ${dates[dates.length - 1]}).`);
