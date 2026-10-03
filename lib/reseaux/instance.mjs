// Un réseau en direct : ses flux GTFS-RT lus à la demande, son GTFS statique
// préparé une fois (processus à part) et rechargé du disque.
//
// Deux natures de position, dites telles quelles au client :
//  · « gps »    — le réseau publie la position de ses véhicules (VehiclePositions) ;
//  · « estime » — il ne publie que des horaires temps réel (TripUpdates) : le
//    véhicule est placé entre l'arrêt qu'il vient de quitter et le suivant,
//    comme le fait la carte de Toulouse depuis le début.
import { decodeGtfsRt, feedKinds, mergeFeeds } from './gtfsrt.mjs';
import { distM } from './gtfs.mjs';
import { createPlanner } from './planificateur.mjs';

const UA = 'TisseoLive/1.4 (https://tisseo.plagnito.com)';
const FEED_MIN_MS = 20_000;      // un flux n'est pas relu plus souvent
const FEED_MAX_BYTES = 12 * 1024 * 1024;
const STATIC_MAX_AGE_MS = 7 * 86_400_000;
const STALE_S = 600;             // une position de plus de dix minutes n'est plus « en direct »
const PLAN_MAX_AGE_MS = 4 * 86_400_000; // les horaires gardent quinze jours : refaits bien avant la fin

