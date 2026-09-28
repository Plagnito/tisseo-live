// Serveur Tisséo Live — Toulouse
// ---------------------------------------------------------------
// Tisséo ne publie PAS de positions GPS (VehiclePositions) en open data.
// Le flux GTFS-RT officiel ne contient que des TripUpdates (horaires
// temps réel par arrêt) + des Alerts. Ce serveur estime donc la position
// de chaque véhicule par interpolation entre les deux arrêts qui
// l'encadrent à l'instant présent, puis "snappe" le point sur le tracé
// réel de la ligne quand le sens du trajet est identifiable.
// La logique pure vit dans lib/ et est testée par `npm test`.
// Sources :
//   - https://api.tisseo.fr/opendata/gtfsrt/GtfsRt.json (maj ~5 s)
//   - data/routes.json + data/stops.json + data/route_variants.json
//     + data/schedules.json (horaires de rail, repli sans RT)
//     (extraits du GTFS statique, régénérables via `npm run prepare-gtfs`)
// Deux Fillers garantissent qu'on voit quelque chose même sans réseau
// vers l'extérieur :
//   - lib/network.mjs → /api/network : tracés de toutes les lignes, c'est
//     le fond de la carte quand aucun fond raster ne charge (voir /api/tiles)
//   - public/vendor/   → Leaflet servi en local, plus de dépendance CDN
// ---------------------------------------------------------------
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModel, haversineM, GRACE_S } from './lib/core.mjs';
import { createRouter } from './lib/router.mjs';
import { loadSchedules, scheduleDepartures, mergeDepartures } from './lib/schedules.mjs';
import { buildNetwork } from './lib/network.mjs';
import { createTileProbe } from './lib/tiles.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3127;
const RT_URL = 'https://api.tisseo.fr/opendata/gtfsrt/GtfsRt.json';
const REFRESH_MS = 10_000; // pas plus d'un appel amont toutes les 10 s
const RT_TIMEOUT_MS = 8_000; // on ne bloque jamais une requête client 30 s
const HISTORY_MAX = 150; // ~25 min de traînée à 10 s par véhicule
const HISTORY_TTL_S = 45 * 60;

const routes = JSON.parse(readFileSync(join(__dirname, 'data', 'routes.json'), 'utf-8'));
const stops = JSON.parse(readFileSync(join(__dirname, 'data', 'stops.json'), 'utf-8'));
const variants = JSON.parse(readFileSync(join(__dirname, 'data', 'route_variants.json'), 'utf-8'));

const model = createModel({ routes, stops, variants });
const { routeById, modeOf, computeSnapshot, collectDepartures, searchStops } = model;
const router = createRouter({ stops, variants, routes });

// Repli d'horaires théoriques (le GTFS-RT ne couvre pas le métro) :
// data/schedules.json est produit par `npm run prepare-gtfs`.
let schedules = null;
try {
  schedules = loadSchedules(
    JSON.parse(readFileSync(join(__dirname, 'data', 'schedules.json'), 'utf-8')),
    { routeById, modeOf },
  );
  console.log(`Horaires theoriques : ${schedules.entries} couples arret/ligne, ${schedules.patterns} motifs de dates.`);
} catch (err) {
  console.warn('Pas de repli horaire (data/schedules.json) :', String(err.message || err));
}

// Géométrie de toutes les lignes, calculée une fois au démarrage : c'est le
// fond vectoriel de secours quand aucune tuile de carte n'est chargeable.
const network = buildNetwork({ routes, stops, variants, routeById, modeOf });
console.log(`Reseau vectoriel : ${network.points} lignes, ${network.lines.reduce((n, l) => n + l.shapes.reduce((m, s) => m + s.length, 0), 0)} points.`);

// Fonds de carte : on ne propose au client que les fournisseurs qui servent
// réellement une tuile (voir lib/tiles.mjs — CARTO répond 200 avec une image
// « API KEY REQUIRED », ce que le navigateur ne voit pas comme une erreur).
const tileCatalog = createTileProbe();
tileCatalog().then((c) => {
  console.log(`Fonds de carte : sombre=[${c.dark.map((t) => t.id).join(', ')}] clair=[${c.light.map((t) => t.id).join(', ')}]`
    + (c.rejected.length ? ` | rejetés : ${c.rejected.map((r) => `${r.id}/${r.mode} (${r.why})`).join(', ')}` : ''));
}).catch((e) => console.warn('Sonde des fonds de carte indisponible :', String(e.message || e)));

