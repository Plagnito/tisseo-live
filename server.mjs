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
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModel, haversineM, GRACE_S } from './lib/core.mjs';
import { createRouter } from './lib/router.mjs';
import { loadSchedules, scheduleDepartures, mergeDepartures, routeActiveAt, pairTimes, ymd } from './lib/schedules.mjs';
import { buildNetwork } from './lib/network.mjs';
import { createTileProbe } from './lib/tiles.mjs';
import { theoreticalVehicles } from './lib/theoretical.mjs';
import { createMcpServer } from './lib/mcp.mjs';
import { createTools, INSTRUCTIONS } from './lib/tools.mjs';
import { indexRealtime } from './lib/realtime.mjs';

// Les horaires théoriques (lib/schedules.mjs) raisonnent en heure LOCALE :
// sur un serveur réglé en UTC (Raspberry Pi, conteneur), tout serait décalé
// d'une à deux heures. Toulouse, quelle que soit la machine.
process.env.TZ = process.env.TISSEO_TZ || 'Europe/Paris';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4127;
const RT_URL = 'https://api.tisseo.fr/opendata/gtfsrt/GtfsRt.json';
const REFRESH_MS = 10_000; // pas plus d'un appel amont toutes les 10 s
const RT_TIMEOUT_MS = 8_000; // on ne bloque jamais une requête client 30 s
const HISTORY_MAX = 150; // ~25 min de traînée à 10 s par véhicule
const HISTORY_TTL_S = 45 * 60;

// Données GTFS : data-live/ (rafraîchi sur le serveur par le superviseur,
// hors git) quand il est complet, sinon data/ (versionné). Les horaires
// théoriques ont une date de fin : sans rafraîchissement, le métro perdrait
// ses horaires en silence le jour où la fenêtre publiée expire.
const DATA_FILES = ['routes.json', 'stops.json', 'route_variants.json', 'schedules.json'];
const DATA_DIR = DATA_FILES.every((f) => existsSync(join(__dirname, 'data-live', f))) ? 'data-live' : 'data';
const readData = (f) => JSON.parse(readFileSync(join(__dirname, DATA_DIR, f), 'utf-8'));
console.log(`Donnees GTFS : ${DATA_DIR}/`);
// Facultatifs (format 2 du GTFS exporté) : tarifs et métadonnées. Un
// data-live/ d'avant ce format ne les a pas : on les lit alors dans data/.
const readOptional = (f) => {
  for (const dir of [DATA_DIR, 'data']) {
    try { return JSON.parse(readFileSync(join(__dirname, dir, f), 'utf-8')); } catch { /* suivant */ }
  }
  return null;
};
const fares = readOptional('fares.json');
const gtfsMeta = readOptional('meta.json');
const routes = readData('routes.json');
const stops = readData('stops.json');
const variants = readData('route_variants.json');

const model = createModel({ routes, stops, variants });
const { routeById, modeOf, computeSnapshot, collectDepartures, searchStops, variantTrack } = model;
const router = createRouter({ stops, variants, routes });

// Repli d'horaires théoriques (le GTFS-RT ne couvre pas le métro) :
// data/schedules.json est produit par `npm run prepare-gtfs`.
let schedules = null;
try {
  schedules = loadSchedules(
    readData('schedules.json'),
    { routeById, modeOf },
  );
  console.log(`Horaires theoriques : ${schedules.entries} couples arret/ligne, ${schedules.patterns} motifs de dates.`);
} catch (err) {
  console.warn('Pas de repli horaire (data/schedules.json) :', String(err.message || err));
}

// Dernier jour couvert par les horaires théoriques ("YYYYMMDD"), ou null.
const scheduleUntil = schedules ? [...schedules.patternsByDate.keys()].sort().pop() ?? null : null;
if (scheduleUntil) console.log(`Horaires theoriques valables jusqu'au ${scheduleUntil}.`);

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
const ALERTS_HOLD_MS = 15 * 60_000;
let lastAlerts = { list: [], at: 0 };

