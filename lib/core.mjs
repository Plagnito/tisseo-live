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

// ---------------------------------------------------------------------------
// Position le long du tracé
// ---------------------------------------------------------------------------
// Interpoler entre deux arrêts en ligne droite donne un point à côté de la
// route dès que la rue serpente ou fait un angle : on collait ensuite le
// véhicule « au plus près » du tracé, ce qui peut le mettre sur une rue
// voisine — voire sur le mauvais sens d'une boucle. On marche donc le long
// de la polyligne, entre l'abscisse du stop de départ et celle du stop
// d'arrivée, proportionnellement à l'avancement dans le segment horaire.
//
// Ce qu'on indexe une fois par variante (et non par véhicule) :
//   pts : les points du tracé
//   cum : distance cumulée en mètres le long du tracé
//   ref : latitude de référence pour l'indexation
export function buildShapeIndex(shape) {
  if (!Array.isArray(shape) || shape.length < 2) return null;
  const pts = shape.map(([la, lo]) => [Number(la), Number(lo)]);
  const ref = pts[0][0];
  const kx = 111320 * Math.cos((ref * Math.PI) / 180);
  const ky = 110540;
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot((pts[i][1] - pts[i - 1][1]) * kx, (pts[i][0] - pts[i - 1][0]) * ky);
  }
  return { pts, cum, ref, kx, ky, total: cum[cum.length - 1] };
}

// Abscisse curviligne (en mètres depuis le début du tracé) du point du tracé
// le plus proche de (lat,lon). null si la forme est inutilisable.
export function projectOnShapeIndex(idx, lat, lon) {
  if (!idx) return null;
  const { pts, ref, kx, ky } = idx;
  const mlat = 111320 * Math.cos((ref * Math.PI) / 180);
  const px = lon * mlat, py = lat * 110540;
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][1] * kx, ay = pts[i][0] * ky;
    const bx = pts[i + 1][1] * kx, by = pts[i + 1][0] * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
    if (!best || d2 < best.d2) best = { d2, s: idx.cum[i] + Math.hypot(t * dx, t * dy) };
  }
  return best;
}

// Point du tracé situé à `s` mètres de son début.
export function pointAtDistance(idx, s) {
  const { pts, cum } = idx;
  if (s <= 0) return pts[0];
  if (s >= cum[cum.length - 1]) return pts[pts.length - 1];
  // cum est croissant : recherche dichotomique.
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const f = span > 0 ? (s - cum[lo]) / span : 0;
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
}