// --- Cache du flux temps réel -----------------------------------
let cache = { json: null, etag: null, fetchedAt: 0, error: null };

async function fetchRealtime() {
  const now = Date.now();
  if (cache.json && now - cache.fetchedAt < REFRESH_MS) return cache.json;
  try {
    const headers = {};
    if (cache.etag) headers['If-None-Match'] = cache.etag;
    const res = await fetch(RT_URL, { headers, signal: AbortSignal.timeout(RT_TIMEOUT_MS) });
    if (res.status === 304 && cache.json) {
      cache.fetchedAt = now;
      return cache.json;
    }
    if (!res.ok) throw new Error(`flux Tisséo HTTP ${res.status}`);
    const etag = res.headers.get('etag');
    const json = await res.json();
    if (!json || !Array.isArray(json.entity)) throw new Error('flux Tisséo malformé');
    cache = { json, etag, fetchedAt: now, error: null };
    return json;
  } catch (err) {
    cache.error = String(err.message || err);
    if (cache.json) return cache.json; // mode dégradé : resservir le dernier connu
    throw err;
  }
}

// --- Traînée des véhicules (mémoire vive, 45 min max) -------------
const history = new Map(); // "route_id|id" -> [{ t, lat, lon, status }]

function recordHistory(snap) {
  const t = snap.rt_timestamp;
  const cutoff = t - HISTORY_TTL_S;
  for (const v of snap.vehicles) {
    const k = `${v.route_id}|${v.id}`;
    let arr = history.get(k);
    if (!arr) { arr = []; history.set(k, arr); }
    const last = arr[arr.length - 1];
    // un point par timestamp de flux, et seulement s'il a bougé
    if (last && last.t === t) continue;
    if (last && Math.abs(last.lat - v.lat) < 1e-6 && Math.abs(last.lon - v.lon) < 1e-6 && last.status === v.status) continue;
    arr.push({ t, lat: +v.lat.toFixed(6), lon: +v.lon.toFixed(6), status: v.status });
    while (arr.length && arr[0].t < cutoff) arr.shift();
    if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  }
  if (history.size > 6000) {
    for (const [k, arr] of history) if (!arr.length || arr[arr.length - 1].t < cutoff) history.delete(k);
  }
}

let computed = null; // { rtTimestamp, snap, departures }
async function getComputed() {
  const rt = await fetchRealtime();
  const ts = rt?.header?.timestamp ?? 0;
  router.setFeed(rt);
  if (!computed || computed.rtTimestamp !== ts) {
    const snap = computeSnapshot(rt);
    const departures = collectDepartures(rt, ts);
    recordHistory(snap);
    computed = { rtTimestamp: ts, snap, departures };
  }
  const stale = Boolean(cache.error) || Date.now() - cache.fetchedAt > REFRESH_MS * 2;
  return { ...computed, stale };
}