// --- Métro : véhicules théoriques ---------------------------------------
// Le flux temps réel de Tisséo ne couvre pas le métro A/B, et le Téléo
// disparaît du flux aux heures creuses. Plutôt que de laisser le réseau
// incomplet, on anime ces rames à partir des horaires du GTFS statique, en
// les marquant `theoretical: true` pour que l'interface dise d'où ça sort.
// La liste est explicite : une déduction « ce mode n'a aucun véhicule là,
// maintenant » ferait apparaître des rames fantômes dès que le réseau est
// simplement calme — le mode est bien couvert, il n'y a juste personne.
const THEO_MODES = new Set(
  (process.env.TISSEO_THEO_MODES ?? 'Métro,Téléo').split(',').map((s) => s.trim()).filter(Boolean)
);
let showTheoretical = true;
// Horloge injectable (TISSEO_NOW, epoch en secondes). Sert aux tests et au
// rejeu : le métro n'a aucune rame théorique à 00h10, ce qui rendrait une
// vérification automatique dépendante de l'heure de la machine.
const CLOCK = () => (Number(process.env.TISSEO_NOW) || Math.floor(Date.now() / 1000));
function theoreticalVehiclesFor(snap, nowSec) {
  if (!showTheoretical || !schedules?.byRoute) return [];
  // Filet de sécurité : si un mode se met un jour à être couvert par le flux,
  // on ne fabrique plus de véhicules pour lui.
  const liveModes = new Set(snap.vehicles.map((v) => v.mode));
  const wanted = new Set([...THEO_MODES].filter((m) => !liveModes.has(m)));
  if (!wanted.size) return [];
  const out = [];
  for (const route of routes) {
    const mode = modeOf(route);
    if (!wanted.has(mode)) continue;
    for (const key of schedules.byRoute.keys()) {
      const [routeId, dir] = key.split('|');
      if (routeId !== route.route_id) continue;
      const track = variantTrack(routeId, dir);
      if (!track) continue;
      out.push(...theoreticalVehicles(schedules, routeId, dir, nowSec, {
        stops,
        route,
        orderStops: track.variant.stops,
        shapeIndex: track.idx,
        stopS: track.stopS,
        modeLabel: mode,
        headsign: track.variant.headsign,
      }));
    }
  }
  return out;
}

async function getComputed() {
  const rt = await fetchRealtime();
  const ts = rt?.header?.timestamp ?? 0;
  router.setFeed(rt);
  if (!computed || computed.rtTimestamp !== ts) {
    const snap = computeSnapshot(rt);
    // Le flux publie parfois une mise à jour SANS aucune alerte, puis les
    // retrouve la suivante (vu le 28/09 : 52 → 0 → 52 en une minute). Un
    // « aucune perturbation » faux est pire qu'une alerte vieille de 10 min.
    if (snap.alerts.length) lastAlerts = { list: snap.alerts, at: Date.now() };
    else if (lastAlerts.list.length && Date.now() - lastAlerts.at < ALERTS_HOLD_MS) snap.alerts = lastAlerts.list;
    const departures = collectDepartures(rt, ts);
    computed = { rtTimestamp: ts, rt: snap, departures };
  }
  // Les positions théoriques avancent même quand le flux est figé : on les
  // recompose à chaque lecture au lieu de les laisser dans le cache.
  const live = computed.rt;
  const theo = theoreticalVehiclesFor(live, CLOCK());
  const perRoute = { ...live.perRoute };
  for (const v of theo) perRoute[v.route_id] = (perRoute[v.route_id] ?? 0) + 1;
  const vehicles = live.vehicles.concat(theo);
  recordHistory({ rt_timestamp: live.rt_timestamp, vehicles });
  const stale = Boolean(cache.error) || Date.now() - cache.fetchedAt > REFRESH_MS * 2;
  return {
    rtTimestamp: computed.rtTimestamp,
    snap: { ...live, vehicles, perRoute },
    departures: computed.departures,
    stale,
  };
}



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
// Les modules purs de lib/ (motion, itinerary) sont servis tels quels : le
// navigateur importe exactement le code que couvre `npm test`, au lieu d'une
// recopie dans public/ qui divergerait en silence.
app.use('/lib', express.static(join(__dirname, 'lib'), { maxAge: '5m' }));

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

