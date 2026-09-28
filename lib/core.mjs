// Cœur pur de Tisséo Live — aucune I/O, aucun réseau : testable tel quel.
// Tisséo ne publie pas de positions GPS : on interpole chaque véhicule entre
// les deux arrêts qui encadrent l'instant présent, puis on "snappe" le point
// sur le tracé réel de la ligne quand son sens est identifiable.
export const MODE_LABEL = { 0: 'Tram', 1: 'Métro', 3: 'Bus', 6: 'Téléo' };
export const GRACE_S = 120;

export const bearingDeg = (aLat, aLon, bLat, bLon) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLon = toRad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(toRad(bLat));
  const x =
    Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
    Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

export function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Projette (lat,lon) sur une polyligne [[lat,lon]…] (équirectangulaire local).
// Retourne { lat, lon, d2, seg, frac } où d2 est en m² (métriques locales).
export function snapToShape(lat, lon, shape) {
  if (!shape || shape.length < 2) return null;
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  const px = lon * kx, py = lat * ky;
  let best = null;
  for (let i = 0; i < shape.length - 1; i++) {
    const ax = shape[i][1] * kx, ay = shape[i][0] * ky;
    const bx = shape[i + 1][1] * kx, by = shape[i + 1][0] * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const d2 = (px - cx) ** 2 + (py - cy) ** 2;
    if (!best || d2 < best.d2) best = { d2, lat: cy / ky, lon: cx / kx, seg: i, frac: t };
  }
  return best;
}

// Normalisation pour la recherche : minuscules, sans accents, ponctuation
// remplacée par des espaces ("Jeanne d'Arc" -> "jeanne d arc").
const normText = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Un mot de requête "arce" matche le nom "arc" (et inversement) : évite
// d'exiger une frappe exacte pour "Jeanne d'Arc", "MEETT", etc. Le préfixe
// n'est toléré qu'à partir de 3 caractères, sinon "C.F.A." matcherait
// n'importe quoi ("m", "c"…).
const tokenMatch = (qTok, nTok) => {
  if (qTok === nTok) return true;
  const a = qTok.length <= nTok.length ? qTok : nTok;
  const b = qTok.length <= nTok.length ? nTok : qTok;
  return a.length >= 3 && b.startsWith(a);
};


// Index de recherche d'arrêts (nom normalisé -> ids).
function buildStopIndex(stops) {
  const byNorm = new Map();
  for (const [id, s] of Object.entries(stops)) {
    const key = normText(s.n);
    if (!byNorm.has(key)) byNorm.set(key, []);
    byNorm.get(key).push(id);
  }
  return byNorm;
}