// --- API ------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(cors());
// Compression des réponses texte (le tracé réseau complet fait ~290 Ko en
// JSON). Zlib est dans Node : pas de dépendance à ajouter.
app.use((req, res, next) => {
  if (!/gzip/.test(req.headers['accept-encoding'] || '')) return next();
  const orig = res.end.bind(res);
  res.end = (chunk, ...rest) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const type = String(res.getHeader('Content-Type'));
    const isText = type.startsWith('application/json') || type.startsWith('text/') || type.includes('javascript') || type.includes('css');
    const buf = isText && Buffer.isBuffer(chunk) ? chunk : null;
    if (!buf || buf.length < 2048) return orig(chunk, ...rest);
    const gz = gzipSync(buf);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.removeHeader('Content-Length');
    return orig(gz, ...rest);
  };
  next();
});
app.use(express.static(join(__dirname, 'public'), { maxAge: '5m' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function computedOrError(res) {
  try {
    return await getComputed();
  } catch (err) {
    res.status(502).json({ error: 'Flux temps réel Tisséo injoignable', detail: String(err.message || err) });
    return {};
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true, uptime_s: Math.round(process.uptime()) }));

// Fonds de carte disponibles, vérifiés côté serveur (HTTP + taille +
// dimensions + empreinte). ?force=1 relance la sonde.
app.get('/api/tiles', ah(async (req, res) => {
  res.json(await tileCatalog(req.query.force === '1'));
}));

app.get('/api/vehicles', ah(async (req, res) => {
  const c = await computedOrError(res);
  if (!c.snap) return;
  let vehicles = c.snap.vehicles;
  if (req.query.route_id) vehicles = vehicles.filter((v) => v.route_id === req.query.route_id);
  if (req.query.mode) {
    const modes = String(req.query.mode).split(',').map((m) => m.toLowerCase());
    vehicles = vehicles.filter((v) => modes.includes(v.mode.toLowerCase().replace('é', 'e')));
  }
  if (req.query.id) vehicles = vehicles.filter((v) => String(v.id) === String(req.query.id));
  res.json({
    generated_at: Math.floor(Date.now() / 1000),
    rt_timestamp: c.snap.rt_timestamp,
    stale: c.stale || undefined,
    count: vehicles.length,
    vehicles,
  });
}));

app.get('/api/routes', ah(async (req, res) => {
  const c = await computedOrError(res);
  if (!c.snap) return;
  res.json({
    rt_timestamp: c.snap.rt_timestamp,
    routes: routes.map((r) => ({ ...r, mode: modeOf(r), active: c.snap.perRoute[r.route_id] ?? 0 })),
  });
}));

app.get('/api/alerts', ah(async (req, res) => {
  const c = await computedOrError(res);
  if (!c.snap) return;
  res.json({ rt_timestamp: c.snap.rt_timestamp, count: c.snap.alerts.length, alerts: c.snap.alerts });
}));

// Recherche d'arrêts par nom (?q=…&n=…).
app.get('/api/stops/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const n = Math.max(1, Math.min(Number(req.query.n) || 8, 25));
  res.json({ q, count: q ? searchStops(q, n).length : 0, stops: searchStops(q, n) });
});

// Détail d'une ligne : sens, arrêts (coords) et tracés.
app.get('/api/route-detail', (req, res) => {
  const list = variants[req.query.route_id];
  if (!list) return res.status(404).json({ error: 'Ligne inconnue' });
  res.json({
    route_id: req.query.route_id,
    variants: list.map((v) => ({
      dir: v.dir,
      headsign: v.headsign,
      shape: v.shape,
      stops: v.stops
        .map((id) => ({ id, ...(stops[id] ? { name: stops[id].n, lat: stops[id].lat, lon: stops[id].lon } : { name: id, lat: null, lon: null }) }))
        .filter((s) => s.lat != null),
    })),
  });
});

// Tracés de toutes les lignes, simplifiés : permet de dessiner le réseau
// même sans fond de carte. ?tol=6&cell=5 (mètres) pour ajuster le niveau de
// détail ; les valeurs par défaut donnent ~10x moins de JSON que le GTFS.
app.get('/api/network', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  const tol = Number(req.query.tol);
  const cell = Number(req.query.cell);
  if (Number.isFinite(tol) || Number.isFinite(cell)) {
    return res.json(buildNetwork({ routes, stops, variants, routeById, modeOf }, {
      tolM: Number.isFinite(tol) ? tol : 6,
      cellM: Number.isFinite(cell) ? cell : 5,
    }));
  }
  res.json(network);
});

// Prochains passages à un (ou plusieurs) arrêt(s).
// ?stop_id=stop_point:SP_1  ou  ?stop_id=SP_1,SP_2  ou paramètre répété.
function stopIdList(raw) {
  const vals = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  // 20 arrêts max par requête : suffit pour les favoris, évite les abus.
  return [...new Set(vals.map((s) => String(s).trim()).filter(Boolean))].slice(0, 20);
}