// --- Push temps réel (SSE) -------------------------------------------------
// Le client sondait toutes les 15 s alors que le flux amont change toutes les
// ~10 s : la moitié des rafraîchissements n'apportaient rien, et le retard
// d'affichage oscillait entre 0 et 15 s. Le serveur sait à la seconde près
// quand le flux change (rt_timestamp) : on le pousse, et le client ne garde
// le sondage 15 s que comme filet de sécurité.
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx/tunnel ne doivent pas mettre en tampon
  });
  res.write('retry: 5000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Math.floor(Date.now() / 1000) })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// Un tour de boucle partagée : à chaque changement de flux, on prévient.
let lastPushedTs = -1;
async function pushToStream() {
  if (!sseClients.size) return;
  try {
    const rt = await fetchRealtime();
    const ts = rt?.header?.timestamp ?? 0;
    if (!ts || ts === lastPushedTs) return;
    lastPushedTs = ts;
    const payload = `event: update\ndata: ${JSON.stringify({ rt_timestamp: ts })}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
    }
  } catch { /* le flux est déjà en mode dégradé, le client le verra au */ }
  // prochain GET /api/vehicles */
}
setInterval(pushToStream, 3000).unref();

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
      rt.push({ ...d, stop_id: g });
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
      gtfs.push({ ...d, stop_id: g });
    }
  }
  gtfs.sort((a, b) => a.time - b.time);
  return { group, rt, gtfs };
}

// Passages fusionnés (RT + théorique) d'un arrêt ; un quai isolé (aucun
// voisin avec service) élargit une fois le rayon de regroupement.
function departuresAt(id, c, nowSec, n = 12) {
  let r = buildDepartures(id, c, nowSec);
  if (!r.rt.length && !r.gtfs.length) r = buildDepartures(id, c, nowSec, 300);
  return { points: r.group.length, departures: mergeDepartures(r.rt, r.gtfs, n) };
}

// Les n stop_points les plus proches d'un point, avec la distance.
function nearestStopPoints(lat, lon, n) {
  const scored = [];
  for (const [id, s] of Object.entries(stops)) {
    if (!id.startsWith('stop_point:')) continue;
    scored.push({ id, name: s.n, lat: s.lat, lon: s.lon, dist_m: Math.round(haversineM(lat, lon, s.lat, s.lon)) });
  }
  scored.sort((a, b) => a.dist_m - b.dist_m);
  return scored.slice(0, n);
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
    const r = departuresAt(id, c, nowSec, 12);
    return {
      stop: { id, name: s.n, lat: s.lat, lon: s.lon, points: r.points },
      departures: r.departures,
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
  const top = nearestStopPoints(lat, lon, n).map((s) => {
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
  const out = router.journey(from, to, at, journeyOpts);
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
    data_dir: DATA_DIR,
    schedules_until: scheduleUntil,
    stale: c.stale || undefined,
    upstream_error: cache.error || undefined,
    grace_s: GRACE_S,
  });
}));

// --- Connecteur MCP (ChatGPT, Claude…) ---------------------------------
// Prochain départ THÉORIQUE d'une ligne à un arrêt, dans le sens qui va de
// board à alight : c'est ce qui donne un temps d'attente aux étapes que le
// temps réel ne couvre pas (métro, creux du flux).
function nextDeparture(routeId, board, alight, t) {
  if (!schedules) return null;
  const v = (variants[routeId] ?? []).find((x) => {
    const i = x.stops.indexOf(board);
    return i >= 0 && x.stops.indexOf(alight) > i;
  });
  const pick = (list) => list.find((x) => x.route_id === routeId && (!v || x.dir === v.dir));
  // D'abord les 2 h qui viennent ; sinon la nuit entière : à 00 h 30, le
  // prochain bus est souvent à 05 h 15, et « aucun horaire » ferait
  // inventer un départ immédiat.
  const d = pick(scheduleDepartures(schedules, board, t, 400))
    ?? pick(scheduleDepartures(schedules, board, t, 20_000, 14 * 3600));
  return d ? d.time : null;
}

// Ligne en service à l'heure t ? Horaires théoriques, et — pour un départ
// proche de maintenant — la présence de véhicules dans le flux temps réel.
// null = on ne sait pas (la ligne n'est alors pas écartée).
function inService(routeId, t) {
  const nowish = Math.abs(t - Date.now() / 1000) < 30 * 60;
  if (nowish && computed?.snap?.perRoute?.[routeId]) return true;
  return routeActiveAt(schedules, routeId, t);
}
// Heure d'ARRIVÉE théorique d'une course partie de board à depT : on
// retrouve le départ dans la grille, puis son arrivée par appariement.
function scheduledArrival(routeId, board, alight, depT, estS) {
  if (!schedules || !(estS > 0)) return null;
  const v = (variants[routeId] ?? []).find((x) => {
    const i = x.stops.indexOf(board);
    return i >= 0 && x.stops.indexOf(alight) > i;
  });
  const pick = (id) => (schedules.byStop.get(id) ?? []).filter((e) => e.route_id === routeId && (!v || e.dir === v.dir));
  const eB = pick(board), eA = pick(alight);
  if (!eB.length || !eA.length) return null;
  const day0 = new Date(depT * 1000);
  for (const offset of [0, -1]) {
    const day = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + offset);
    const mid = Math.floor(day.getTime() / 1000);
    const secs = depT - mid;
    for (const pi of schedules.patternsByDate.get(ymd(day)) ?? []) {
      const B = [...new Set(eB.flatMap((e) => e.perPat[pi] ?? []))].sort((a, b) => a - b);
      if (!B.includes(secs)) continue;
      const A = [...new Set(eA.flatMap((e) => e.perPat[pi] ?? []))].sort((a, b) => a - b);
      const hit = pairTimes(B, A, estS).find(([b]) => b === secs);
      if (hit) return mid + hit[1];
    }
  }
  return null;
}
const journeyOpts = { nextDeparture, inService, scheduledArrival };

// Géocodage d'adresses et de lieux (IGN Géoplateforme, sans clé), biaisé
// vers Toulouse. Cache mémoire : un même lieu revient souvent.
const GEOCODE_URL = 'https://data.geopf.fr/geocodage/search';
const geoCache = new Map();
async function geocode(q) {
  const key = String(q).trim().toLowerCase();
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.list;
  const url = `${GEOCODE_URL}?${new URLSearchParams({ q: key.slice(0, 200), index: 'address,poi', limit: '6', lat: '43.6045', lon: '1.4442' })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'TisseoLive/1.0 (plagnito.com)' } });
  if (!res.ok) throw new Error(`géocodeur HTTP ${res.status}`);
  const json = await res.json();
  const list = (json.features ?? [])
    .filter((f) => (f.properties?.score ?? 0) >= 0.45)
    .map((f) => {
      const p = f.properties;
      const city = Array.isArray(p.city) ? p.city[0] : p.city;
      return {
        label: p._type === 'poi' ? `${p.toponym ?? [].concat(p.name)[0]}${city ? `, ${city}` : ''}` : p.label,
        type: p._type === 'poi' ? 'poi' : 'address',
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        score: p.score,
      };
    });
  if (geoCache.size > 1000) geoCache.delete(geoCache.keys().next().value);
  geoCache.set(key, { at: Date.now(), list });
  return list;
}