// --- adresses : le catalogue est public, pas digne de confiance aveugle ---------
// Une fiche pourrait pointer vers la machine elle-même ou le réseau local.
export function publicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return null;
  }
  if (h.includes(':') && (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:'))) return null;
  return u;
}

// Suit les redirections à la main : chacune est revérifiée.
async function safeFetch(fetcher, url, { timeoutMs = 10_000 } = {}) {
  let u = publicUrl(url);
  for (let hop = 0; u && hop < 5; hop++) {
    const res = await fetcher(u, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': UA, Accept: 'application/x-protobuf, application/octet-stream, */*' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      u = publicUrl(new URL(res.headers.get('location'), u).href);
      continue;
    }
    return res;
  }
  throw new Error('adresse refusée');
}

// Quelques réseaux servent leur flux en JSON (clés en camelCase) : même forme
// que le protobuf décodé une fois les clés remises en snake_case.
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
function snakeKeys(x) {
  if (Array.isArray(x)) return x.map(snakeKeys);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [snake(k), snakeKeys(v)]));
  return x;
}
export function decodeFeed(bytes) {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf)) i++;
  if (bytes[i] === 0x7b) {
    const feed = snakeKeys(JSON.parse(new TextDecoder().decode(bytes)));
    if (!feed.header) throw new RangeError('flux JSON sans en-tête');
    feed.entity ??= [];
    return feed;
  }
  return decodeGtfsRt(bytes);
}

// --- géométrie le long d'un tracé ----------------------------------------------
const cumul = new WeakMap();
function lengths(line) {
  let c = cumul.get(line);
  if (!c) {
    c = new Float64Array(line.length);
    for (let i = 1; i < line.length; i++) c[i] = c[i - 1] + distM(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
    cumul.set(line, c);
  }
  return c;
}
// Abscisse (m) du point du tracé le plus proche, et son écart.
export function project(line, lat, lon) {
  const c = lengths(line);
  let best = { s: 0, d: Infinity };
  const k = Math.cos((lat * Math.PI) / 180);
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][1] * k, ay = line[i - 1][0], bx = line[i][1] * k, by = line[i][0];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((lon * k - ax) * dx + (lat - ay) * dy) / len2)) : 0;
    const pLat = ay + t * dy, pLon = (ax + t * dx) / k;
    const d = distM(lat, lon, pLat, pLon);
    if (d < best.d) best = { s: c[i - 1] + t * (c[i] - c[i - 1]), d };
  }
  return best;
}
// Point et cap à l'abscisse s.
export function pointAt(line, s) {
  const c = lengths(line);
  const total = c[c.length - 1];
  const x = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < c.length - 1 && c[i] < x) i++;
  const seg = c[i] - c[i - 1];
  const t = seg ? (x - c[i - 1]) / seg : 0;
  const [aLat, aLon] = line[i - 1], [bLat, bLon] = line[i];
  return { lat: aLat + t * (bLat - aLat), lon: aLon + t * (bLon - aLon), bearing: bearing(aLat, aLon, bLat, bLon) };
}
export function bearing(aLat, aLon, bLat, bLon) {
  const y = (bLon - aLon) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180), x = bLat - aLat;
  if (!x && !y) return null;
  return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
}

// « GARE ST JEAN » → « Gare St Jean » : bien des GTFS écrivent leurs destinations
// en capitales. Un nom déjà en minuscules est laissé tel quel.
export function joli(s) {
  if (!s || s !== s.toUpperCase() || !/[A-ZÀ-Ý]{2}/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s\-'’(/.])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
}

// --- statique : index de lecture -----------------------------------------------
export function indexNet(net) {
  const routeById = new Map(net.routes.map((r, i) => [r.id, i]));
  const stopById = new Map(net.stops.map((s) => [s[0], s]));
  // Les flux n'écrivent pas toujours l'identifiant de ligne comme le GTFS
  // (« 8-B » d'un côté, « B » de l'autre) : seconde chance par le nom court,
  // puis par la fin de l'identifiant.
  const routeByShort = new Map();
  for (const [i, r] of net.routes.entries()) if (!routeByShort.has(r.short)) routeByShort.set(r.short, i);
  const loose = new Map();
  function route(routeId, tripId) {
    if (routeId != null && routeById.has(routeId)) return net.routes[routeById.get(routeId)];
    const t = tripId != null ? net.trips[tripId] : null;
    if (t) return net.routes[t[0]];
    if (routeId == null) return null;
    if (loose.has(routeId)) return loose.get(routeId);
    const tail = String(routeId).split(/[:\-_]/).pop();
    let i = routeByShort.get(String(routeId)) ?? routeByShort.get(tail);
    if (i === undefined) i = net.routes.findIndex((r) => r.id.split(/[:\-_]/).pop() === tail);
    const r = i >= 0 && i !== undefined ? net.routes[i] : null;
    if (loose.size < 5000) loose.set(routeId, r);
    return r;
  }
  const trip = (tripId) => (tripId != null ? net.trips[tripId] ?? null : null);
  const headsign = (tripId) => { const t = trip(tripId); return t && t[2] >= 0 ? joli(net.headsigns[t[2]]) : null; };
  const shape = (r, dir) => {
    const i = r ? routeById.get(r.id) : undefined;
    if (i === undefined) return null;
    return net.shapes[`${i}|${dir ?? 0}`]?.[0] ?? net.shapes[`${i}|${dir ? 0 : 1}`]?.[0] ?? null;
  };
  const shapes = (r) => { const i = r ? routeById.get(r.id) : undefined; return i === undefined ? [] : [...(net.shapes[`${i}|0`] ?? []), ...(net.shapes[`${i}|1`] ?? [])]; };
  return { net, route, trip, headsign, shape, shapes, stop: (id) => stopById.get(id) ?? null };
}

// --- véhicules ------------------------------------------------------------------
const STATUS = { 0: 'en approche', 1: 'à l\'arrêt', 2: 'en route' };
const routeBrief = (r, rawId) => (r
  ? { line: r.short, route_id: r.id, mode: r.mode, color: r.color, text: r.text, long: r.long || null }
  : { line: rawId != null ? String(rawId).split(/[:]/).pop().slice(0, 8) : '?', route_id: rawId ?? null, mode: 'Bus', color: null, text: null, long: null });

// Positions publiées (VehiclePositions).
export function vehiclesFromPositions(feeds, ix, t) {
  const out = [];
  for (const feed of feeds) {
    const feedTs = Number(feed.header?.timestamp) || 0;
    for (const e of feed.entity ?? []) {
      const v = e.vehicle, p = v?.position;
      if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || (Math.abs(p.latitude) < 0.01 && Math.abs(p.longitude) < 0.01)) continue;
      const ts = Number(v.timestamp) || feedTs || 0;
      if (ts && t - ts > STALE_S) continue;
      const tripId = v.trip?.trip_id ?? null;
      const r = ix?.route(v.trip?.route_id ?? null, tripId) ?? null;
      // m/s d'après la norme ; certains flux écrivent des km/h : on ne montre
      // une vitesse que si elle est plausible une fois convertie.
      const kmh = Number.isFinite(p.speed) ? Math.round(p.speed * 3.6) : null;
      const stop = v.stop_id != null ? ix?.stop(v.stop_id) : null;
      out.push({
        id: String(v.vehicle?.id ?? tripId ?? e.id),
        label: joli(v.vehicle?.label ?? null),
        lat: p.latitude, lon: p.longitude,
        bearing: Number.isFinite(p.bearing) ? Math.round(p.bearing) : null,
        speed_kmh: kmh !== null && kmh >= 0 && kmh <= 90 ? kmh : null,
        ...routeBrief(r, v.trip?.route_id),
        headsign: ix?.headsign(tripId) ?? null,
        trip_id: tripId,
        dir: v.trip?.direction_id ?? ix?.trip(tripId)?.[1] ?? null,
        stop: stop ? stop[1] : null,
        // Un véhicule « à l'arrêt » qui roule à 20 km/h est en route.
        status: v.current_status != null ? (v.current_status === 1 && kmh !== null && kmh >= 6 && kmh <= 90 ? 'en route' : STATUS[v.current_status] ?? null) : null,
        ts: ts || null,
        estimated: false,
      });
    }
  }
  return out;
}

const stuTime = (u, first) => Number((first ? u.arrival?.time : u.departure?.time) ?? u.departure?.time ?? u.arrival?.time) || 0;

// Positions déduites des horaires temps réel (TripUpdates), faute de mieux.
// memoire : Map(course → { next, arr, passed }) gardée d'une lecture à l'autre.
// Beaucoup de flux ne listent que les arrêts À VENIR : l'arrêt que le véhicule
// vient de quitter n'y est plus. On le retient au moment où il disparaît, ce
// qui donne les deux bouts du tronçon en cours.
export function vehiclesFromTripUpdates(feeds, ix, t, memoire = null) {
  const out = [];
  if (!ix) return out;
  const vues = new Set();
  for (const feed of feeds) {
    for (const e of feed.entity ?? []) {
      const tu = e.trip_update;
      if (!tu?.stop_time_update?.length || tu.trip?.schedule_relationship === 3) continue;
      const pts = [];
      for (const u of tu.stop_time_update) {
        const s = ix.stop(u.stop_id);
        const arr = stuTime(u, true), dep = stuTime(u, false);
        if (s && (arr || dep) && u.schedule_relationship !== 1) pts.push({ s, arr: arr || dep, dep: dep || arr, seq: u.stop_sequence ?? null });
      }
      if (!pts.length) continue;
      pts.sort((a, b) => a.arr - b.arr);
      const tripId = tu.trip?.trip_id ?? null;
      const r = ix.route(tu.trip?.route_id ?? null, tripId);
      const dir = tu.trip?.direction_id ?? ix.trip(tripId)?.[1] ?? 0;
      const line = ix.shape(r, dir);
      let i = -1;
      for (let k = 0; k < pts.length; k++) if (pts[k].dep <= t) i = k;
      let pos = null, next = null, status = 'en route';
      if (i === pts.length - 1) {
        if (t - pts[i].dep > 60) continue; // course terminée
        pos = { lat: pts[i].s[2], lon: pts[i].s[3], bearing: null }; next = pts[i]; status = 'à l\'arrêt';
      } else if (i >= 0) {
        const a = pts[i], b = pts[i + 1];
        next = b;
        if (t < a.dep) { pos = { lat: a.s[2], lon: a.s[3], bearing: null }; status = 'à l\'arrêt'; }
        else {
          const f = b.arr > a.dep ? Math.max(0, Math.min(1, (t - a.dep) / (b.arr - a.dep))) : 1;
          if (line) {
            const pa = project(line, a.s[2], a.s[3]), pb = project(line, b.s[2], b.s[3]);
            if (pa.d < 120 && pb.d < 120 && pb.s > pa.s) pos = pointAt(line, pa.s + f * (pb.s - pa.s));
          }
          pos ??= { lat: a.s[2] + f * (b.s[2] - a.s[2]), lon: a.s[3] + f * (b.s[3] - a.s[3]), bearing: bearing(a.s[2], a.s[3], b.s[2], b.s[3]) };
        }
      } else {
        // Le flux ne garde que les arrêts à venir : le véhicule est en amont du
        // premier. Pas encore parti si c'est le départ de la course.
        const b = pts[0], dt = b.arr - t;
        next = b;
        let quitte = null;
        if (memoire && tripId != null) {
          vues.add(tripId);
          let m = memoire.get(tripId);
          if (!m) memoire.set(tripId, m = { next: b.s[0], arr: b.arr, passed: null });
          else if (m.next !== b.s[0]) { m.passed = { s: ix.stop(m.next), dep: Math.min(m.arr, t) }; m.next = b.s[0]; m.arr = b.arr; }
          else m.arr = b.arr;
          if (m.passed?.s && m.passed.s[0] !== b.s[0]) quitte = m.passed;
        }
        if (dt > 900 || (!quitte && (b.seq === null || b.seq <= 1) && dt > 45)) continue;
        if (dt <= 20) { pos = { lat: b.s[2], lon: b.s[3], bearing: null }; status = dt <= 0 ? 'à l\'arrêt' : 'en approche'; }
        else if (quitte) {
          const a = quitte.s, f = b.arr > quitte.dep ? Math.max(0, Math.min(1, (t - quitte.dep) / (b.arr - quitte.dep))) : 1;
          if (line) {
            const pa = project(line, a[2], a[3]), pb = project(line, b.s[2], b.s[3]);
            if (pa.d < 120 && pb.d < 120 && pb.s > pa.s) pos = pointAt(line, pa.s + f * (pb.s - pa.s));
          }
          pos ??= { lat: a[2] + f * (b.s[2] - a[2]), lon: a[3] + f * (b.s[3] - a[3]), bearing: bearing(a[2], a[3], b.s[2], b.s[3]) };
        } else if (line) {
          const pb = project(line, b.s[2], b.s[3]);
          if (pb.d < 120) pos = pointAt(line, Math.max(0, pb.s - Math.min(1500, dt * 5.5)));
        }
        if (!pos) { if (dt > 150) continue; pos = { lat: b.s[2], lon: b.s[3], bearing: null }; status = 'en approche'; }
      }
      out.push({
        id: String(tu.vehicle?.id ?? tripId ?? e.id),
        label: tu.vehicle?.label ?? null,
        lat: pos.lat, lon: pos.lon, bearing: pos.bearing, speed_kmh: null,
        ...routeBrief(r, tu.trip?.route_id),
        headsign: ix.headsign(tripId) ?? pts[pts.length - 1].s[1],
        trip_id: tripId, dir,
        stop: next ? next.s[1] : null,
        status,
        // Une estimation date de l'instant du flux, pas de la course.
        ts: Number(feed.header?.timestamp) || Number(tu.timestamp) || null,
        estimated: true,
      });
    }
  }
  if (memoire) for (const k of memoire.keys()) if (!vues.has(k)) memoire.delete(k);
  return out;
}

// Un même véhicule publié par deux flux (l'officiel et un agrégateur) : on
// garde le premier. Même identifiant, ou même ligne à moins de 40 m.
export function dedupe(list) {
  const out = [], ids = new Set();
  for (const v of list) {
    if (ids.has(v.id)) continue;
    if (out.some((o) => o.line === v.line && Math.abs(o.lat - v.lat) < 0.0006 && distM(o.lat, o.lon, v.lat, v.lon) < 40)) continue;
    ids.add(v.id); out.push(v);
  }
  return out;
}

// Prochains passages à un arrêt, lus dans les horaires temps réel.
export function departuresFromTripUpdates(feeds, ix, stopIds, t, max = 16) {
  const out = [];
  for (const feed of feeds) {
    for (const e of feed.entity ?? []) {
      const tu = e.trip_update;
      if (!tu?.stop_time_update?.length || tu.trip?.schedule_relationship === 3) continue;
      const list = tu.stop_time_update;
      for (let k = 0; k < list.length; k++) {
        const u = list[k];
        if (!stopIds.has(u.stop_id) || u.schedule_relationship === 1) continue;
        const time = stuTime(u, false);
        if (!time || time < t - 30 || time > t + 2 * 3600) continue;
        if (k === list.length - 1 && list.length > 1) continue; // terminus : personne n'y monte
        const tripId = tu.trip?.trip_id ?? null;
        const r = ix?.route(tu.trip?.route_id ?? null, tripId) ?? null;
        const last = ix?.stop(list[list.length - 1].stop_id);
        const delay = Number(u.departure?.delay ?? u.arrival?.delay);
        out.push({
          ...routeBrief(r, tu.trip?.route_id),
          headsign: ix?.headsign(tripId) ?? (last ? last[1] : null),
          time,
          delay_s: Number.isFinite(delay) ? delay : null,
          trip_id: tripId,
        });
      }
    }
  }
  const seen = new Set();
  return out.sort((a, b) => a.time - b.time)
    .filter((d) => { const k = `${d.line}|${d.headsign}|${Math.round(d.time / 30)}`; return seen.has(k) ? false : seen.add(k); })
    .slice(0, max);
}

// Une suggestion doit porter ce qui est tapé : chaque mot de la saisie (hors
// « de », « la »… et hors numéro) commence un mot du libellé. Le géocodeur, lui,
// rend volontiers un lieu sans rapport pour une adresse à moitié tapée.
const VIDES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'a', 'au', 'aux', 'et', 'en']);
const ABREGES = { bd: 'boulevard', bld: 'boulevard', av: 'avenue', ave: 'avenue', pl: 'place', ch: 'chemin', rte: 'route', all: 'allee', imp: 'impasse', st: 'saint', ste: 'sainte' };
const platNom = (x) => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function matcher(q) {
  const mots = platNom(q).split(' ').filter((m) => m && !VIDES.has(m) && !/^[0-9]+$/.test(m));
  return (label) => { const w = platNom(label).split(' '); return mots.every((m) => w.some((x) => x.startsWith(m) || (ABREGES[m] && x.startsWith(ABREGES[m])))); };
}

// --- service ---------------------------------------------------------------------
// build(id, urls) → Promise : prépare le statique (processus à part) ;
// readNet(id) → net.json relu du disque, ou null.
// build(id, urls, 'plan') prépare aussi les horaires (plan.json) ; readPlan(id)
// les relit ; walk(from, to) est le calculateur piéton (facultatif) et
// geocode(q, { partial, city }) le géocodeur d'adresses (facultatif).
export function createNetworks({ catalogue, build, readNet, readPlan = () => null, walk = null, geocode = null, fetcher = fetch, now = Date.now, maxLoaded = 4, maxPlans = 2 }) {
  const instances = new Map();

  async function instance(id) {
    let inst = instances.get(id);
    const entry = await catalogue.get(id);
    if (!entry) { instances.delete(id); return null; }
    if (!inst) {
      inst = { id, entry, ix: null, building: null, buildError: null, failedAt: 0, feeds: new Map(), used: 0, last: null, lastPos: new Map(), memoire: new Map(),
        planner: null, planBuilding: null, planError: null, planFailedAt: 0, planUsed: 0 };
      instances.set(id, inst);
    }
    inst.entry = entry;
    inst.used = now();
    ensureStatic(inst);
    return inst;
  }

  function ensureStatic(inst) {
    const fresh = () => inst.ix && now() - Date.parse(inst.ix.net.built_at) < STATIC_MAX_AGE_MS;
    if (fresh() || inst.building) return;
    if (!inst.ix) {
      try { const kept = readNet(inst.id); if (kept?.routes?.length) inst.ix = indexNet(kept); } catch { /* fichier abîmé : on reconstruit */ }
      if (fresh()) { trim(); return; }
    }
    if (now() - inst.failedAt < 30 * 60_000) return;
    const urls = inst.entry.gtfs.map((g) => g.url).filter((u) => publicUrl(u));
    if (!urls.length) return;
    inst.building = Promise.resolve().then(() => build(inst.id, urls))
      .then(() => { const net = readNet(inst.id); if (!net?.routes?.length) throw new Error('GTFS sans ligne'); inst.ix = indexNet(net); inst.buildError = null; trim(); })
      // Un échec est retenu une demi-heure ; une file pleine, une minute seulement.
      .catch((e) => { inst.buildError = String(e?.message || e); inst.failedAt = e?.code === 'OCCUPE' ? now() - 29 * 60_000 : now(); })
      .finally(() => { inst.building = null; });
  }
  // Seuls les derniers réseaux consultés gardent leur statique en mémoire.
  function trim() {
    const loaded = [...instances.values()].filter((i) => i.ix).sort((a, b) => b.used - a.used);
    for (const i of loaded.slice(maxLoaded)) i.ix = null;
  }

  async function feed(inst, res) {
    let c = inst.feeds.get(res.url);
    if (!c) inst.feeds.set(res.url, c = { at: 0, feed: null, kinds: null, error: null, wait: 0, min: FEED_MIN_MS, pending: null });
    if (c.pending) return c.pending;
    if (now() - c.at < Math.max(c.min, c.wait)) return c.feed;
    c.pending = (async () => {
      try {
        const r = await safeFetch(fetcher, res.url);
        // Certains relais n'acceptent qu'une lecture toutes les trente secondes :
        // on s'y tient désormais pour ce flux.
        if (r.status === 429) { c.min = 35_000; c.wait = 65_000; throw new Error('HTTP 429'); }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length > FEED_MAX_BYTES) throw new Error('flux trop gros');
        const f = buf.length ? decodeFeed(buf) : { header: {}, entity: [] };
        c.feed = f; c.kinds = feedKinds(f); c.error = null; c.wait = 0; c.okAt = now();
      } catch (e) {
        c.error = String(e?.message || e);
        // On garde l'ancien flux une minute et demie, le temps que la source
        // revienne ; et l'on attend un peu avant de la redemander.
        if (c.feed && now() - (c.okAt || 0) > 90_000) c.feed = null;
        c.wait = Math.max(c.wait, 40_000);
      } finally { c.at = now(); c.pending = null; }
      return c.feed;
    })();
    return c.pending;
  }
  // Flux contenant une nature de donnée. Le catalogue annonce des « features »,
  // parfois vides, parfois fausses : dès qu'un flux a été lu, c'est ce qu'il
  // contient qui compte.
  async function feedsOf(inst, kind) {
    const declared = { vehicle_positions: 'vehicle_positions', trip_updates: 'trip_updates' }[kind];
    const wanted = inst.entry.rt.filter((r) => {
      const c = inst.feeds.get(r.url);
      if (c?.kinds && (c.kinds.vehicle_positions || c.kinds.trip_updates || c.kinds.alerts)) return c.kinds[kind] > 0;
      return !r.features?.length || r.features.includes(declared);
    });
    const got = await Promise.all(wanted.map((r) => feed(inst, r).catch(() => null)));
    return got.filter((f) => f && feedKinds(f)[kind] > 0);
  }

  // « gps » : positions publiées ; « estime » : horaires temps réel seuls ;
  // « theorique » : aucun temps réel — ni véhicules ni passages en direct, mais
  // des horaires, donc des itinéraires.
  const natureDe = (e) => (e.positions ? 'gps' : e.horaires ? 'estime' : 'theorique');
  const brief = (inst) => ({
    id: inst.id, name: inst.entry.name, title: inst.entry.title, page: inst.entry.page, licence: inst.entry.licence,
    static: inst.ix ? 'ok' : inst.building ? 'preparation' : inst.buildError ? 'indisponible' : 'absent',
  });

  async function vehicles(id) {
    const inst = await instance(id);
    if (!inst) return null;
    const t = Math.floor(now() / 1000);
    if (!inst.entry.rt.length) return { network: brief(inst), nature: 'theorique', at: t, vehicles: [] };
    let list = vehiclesFromPositions(await feedsOf(inst, 'vehicle_positions'), inst.ix, t);
    let nature = 'gps';
    if (!list.length) {
      // Pas de position publiée (ou flux muet) : estimation depuis les horaires.
      if (inst.building && !inst.ix) await Promise.race([inst.building, new Promise((r) => setTimeout(r, 8000))]);
      const est = vehiclesFromTripUpdates(await feedsOf(inst, 'trip_updates'), inst.ix, t, inst.memoire);
      if (est.length || !inst.entry.positions) { list = est; nature = 'estime'; }
    }
    list = dedupe(list);
    // Cap manquant : déduit du déplacement depuis la lecture précédente.
    for (const v of list) {
      const old = inst.lastPos.get(v.id);
      if (v.bearing === null && old) v.bearing = distM(old.lat, old.lon, v.lat, v.lon) > 12 ? bearing(old.lat, old.lon, v.lat, v.lon) : old.bearing ?? null;
    }
    inst.lastPos = new Map(list.map((v) => [v.id, { lat: v.lat, lon: v.lon, bearing: v.bearing }]));
    inst.last = { at: t, list };
    const erreurs = [...inst.feeds.values()].filter((c) => c.error).length;
    return {
      network: brief(inst), nature, at: t,
      vehicles: list.map((v) => ({ ...v, lat: Math.round(v.lat * 1e5) / 1e5, lon: Math.round(v.lon * 1e5) / 1e5, age_s: v.ts ? Math.max(0, t - v.ts) : null })),
      ...(erreurs && !list.length ? { error: 'Le flux temps réel de ce réseau ne répond pas pour l\'instant.' } : {}),
    };
  }

  // Arrêts à venir d'un véhicule (sa course dans les horaires temps réel).
  async function vehicle(id, vid) {
    const inst = await instance(id);
    if (!inst) return null;
    const t = Math.floor(now() / 1000);
    const v = inst.last?.list.find((x) => x.id === vid) ?? null;
    if (!v) return { network: brief(inst), vehicle: null, stops: [] };
    const stops = [];
    for (const f of await feedsOf(inst, 'trip_updates')) {
      const e = (f.entity ?? []).find((x) => x.trip_update && ((v.trip_id && x.trip_update.trip?.trip_id === v.trip_id) || (!v.trip_id && String(x.trip_update.vehicle?.id) === vid)));
      if (!e) continue;
      for (const u of e.trip_update.stop_time_update ?? []) {
        const s = inst.ix?.stop(u.stop_id), time = stuTime(u, true);
        if (!time || time < t - 60 || u.schedule_relationship === 1) continue;
        const delay = Number(u.arrival?.delay ?? u.departure?.delay);
        stops.push({ name: s ? s[1] : String(u.stop_id), lat: s?.[2] ?? null, lon: s?.[3] ?? null, time, delay_s: Number.isFinite(delay) ? delay : null });
      }
      break;
    }
    const r = inst.ix && v.route_id != null ? inst.ix.route(v.route_id, v.trip_id) : null;
    return { network: brief(inst), at: t, vehicle: { ...v, age_s: v.ts ? Math.max(0, t - v.ts) : null }, stops: stops.slice(0, 40), shapes: r ? inst.ix.shapes(r) : [] };
  }

  async function stops(id, bbox, max = 400) {
    const inst = await instance(id);
    if (!inst) return null;
    if (!inst.ix) return { network: brief(inst), stops: [], total: 0 };
    const [s, w, n, e] = bbox;
    const inside = inst.ix.net.stops.filter((x) => !x[4] && x[2] >= s && x[2] <= n && x[3] >= w && x[3] <= e);
    return { network: brief(inst), total: inside.length, stops: inside.slice(0, max).map(([sid, name, lat, lon]) => ({ id: sid, name, lat, lon })) };
  }

  async function stop(id, stopId) {
    const inst = await instance(id);
    if (!inst) return null;
    const s = inst.ix?.stop(stopId) ?? null;
    if (!s) return { network: brief(inst), stop: null, departures: [] };
    const t = Math.floor(now() / 1000);
    // Les deux sens d'une ligne ont chacun leur quai : même nom, à deux pas.
    const ids = new Set(inst.ix.net.stops.filter((x) => x[1] === s[1] && Math.abs(x[2] - s[2]) < 0.002 && distM(x[2], x[3], s[2], s[3]) < 160).map((x) => x[0]));
    const feeds = await feedsOf(inst, 'trip_updates');
    let departures = departuresFromTripUpdates(feeds, inst.ix, ids, t);
    // Pas de passages en direct : les horaires publiés, s'ils sont déjà
    // préparés (on lance leur préparation pour la prochaine fois).
    let theoretical = false;
    if (!departures.length) {
      ensurePlan(inst);
      if (inst.planner) { departures = inst.planner.departures([...ids], t); theoretical = departures.length > 0; }
    }
    return {
      network: brief(inst), at: t,
      stop: { id: s[0], name: s[1], lat: s[2], lon: s[3], quais: ids.size },
      departures,
      realtime: feeds.length > 0 && !theoretical,
      ...(theoretical ? { theoretical: true } : {}),
    };
  }

  // Attend (un peu) que le statique soit prêt : un assistant pose UNE question,
  // il ne repassera pas dans cinq secondes comme la carte.
  async function ready(id, maxMs = 25_000) {
    const inst = await instance(id);
    if (!inst) return null;
    if (!inst.ix && inst.building) await Promise.race([inst.building, new Promise((r) => setTimeout(r, maxMs))]);
    return Boolean(inst.ix);
  }
  // Arrêts dont le nom répond à une saisie : le nom exact, puis ceux qui
  // commencent ainsi, puis ceux qui la contiennent. Un nom = une entrée (les
  // quais d'un même arrêt sont regroupés par « stop »).
  async function findStops(id, q, max = 5) {
    const inst = await instance(id);
    if (!inst?.ix) return [];
    const plat = (x) => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\bste\b/g, 'sainte').replace(/\bst\b/g, 'saint').trim();
    const voulu = plat(q);
    if (!voulu) return [];
    const mots = voulu.split(' ');
    const vus = new Map();
    for (const s of inst.ix.net.stops) {
      if (s[4]) continue;
      const n = plat(s[1]);
      const rang = n === voulu ? 0 : n.startsWith(voulu) ? 1 : mots.every((m) => n.split(' ').some((w) => w.startsWith(m))) ? 2 : -1;
      if (rang < 0) continue;
      const k = `${n}|${Math.round(s[2] * 200)}|${Math.round(s[3] * 200)}`;
      if (!vus.has(k)) vus.set(k, { rang, id: s[0], name: s[1], lat: s[2], lon: s[3], len: n.length });
    }
    return [...vus.values()].sort((a, b) => a.rang - b.rang || a.len - b.len).slice(0, max).map(({ rang: _r, len: _l, ...x }) => x);
  }

  // --- itinéraires -----------------------------------------------------------------
  // Les horaires d'un réseau ne sont préparés que si quelqu'un y cherche un
  // trajet (regarder les véhicules n'en a pas besoin), et seuls les derniers
  // réseaux consultés les gardent en mémoire.
  function ensurePlan(inst) {
    const frais = () => inst.planner && now() - Date.parse(inst.planner.built_at) < PLAN_MAX_AGE_MS;
    inst.planUsed = now();
    if (frais() || inst.planBuilding) return;
    if (!inst.planner) {
      try { const kept = readPlan(inst.id); if (kept?.routes?.length) inst.planner = createPlanner(kept, { walk, now }); } catch { /* fichier abîmé : on reconstruit */ }
      trimPlans();
      if (frais()) return;
    }
    if (now() - inst.planFailedAt < 30 * 60_000) return;
    const urls = inst.entry.gtfs.map((g) => g.url).filter((u) => publicUrl(u));
    if (!urls.length) return;
    inst.planBuilding = Promise.resolve().then(() => build(inst.id, urls, 'plan'))
      .then(() => { const plan = readPlan(inst.id); if (!plan?.routes?.length) throw new Error('horaires sans ligne en circulation'); inst.planner = createPlanner(plan, { walk, now }); inst.planError = null; trimPlans(); })
      .catch((e) => { inst.planError = String(e?.message || e); inst.planFailedAt = e?.code === 'OCCUPE' ? now() - 29 * 60_000 : now(); })
      .finally(() => { inst.planBuilding = null; });
  }
  function trimPlans() {
    const loaded = [...instances.values()].filter((i) => i.planner).sort((a, b) => b.planUsed - a.planUsed);
    for (const i of loaded.slice(maxPlans)) i.planner = null;
  }
  const planState = (inst) => ({
    network: brief(inst),
    state: inst.planner ? 'pret' : inst.planBuilding ? 'preparation' : inst.planError ? 'indisponible' : 'preparation',
    ...(inst.planner ? { until: inst.planner.until } : {}),
    ...(inst.planError && !inst.planner ? { error: 'Les horaires de ce réseau n\'ont pas pu être préparés.' } : {}),
  });
  // attendre : laisse à la préparation le temps de finir (un assistant ne repassera pas).
  async function plan(id, attendreMs = 0) {
    const inst = await instance(id);
    if (!inst) return null;
    ensurePlan(inst);
    if (!inst.planner && inst.planBuilding && attendreMs > 0) await Promise.race([inst.planBuilding, new Promise((r) => setTimeout(r, attendreMs).unref?.())]);
    return planState(inst);
  }

  // Suggestions pendant la saisie : stations du réseau, puis adresses et lieux
  // de la ville desservis par un arrêt.
  async function suggest(id, q, city = null) {
    const inst = await instance(id);
    if (!inst) return null;
    ensurePlan(inst);
    const p = inst.planner;
    if (!p) return { ...planState(inst), q, stops: [], places: [] };
    const stops = p.searchStops(q, 5).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, lines: s.lines.slice(0, 8) }));
    let places = [];
    if (geocode && q.length >= 3) {
      const repond = matcher(q);
      try {
        places = (await geocode(q, { partial: true, city }))
          .filter((l) => l.kind !== 'municipality' && repond(l.label) && p.stopsNear(l.lat, l.lon, 1500).length > 0)
          .slice(0, 5)
          .map((l) => ({ label: l.label, type: l.type, kind: l.kind, lat: Math.round(l.lat * 1e5) / 1e5, lon: Math.round(l.lon * 1e5) / 1e5 }));
      } catch { /* géocodeur injoignable : les arrêts suffisent */ }
    }
    return { ...planState(inst), q, stops, places };
  }

  // Un bout de trajet : { stop } (quai choisi), { lat, lon, label } ou { text }.
  async function endpoint(inst, e, city) {
    const p = inst.planner;
    if (e.stop) return p.station(e.stop) ?? { erreur: 'Arrêt inconnu de ce réseau.' };
    if (Number.isFinite(e.lat) && Number.isFinite(e.lon)) return { lat: e.lat, lon: e.lon, label: e.label || undefined };
    const text = String(e.text ?? '').trim();
    if (!text) return { erreur: 'Indiquez un départ et une arrivée.' };
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
    if (m && Math.abs(Number(m[1])) <= 90 && Math.abs(Number(m[2])) <= 180) return { lat: Number(m[1]), lon: Number(m[2]), label: text };
    // Une adresse (« 12 rue … ») n'est pas l'arrêt « Rue … ».
    const adresse = /^\d+\s*(bis|ter)?\s+\S/i.test(text);
    const s = adresse ? [] : p.searchStops(text, 3);
    if (s[0]?.exact) return { stop_ids: s[0].stop_ids, label: s[0].name };
    if (geocode) {
      const repond = matcher(text);
      try {
        const l = (await geocode(text, { city })).find((x) => x.kind !== 'municipality' && repond(x.label) && p.stopsNear(x.lat, x.lon, 1500).length > 0);
        if (l && (adresse || !s[0])) return { lat: l.lat, lon: l.lon, label: l.label };
        if (s[0]) return { stop_ids: s[0].stop_ids, label: s[0].name };
        if (l) return { lat: l.lat, lon: l.lon, label: l.label };
      } catch { /* géocodeur injoignable */ }
    }
    if (s[0]) return { stop_ids: s[0].stop_ids, label: s[0].name };
    return { erreur: `Lieu introuvable sur le réseau ${inst.entry.name} : « ${text} ». Essayez un nom d'arrêt, une adresse de la ville ou des coordonnées "lat,lon".` };
  }

  async function journey(id, { from, to, at = null, city = null, attendreMs = 0 }) {
    const inst = await instance(id);
    if (!inst) return null;
    ensurePlan(inst);
    if (!inst.planner && inst.planBuilding && attendreMs > 0) await Promise.race([inst.planBuilding, new Promise((r) => setTimeout(r, attendreMs).unref?.())]);
    const p = inst.planner;
    if (!p) return { ...planState(inst), error: inst.planError ? 'Les horaires de ce réseau n\'ont pas pu être préparés : pas d\'itinéraire pour l\'instant.' : 'Les horaires de ce réseau sont en cours de préparation (une minute, la première fois).', preparing: !inst.planError };
    const [f, t] = await Promise.all([endpoint(inst, from ?? {}, city), endpoint(inst, to ?? {}, city)]);
    if (f.erreur || t.erreur) return { network: brief(inst), error: [f.erreur, t.erreur].filter(Boolean).join(' '), missing: [f.erreur ? 'from' : null, t.erreur ? 'to' : null].filter(Boolean) };
    // Les horaires temps réel du réseau, quand il en publie : une course annoncée
    // remplace l'horaire théorique.
    const quand = Number.isFinite(at) && at > 0 ? Math.floor(at) : Math.floor(now() / 1000);
    // … pour un départ proche de maintenant seulement : le flux n'annonce que
    // l'heure qui vient. Sur un départ passé ou lointain, il ferait attendre la
    // première course annoncée au lieu de lire l'horaire.
    const proche = quand > now() / 1000 - 600 && quand < now() / 1000 + 3 * 3600;
    try { const tu = proche ? await feedsOf(inst, 'trip_updates') : []; p.setFeed(tu.length ? mergeFeeds(tu) : null); } catch { p.setFeed(null); }
    const out = await p.journey(f, t, quand);
    return { network: brief(inst), ...out, origin: { label: f.label ?? out.from?.name }, destination: { label: t.label ?? out.to?.name } };
  }

  async function forCity(cityId) {
    const list = await catalogue.forCity(cityId);
    return list.slice(0, 4).map((e) => ({ id: e.id, name: e.name, title: e.title, nature: natureDe(e), page: e.page, licence: e.licence }));
  }

  return { forCity, vehicles, vehicle, stops, stop, ready, findStops, plan, suggest, journey, _instances: instances };
}