// Lecture RT tolérante : si le flux est injoignable, on retombe sur les
// horaires théoriques plutôt que de répondre 502 d'emblée.
async function computedOrNull() {
  try {
    return await getComputed();
  } catch (err) {
    return { rtError: String(err.message || err) };
  }
}

// Groupement d'un arrêt physique : tous les quais/points voisins (< radius m)
// + départs temps réel + théoriques, dédoublonnés.
function buildDepartures(id, c, nowSec, radiusM = 150) {
  const s = stops[id];
  // stopsNear inclut l'arrêt lui-même : on dédoublonne le groupe.
  const group = [...new Set([id, ...router.stopsNear(s.lat, s.lon, radiusM).map((x) => x.id)])];
  const rtSeen = new Set();
  const rt = [];
  for (const g of group) {
    for (const d of c.departures?.get(g) ?? []) {
      // Même ligne + même heure = même passage (le feed duplique
      // parfois deux trip_id pour un même véhicule).
      const k = `${d.line}|${d.destination}|${d.time}`;
      if (rtSeen.has(k)) continue;
      rtSeen.add(k);
      rt.push(d);
    }
  }
  rt.sort((a, b) => a.time - b.time);
  // Les quais voisins peuvent publier le même passage théorique :
  // même ligne/sens/heure = une seule fois.
  const gtSeen = new Set();
  const gtfs = [];
  for (const g of group) {
    for (const d of scheduleDepartures(schedules, g, nowSec, 12)) {
      const k = `${d.route_id}|${d.dir}|${d.time}`;
      if (gtSeen.has(k)) continue;
      gtSeen.add(k);
      gtfs.push(d);
    }
  }
  gtfs.sort((a, b) => a.time - b.time);
  return { group, rt, gtfs };
}

app.get('/api/departures', ah(async (req, res) => {
  const ids = stopIdList(req.query.stop_id);
  if (!ids.length) return res.status(400).json({ error: 'stop_id invalide' });
  const bad = ids.filter((id) => !stops[id]);
  if (bad.length === ids.length) return res.status(400).json({ error: 'stop_id invalide' });
  const c = await computedOrNull();
  if (!c.snap && !schedules) {
    return res.status(502).json({ error: 'Flux temps réel Tisséo injoignable', detail: c.rtError });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const out = ids.filter((id) => stops[id]).map((id) => {
    const s = stops[id];
    let r = buildDepartures(id, c, nowSec);
    // Quai isolé (aucun voisin avec service) : on élargit une fois.
    if (!r.rt.length && !r.gtfs.length) r = buildDepartures(id, c, nowSec, 300);
    return {
      stop: { id, name: s.n, lat: s.lat, lon: s.lon, points: r.group.length },
      departures: mergeDepartures(r.rt, r.gtfs, 12),
    };
  });
  res.json({
    rt_timestamp: c.snap?.rt_timestamp,
    stale: c.stale || undefined,
    rt_error: c.rtError,
    degraded: !c.snap && schedules ? true : undefined,
    unknown: bad,
    stops: out,
    ...(out.length === 1 ? { stop: out[0].stop, departures: out[0].departures } : {}),
  });
}));

// Arrêts (stop_points) les plus proches + leurs prochains passages.
app.get('/api/nearby', ah(async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat/lon invalides' });
  const n = Math.max(1, Math.min(Number(req.query.n) || 8, 15));
  const c = await computedOrNull();
  if (!c.snap && !schedules) {
    return res.status(502).json({ error: 'Flux temps réel Tisséo injoignable', detail: c.rtError });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const scored = [];
  for (const [id, s] of Object.entries(stops)) {
    if (!id.startsWith('stop_point:')) continue;
    scored.push({ id, name: s.n, lat: s.lat, lon: s.lon, dist_m: Math.round(haversineM(lat, lon, s.lat, s.lon)) });
  }
  scored.sort((a, b) => a.dist_m - b.dist_m);
  const top = scored.slice(0, n).map((s) => {
    const g = buildDepartures(s.id, c, nowSec);
    return { ...s, departures: mergeDepartures(g.rt, g.gtfs, 3) };
  });
  res.json({ rt_timestamp: c.snap?.rt_timestamp, rt_error: c.rtError, count: top.length, stops: top });
}));

// Traînée d'un véhicule (points enregistrés depuis 45 min).
app.get('/api/track', ah(async (req, res) => {
  const { route_id: routeId, id } = req.query;
  if (!routeId || !id) return res.status(400).json({ error: 'route_id et id requis' });
  const c = await computedOrError(res);
  if (!c.snap) return;
  const key = `${routeId}|${id}`;
  const vehicle = c.snap.vehicles.find((v) => v.route_id === routeId && String(v.id) === String(id));
  res.json({
    rt_timestamp: c.snap.rt_timestamp,
    vehicle: vehicle ?? null,
    track: history.get(key) ?? [],
  });
}));

// --- Itinéraires (A → B) ---------------------------------------------
// Un point peut être : un id d'arrêt (?from_stop=…), des coordonnées
// (?from_lat=…&from_lon=…), "lat,lon" ou un nom d'arrêt (?from=capitole).
function parseEndpoint(prefix, req) {
  const stop = req.query[`${prefix}_stop`];
  if (stop) return stops[stop] ? { stop_id: stop } : null;
  const lat = Number(req.query[`${prefix}_lat`]);
  const lon = Number(req.query[`${prefix}_lon`]);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, label: req.query[`${prefix}_label`] };
  const q = req.query[prefix] ?? req.query[`${prefix}_q`];
  if (!q) return null;
  const m = String(q).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lat: Number(m[1]), lon: Number(m[2]) };
  const hit = searchStops(String(q), 1)[0];
  if (!hit) return null;
  return hit.kind === 'point' ? { stop_id: hit.id } : { lat: hit.lat, lon: hit.lon, label: hit.name };
}