const mcp = createMcpServer({
  name: 'tisseo-live',
  title: 'Tisséo Live',
  version: '1.0.0',
  instructions: INSTRUCTIONS,
  tools: createTools({
    routes, stops, variants, routeById, modeOf, searchStops,
    live: getComputed,
    liveOrNull: computedOrNull,
    departuresAt: (id, c, nowSec, n) => departuresAt(id, c, nowSec, n).departures,
    nearestStopPoints,
    journey: async (from, to, at, extra = {}) => {
      try { await getComputed(); } catch { /* sans RT : horaires théoriques */ }
      return router.journey(from, to, at, { ...journeyOpts, ...extra });
    },
    track: (routeId, id) => history.get(`${routeId}|${id}`),
    scheduleUntil: () => scheduleUntil,
    // Horaires théoriques bruts : entrées d'un arrêt, motifs actifs un jour donné.
    scheduleEntries: (stopId) => schedules?.byStop.get(stopId) ?? [],
    // Passages théoriques d'un quai à partir de t (horizon en secondes).
    scheduleAt: (stopId, t, n = 60, horizonS = 2 * 3600) => scheduleDepartures(schedules, stopId, t, n, horizonS),
    // Flux temps réel indexé : retards, heures théoriques, courses.
    rtIndex: () => indexRealtime(cache.json),
    patternsOn: (ymd) => schedules?.patternsByDate.get(ymd) ?? [],
    reach: (fromStop, maxS, exclude, at) => {
      const excluded = new Set(exclude ?? []);
      for (const r of routes) if (inService(r.route_id, at) === false) excluded.add(r.route_id);
      return router.reach(fromStop, maxS, excluded.size ? excluded : null);
    },
    nearestStop: (lat, lon) => router.nearestStop(lat, lon),
    rideEstimate: (routeId, board, alight) => router.estimate(routeId, board, alight),
    fares,
    gtfsMeta,
    publicUrl: process.env.PUBLIC_URL || 'https://tisseo.plagnito.com',
    geocode,
  }),
});