// Position d'un véhicule entre deux arrêts, le long du tracé.
// fromS / toS : abscisses curvilignes des deux arrêts sur ce tracé.
// Renvoie null quand on ne peut pas faire mieux que la ligne droite
// (arrêts non projetables, ou même abscisse : boucle ou tracé manquant).
export function positionAlongShape(idx, fromS, toS, f) {
  if (!idx || !Number.isFinite(fromS) || !Number.isFinite(toS)) return null;
  const span = toS - fromS;
  // Moins de 50 m d'écart : les deux arrêts se projettent au même endroit
  // (tracé manquant, boucle) — inutile d'inventer une position.
  if (Math.abs(span) < 50) return null;
  const s = fromS + span * Math.max(0, Math.min(1, f));
  const [lat, lon] = pointAtDistance(idx, s);
  return { lat, lon, s };
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

  // Index de tracé + abscisse de chaque arrêt, calculés UNE fois par variante.
  // C'est ce qui permet de placer le véhicule le long de la route plutôt qu'en
  // ligne droite entre deux arrêts (voir positionAlongShape).
  const shapeCache = new Map();
  function variantIndex(variant) {
    if (!variant) return null;
    const cached = shapeCache.get(variant);
    if (cached !== undefined) return cached;
    const idx = buildShapeIndex(variant.shape);
    const stopS = new Map();
    if (idx) {
      for (const id of variant.stops) {
        const p = stops[id];
        if (!p) continue;
        const proj = projectOnShapeIndex(idx, p.lat, p.lon);
        // Au-delà de 250 m du tracé, l'arrêt n'y est pas : on l'ignore
        // plutôt que de rattacher le véhicule au mauvais endroit.
        if (proj && proj.d2 < 250 * 250) stopS.set(id, proj.s);
      }
    }
    const value = idx && stopS.size >= 2 ? { idx, stopS } : null;
    shapeCache.set(variant, value);
    return value;
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

      let lat, lon, status, snapped = false, onRoute = false;
      let atStopId = null, fromId = null, toId = null, progress = 0, nextId = null, nextTime = null;
      // Index de tracé de la variante : c'est lui qui permet de marcher le
      // long de la route. Résolu une seule fois par trajet.
      const vIdx = variantIndex(matchVariant(trip.route_id, first.id, last.id));

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
            //On remplace la ligne droite par une marche le long du tracé de
            // la variante : le véhicule suit la rue, pas la corde.
            if (vIdx) {
              const fromS = vIdx.stopS.get(s.id);
              const toS = vIdx.stopS.get(nxt.id);
              const onPath = positionAlongShape(vIdx.idx, fromS, toS, f);
              if (onPath) { lat = onPath.lat; lon = onPath.lon; onRoute = true; }
            }
            placed = true;
            break;
          }
        }
        if (!placed) continue;
      }

      const variant = matchVariant(trip.route_id, first.id, last.id);
      if (variant && status === 'en_route' && !onRoute) {
        // Filet de sécurité : si le véhicule n'a pas pu être posé le long du
        // tracé (arrêts non projetables…), on le ramène au plus près de la
        // polyligne. `onRoute` = la position vient du tracé, pas d'un
        // rapprochement — le front affiche la mention « sur le tracé ».
        const s = snapToShape(lat, lon, variant.shape);
        if (s && s.d2 < 800 * 800) { lat = s.lat; lon = s.lon; snapped = true; }
      }

      // Tisséo publie parfois un TripUpdate sans route_id (vu sur le bus
      // « Lycée Toulouse-Lautrec », id TU:add:new_2789). Le véhicule est
      // pourtant réel : il a une position, un arrêt suivant et une
      // destination. On ne le jette pas — ce serait cacher un bus en
      // circulation — mais on ne laisse pas non plus une ligne vide partir
      // dans l'API : `line` vide faisait planter le tri de l'inventaire et
      // vidait le panneau entier d'un clic.
      const mode = modeOf(route);
      const routeId = trip.route_id || `sans-ligne-${mode.toLowerCase()}`;
      const lineLabel = route?.short_name || trip.route_id || 'sans ligne';

      const v = {
        id: tu.vehicle?.id ?? entity.id,
        route_id: routeId,
        line: lineLabel,
        route_unknown: route?.short_name ? undefined : true,
        mode,
        color: route?.color ?? '666666',
        text_color: route?.text_color ?? 'ffffff',
        destination: stopName(last.id),
        lat, lon,
        status,
        on_route: onRoute || undefined,
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
        // Heure de DÉPART en priorité : au terminus de départ, le bus arrive
        // puis stationne (La Vache, L10 : arrivée 07:47, départ 07:58).
        .map((s) => ({ id: s.stop_id, seq: s.stop_sequence ?? 0, t: s.departure?.time ?? s.arrival?.time ?? null }))
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

  // Variante d'une ligne pour un sens donné (celui du GTFS statique), avec son
  // index de tracé prêt à l'emploi. Sert aux véhicules théoriques (métro),
  // qui n'ont pas de trip RT pour décider du sens.
  function variantTrack(routeId, dir) {
    const list = variants[routeId];
    if (!list) return null;
    const wanted = String(dir);
    let v = list.find((x) => String(x.dir) === wanted);
    if (!v) {
      // Les sens ne sont pas toujours nommés pareil : on retombe sur celui
      // dont le terminus est le plus loin du premier arrêt du parcours.
      v = list[list.length - 1];
    }
    if (!v) return null;
    const built = variantIndex(v);
    return built ? { variant: v, ...built } : null;
  }

  return { routeById, modeOf, stopName, matchVariant, computeSnapshot, collectDepartures, searchStops, variantTrack };
}