app.get('/api/journey', ah(async (req, res) => {
  const from = parseEndpoint('from', req);
  const to = parseEndpoint('to', req);
  if (!from || !to) {
    const missing = [!from ? `from="${req.query.from ?? ''}"` : null, !to ? `to="${req.query.to ?? ''}"` : null]
      .filter(Boolean).join(' et ');
    return res.status(400).json({
      error: `Point introuvable : ${missing}`,
      hint: 'Nom d’arrêt (ex. "Capitole"), id (stop_point:SP_1912) ou coordonnées "lat,lon".',
    });
  }
  // SANS le RT on peut quand même calculer : les legs deviennent des
  // estimations horaires (real:false). Pas de 502 pour un trajet.
  try { await getComputed(); } catch { /* feed indisponible */ }
  const at = Number(req.query.at) || Math.floor(Date.now() / 1000);
  const out = router.journey(from, to, at);
  if (out.error) return res.status(422).json({ ...out, from: from.label, to: to.label });
  res.json(out);
}));

app.get('/api/status', ah(async (req, res) => {
  const c = await computedOrError(res);
  if (!c.snap) return;
  res.json({
    ok: true,
    rt_timestamp: c.snap.rt_timestamp,
    rt_age_s: Math.floor(Date.now() / 1000) - c.snap.rt_timestamp,
    vehicles: c.snap.vehicles.length,
    snapped: c.snap.vehicles.filter((v) => v.snapped).length,
    active_routes: Object.keys(c.snap.perRoute).length,
    alerts: c.snap.alerts.length,
    tracked_vehicles: history.size,
    stale: c.stale || undefined,
    upstream_error: cache.error || undefined,
    grace_s: GRACE_S,
  });
}));

// 404 API + gestionnaire d'erreurs central (aucune pile affichée au client).
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`[erreur] ${req.method} ${req.originalUrl} —`, err?.stack || err);
  res.status(500).json({ error: 'Erreur interne', detail: String(err?.message || err) });
});

const server = app.listen(PORT, () => {
  console.log(`Tisseo Live : http://localhost:${PORT}`);
  console.log(`Routes : ${routes.length} | Arrets : ${Object.keys(stops).length} | Lignes tracees : ${Object.keys(variants).length}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} déjà pris — lancez avec PORT=<autre> npm start`);
  else if (err.code === 'EACCES') console.error(`Port ${PORT} refusé par le système — lancez avec PORT=<autre> npm start`);
  else console.error(err);
  process.exit(1);
});