// Garde-fou : l'URL est publique et sans compte. 120 appels / min / IP
// couvrent largement une conversation, pas un aspirateur.
const MCP_RATE = { windowMs: 60_000, max: 120 };
const mcpHits = new Map();
function mcpRateLimit(req, res, next) {
  const ip = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const t = Date.now();
  let e = mcpHits.get(ip);
  if (!e || t - e.start > MCP_RATE.windowMs) { e = { start: t, n: 0 }; mcpHits.set(ip, e); }
  if (++e.n > MCP_RATE.max) {
    res.set('Retry-After', String(Math.ceil((e.start + MCP_RATE.windowMs - t) / 1000)));
    return res.status(429).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32000, message: 'Trop de requêtes : réessayez dans une minute.' } });
  }
  if (mcpHits.size > 5000) for (const [k, v] of mcpHits) if (t - v.start > MCP_RATE.windowMs) mcpHits.delete(k);
  next();
}
const mcpJson = express.json({ limit: '256kb' });
app.all('/mcp', mcpRateLimit, (req, res, next) => {
  if (req.method !== 'POST') return next();
  mcpJson(req, res, (err) => {
    if (err) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON invalide' } });
    next();
  });
}, ah(mcp.httpHandler));

// 404 API + gestionnaire d'erreurs central (aucune pile affichée au client).
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`[erreur] ${req.method} ${req.originalUrl} —`, err?.stack || err);
  res.status(500).json({ error: 'Erreur interne', detail: String(err?.message || err) });
});

// HOST=127.0.0.1 sur le Pi : seul cloudflared (local) doit pouvoir joindre le
// serveur. Par défaut toutes les interfaces, comme avant (test sur le LAN).
const server = app.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`Tisseo Live : http://localhost:${PORT}`);
  console.log(`Routes : ${routes.length} | Arrets : ${Object.keys(stops).length} | Lignes tracees : ${Object.keys(variants).length}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} déjà pris — lancez avec PORT=<autre> npm start`);
  else if (err.code === 'EACCES') {
    // C'est le piège le plus vicieux sur Windows : un port réservé par
    // Hyper-V/WSL (plages d'exclusion) ne donne pas « déjà utilisé » mais
    // « accès refusé », et rien n'écoute. Le port par défaut de ce projet
    // (4127) a justement été choisi pour être hors de ces plages.
    console.error(`Port ${PORT} refusé par le système.`);
    console.error('S\'il est dans une plage d\'exclusion Windows, aucun processus ne l\'aura libre :');
    console.error('  netsh interface ipv4 show excludedportrange protocol=tcp');
    console.error('Essayez-en un autre :  PORT=5200 npm start');
    process.exit(1);
  }
  else console.error(err);
  process.exit(1);
});