export function createModel({ routes, stops, variants }) {
  const routeById = new Map(routes.map((r) => [r.route_id, r]));
  const modeOf = (route) => MODE_LABEL[route?.type] ?? 'Bus';
  const stopName = (id) => stops[id]?.n ?? id;
  const stopIndex = buildStopIndex(stops);
  // Arrêts effectivement desservis par au moins une variante (source de vérité
  // pour la recherche : certains stop_points partagent un nom mais n'ont aucun service).
  const served = new Set();
  for (const list of Object.values(variants ?? {})) {
    for (const v of list) for (const sid of v.stops) served.add(sid);
  }

  // Sens (variant) d'un trajet RT via son terminus, ou à défaut son départ.
  function matchVariant(routeId, firstStopId, lastStopId) {
    const list = variants[routeId];
    if (!list) return null;
    let v = list.find((x) => x.stops[x.stops.length - 1] === lastStopId);
    if (!v) v = list.find((x) => x.stops[0] === firstStopId);
    return v ?? null;
  }

  function computeSnapshot(rt) {
    const now = rt?.header?.timestamp ?? Math.floor(Date.now() / 1000);
    const vehicles = [];
    const alerts = [];
    const perRoute = {};

    for (const entity of rt?.entity ?? []) {
      if (entity.alert) {
        const a = entity.alert;
        const text = (t) => t?.translation?.[0]?.text ?? '';
        alerts.push({
          id: entity.id,
          title: text(a.header_text),
          description: text(a.description_text),
          url: text(a.url),
          severity: a.severity_level ?? 0,
          routes: (a.informed_entity ?? []).map((e) => e.route_id).filter(Boolean),
        });
        continue;
      }
      const tu = entity.trip_update;
      if (!tu) continue;
      const trip = tu.trip ?? {};
      const route = routeById.get(trip.route_id);
      const stus = (tu.stop_time_update ?? [])
        .map((s) => ({
          seq: s.stop_sequence ?? 0,
          id: s.stop_id,
          arr: s.arrival?.time ?? s.departure?.time ?? null,
          dep: s.departure?.time ?? s.arrival?.time ?? null,
        }))
        .filter((s) => s.arr != null && s.dep != null && stops[s.id])
        .sort((a, b) => a.seq - b.seq);
      if (stus.length === 0) continue;

      const first = stus[0];
      const last = stus[stus.length - 1];
      if (now < first.dep - GRACE_S || now > last.arr + GRACE_S) continue;

      let lat, lon, status, snapped = false;
      let atStopId = null, fromId = null, toId = null, progress = 0, nextId = null, nextTime = null;

      if (now <= first.dep) {
        const p = stops[first.id];
        lat = p.lat; lon = p.lon;
        status = now < first.arr ? 'not_started' : 'at_stop';
        atStopId = first.id; nextId = first.id; nextTime = first.dep;
      } else if (now >= last.arr) {
        const p = stops[last.id];
        lat = p.lat; lon = p.lon;
        status = 'terminus';
        atStopId = last.id;
      } else {
        let placed = false;
        for (let i = 0; i < stus.length; i++) {
          const s = stus[i];
          if (now >= s.arr && now <= s.dep) {
            const p = stops[s.id];
            lat = p.lat; lon = p.lon;
            status = 'at_stop';
            atStopId = s.id;
            nextId = stus[Math.min(i + 1, stus.length - 1)].id;
            nextTime = stus[Math.min(i + 1, stus.length - 1)].arr;
            progress = i / Math.max(stus.length - 1, 1);
            placed = true;
            break;
          }
          const nxt = stus[i + 1];
          if (nxt && now > s.dep && now < nxt.arr) {
            const A = stops[s.id];
            const B = stops[nxt.id];
            const span = Math.max(nxt.arr - s.dep, 1);
            const f = Math.min(Math.max((now - s.dep) / span, 0), 1);
            lat = A.lat + (B.lat - A.lat) * f;
            lon = A.lon + (B.lon - A.lon) * f;
            status = 'en_route';
            fromId = s.id; toId = nxt.id;
            nextId = nxt.id; nextTime = nxt.arr;
            progress = (i + f) / Math.max(stus.length - 1, 1);
            placed = true;
            break;
          }
        }
        if (!placed) continue;
      }

      const variant = matchVariant(trip.route_id, first.id, last.id);
      if (variant && status === 'en_route') {
        const s = snapToShape(lat, lon, variant.shape);
        // garde-fou : au-delà de 800 m du tracé, on garde l'estimation brute
        if (s && s.d2 < 800 * 800) { lat = s.lat; lon = s.lon; snapped = true; }
      }

      const v = {
        id: tu.vehicle?.id ?? entity.id,
        route_id: trip.route_id,
        line: route?.short_name ?? trip.route_id,
        mode: modeOf(route),
        color: route?.color ?? '666666',
        text_color: route?.text_color ?? 'ffffff',
        destination: stopName(last.id),
        lat, lon,
        status,
        snapped: snapped || undefined,
        at_stop: atStopId ? stopName(atStopId) : null,
        at_stop_id: atStopId,
        from: fromId ? stopName(fromId) : null,
        to: toId ? stopName(toId) : null,
        next_stop: nextId ? stopName(nextId) : null,
        next_stop_id: nextId,
        next_time: nextTime,
        progress: Math.round(progress * 1000) / 1000,
        bearing:
          fromId && toId
            ? Math.round(bearingDeg(stops[fromId].lat, stops[fromId].lon, stops[toId].lat, stops[toId].lon))
            : null,
        // arrêts restants desservis (depuis l'arrêt courant), pour la fiche enrichie
        remaining: remainingStops(stus, now, last),
      };
      vehicles.push(v);
      if (trip.route_id) perRoute[trip.route_id] = (perRoute[trip.route_id] ?? 0) + 1;
    }

    return { rt_timestamp: now, vehicles, alerts, perRoute };
  }

  // Liste des arrêts à venir d'un trajet (après maintenant), avec horaires.
  function remainingStops(stus, now, last) {
    const out = [];
    for (const s of stus) {
      if (s.arr < now - 30) continue;
      out.push({ id: s.id, name: stopName(s.id), time: s.arr, last: s.id === last.id });
      if (out.length >= 12) break;
    }
    return out;
  }

  // Prochains passages par arrêt, dérivés du même flux RT.
  function collectDepartures(rt, now) {
    const byStop = new Map();
    for (const entity of rt?.entity ?? []) {
      const tu = entity.trip_update;
      if (!tu) continue;
      const stus = (tu.stop_time_update ?? [])
        .map((s) => ({ id: s.stop_id, seq: s.stop_sequence ?? 0, t: s.arrival?.time ?? s.departure?.time ?? null }))
        .filter((s) => s.t != null && s.t >= now - 30 && stops[s.id])
        .sort((a, b) => a.t - b.t);
      if (!stus.length) continue;
      const dest = stopName(stus[stus.length - 1].id);
      const route = routeById.get(tu.trip?.route_id);
      for (const s of stus) {
        if (!byStop.has(s.id)) byStop.set(s.id, []);
        byStop.get(s.id).push({
          route_id: tu.trip?.route_id,
          trip_id: tu.trip?.trip_id ?? null,
          line: route?.short_name ?? tu.trip?.route_id,
          color: route?.color ?? '666666',
          text_color: route?.text_color ?? 'ffffff',
          mode: modeOf(route),
          destination: dest,
          time: s.t,
          seq: s.seq,
          vehicle: tu.vehicle?.id ?? null,
          source: 'rt',
        });
      }
    }
    for (const list of byStop.values()) {
      list.sort((a, b) => a.time - b.time);
      if (list.length > 20) list.length = 20;
    }
    return byStop;
  }

  // Recherche d'arrêts par nom : exact > préfixe > tokens dans l'ordre >
  // tous les tokens présents. Résultats dédupliqués par nom d'arrêt
  // (un même arrêt a souvent plusieurs stop_points : quai, direction…).
  function searchStops(q, n = 10) {
    const key = normText(q).trim();
    if (!key) return [];
    const tokens = key.split(/\s+/).filter(Boolean);
    const ordered = (name) => {
      const nt = name.split(/\s+/).filter(Boolean);
      let i = 0;
      for (const t of tokens) {
        let found = -1;
        for (let k = i; k < nt.length; k++) {
          if (tokenMatch(t, nt[k])) { found = k; break; }
        }
        if (found < 0) return false;
        i = found + 1;
      }
      return true;
    };
    const groups = [];
    for (const [name, ids] of stopIndex) {
      let score = -1;
      if (name === key) score = 0;
      else if (name.startsWith(key)) score = 1;
      else if (ordered(name)) score = 2;
      else if (tokens.every((t) => name.split(/\s+/).some((n) => tokenMatch(t, n)))) score = 3;
      if (score >= 0) groups.push({ score, name, ids });
    }
    groups.sort((a, b) => a.score - b.score || a.ids.length - b.ids.length || a.name.localeCompare(b.name));

    const out = [];
    const seenNames = new Set();
    // Représentant d'un nom : d'abord un arrêt qui a un service (variante),
    // puis un stop_point plutôt qu'un stop_area (plus précis côté horaires).
    const rank = (id) => (served.has(id) ? 8 : 0) + (id.startsWith('stop_point:') ? 2 : 1);
    for (const g of groups) {
      if (seenNames.has(g.name)) continue;
      seenNames.add(g.name);
      const id = [...g.ids].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))[0];
      out.push({
        id,
        name: stops[id].n,
        lat: stops[id].lat,
        lon: stops[id].lon,
        kind: id.startsWith('stop_point:') ? 'point' : 'area',
        served: served.has(id),
      });
      if (out.length >= n) break;
    }
    return out;
  }

  return { routeById, modeOf, stopName, matchVariant, computeSnapshot, collectDepartures, searchStops };
}
