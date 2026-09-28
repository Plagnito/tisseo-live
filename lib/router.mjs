// Routage Tisséo Live — calcul d'itinéraire A→B sur le réseau.
//
// Méthode : Dijkstra sur des états (arrêt, ligne). Les durées entre deux
// arrêts d'une même ligne sont estimées depuis la distance le long du
// tracé (shape) à la vitesse moyenne du mode + temps d'arrêt. La
// signalétique temps réel (GTFS-RT) est ensuite appliquée à chaque
// segment quand un trip actif couvre bien les deux arrêts.
//
// Sources : data/route_variants.json (sens, arrêts, tracé) + flux RT.
import { snapToShape, haversineM, MODE_LABEL } from './core.mjs';

const SPEED = { 0: 5.8, 1: 10.5, 3: 4.4, 6: 7.5 }; // vitesse utile (m/s)
const DWELL_S = 15;         // ouverture de porte par arrêt intermédiaire
const TRANSFER_S = 120;     // pénalité de correspondance
const WALK_M_S = 1.25;      // 4,5 km/h
const MAX_WALK_M = 500;     // rayon de marche entre deux arrêts
const SEARCH_RADIUS_M = 1200; // rayon d'accroche départ/arrivée
const MAX_STATES = 400_000; // garde-fou de calcul
const MAX_WAIT_S = 45 * 60; // au-delà, l'horaire théorique n'est pas crédible

// File de priorité (binary heap) — indispensable sur ~20k états.
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].s <= a[i].s) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].s < a[m].s) m = l;
        if (r < a.length && a[r].s < a[m].s) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

export function createRouter({ stops, variants, routes }) {
  const routeById = new Map(routes.map((r) => [r.route_id, r]));
  const speedOf = (route) => SPEED[Number(route?.type)] ?? 4.4;

  // --- précalcul : distance cumulée et durée cumulée par variante ----
  const variantsCalc = new Map();
  for (const [routeId, list] of Object.entries(variants)) {
    const sp = speedOf(routeById.get(routeId));
    variantsCalc.set(routeId, list.map((v) => {
      const shape = v.shape ?? [];
      const cum = [];
      let prev = 0;
      for (const id of v.stops) {
        const s = stops[id];
        let d = prev;
        if (s && shape.length >= 2) {
          const p = snapToShape(s.lat, s.lon, shape);
          if (p) {
            const along = pathDistance(shape, p.seg, p.frac);
            if (along >= prev) d = along; // le sens de parcours est monotone
          }
        }
        cum.push(d); prev = d;
      }
      const times = v.stops.map((_, i) => cum[i] / sp + i * DWELL_S);
      return { ...v, cum, times };
    }));
  }

  function pathDistance(shape, segIdx, frac) {
    let d = 0;
    for (let i = 0; i < segIdx; i++) d += haversineM(shape[i][0], shape[i][1], shape[i + 1][0], shape[i + 1][1]);
    const a = shape[segIdx], b = shape[segIdx + 1];
    if (a && b) d += frac * haversineM(a[0], a[1], b[0], b[1]);
    return d;
  }

  // --- index : arrêt -> lignes/sens le desservant --------------------
  const serving = new Map();
  for (const [routeId, list] of Object.entries(variants)) {
    for (const v of list) {
      v.stops.forEach((sid, k) => {
        if (!serving.has(sid)) serving.set(sid, []);
        serving.get(sid).push({ routeId, dir: v.dir, k });
      });
    }
  }

  // --- voisinage de marche (grille ~1,1 km, calculé une fois) ---------
  const walkAdj = new Map(); // id -> [{ id, dist }]
  {
    const cell = 0.01;
    const grid = new Map();
    for (const sid of serving.keys()) {
      const s = stops[sid];
      if (!s) continue;
      const k = `${Math.floor(s.lat / cell)}|${Math.floor(s.lon / cell)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(sid);
    }
    for (const sid of serving.keys()) {
      const s = stops[sid];
      if (!s) continue;
      const cl = Math.floor(s.lat / cell), co = Math.floor(s.lon / cell);
      const out = [];
      for (let dl = -1; dl <= 1; dl++) for (let dobj = -1; dobj <= 1; dobj++) {
        for (const oid of grid.get(`${cl + dl}|${co + dobj}`) ?? []) {
          if (oid === sid) continue;
          const o = stops[oid];
          if (!o) continue;
          const d = haversineM(s.lat, s.lon, o.lat, o.lon);
          if (d <= MAX_WALK_M) out.push({ id: oid, dist: Math.round(d) });
        }
      }
      out.sort((a, b) => a.dist - b.dist);
      if (out.length > 40) out.length = 40;
      walkAdj.set(sid, out);
    }
  }

  // --- recherche de trip RT couvrant un segment board -> alight -------
  function findVariant(routeId, boardId, alightId) {
    const list = variants[routeId];
    if (!list) return null;
    const v = list.find((x) => {
      const i = x.stops.indexOf(boardId), j = x.stops.indexOf(alightId);
      return i >= 0 && j > i;
    });
    return v ? { first: v.stops[0], last: v.stops[v.stops.length - 1] } : null;
  }

  function rtLeg(rt, routeId, boardId, alightId, notBefore) {
    if (!rt) return null;
    const dir = findVariant(routeId, boardId, alightId);
    let best = null; // on veut le départ le plus proche après notBefore,
    // pas le premier trip croisé (l'ordre des entities est arbitraire)
    for (const e of rt.entity ?? []) {
      const tu = e.trip_update;
      if (!tu || tu.trip?.route_id !== routeId) continue;
      const stus = (tu.stop_time_update ?? [])
        .map((s) => ({ id: s.stop_id, seq: s.stop_sequence ?? 0, t: s.arrival?.time ?? s.departure?.time ?? null, d: s.departure?.time ?? s.arrival?.time ?? null }))
        .filter((s) => s.t != null)
        .sort((a, b) => a.seq - b.seq);
      const i = stus.findIndex((s) => s.id === boardId);
      const j = stus.findIndex((s) => s.id === alightId);
      if (i < 0 || j <= i) continue;
      if (stus[i].d < notBefore - 15) continue; // départ déjà passé
      if (dir) {
        const di = stus.findIndex((s) => s.id === dir.first);
        const dj = stus.findIndex((s) => s.id === dir.last);
        if (di >= 0 && dj >= 0 && dj < di) continue; // mauvais sens
      }
      if (!best || stus[i].d < best.board_t) {
        best = { trip_id: tu.trip?.trip_id ?? null, board_t: stus[i].d, alight_t: stus[j].t, real: true };
      }
    }
    return best;
  }

  function estLeg(routeId, boardId, alightId) {
    const calc = variantsCalc.get(routeId);
    if (!calc) return null;
    const v = calc.find((x) => {
      const i = x.stops.indexOf(boardId), j = x.stops.indexOf(alightId);
      return i >= 0 && j > i;
    });
    if (!v) return null;
    const i = v.stops.indexOf(boardId), j = v.stops.indexOf(alightId);
    return Math.max(Math.round(v.times[j] - v.times[i]), 30);
  }

  // --- Dijkstra --------------------------------------------------------
  // excluded : lignes à ne pas emprunter (hors service à l'heure demandée).
  function route(fromStop, toStop, excluded = null) {
    const dist = new Map();
    const prev = new Map();
    const heap = new Heap();
    const seen = new Set();
    const key = (stopId, line) => `${stopId}|${line}`;
    const relax = (k, seconds, node) => {
      const cur = dist.get(k);
      if (cur !== undefined && cur <= seconds) return false;
      dist.set(k, seconds);
      prev.set(k, node);
      heap.push({ k, s: seconds });
      return true;
    };

    relax(key(fromStop, '*'), 0, null);
    let explored = 0;

    while (heap.size) {
      const cur = heap.pop();
      if (seen.has(cur.k)) continue;
      seen.add(cur.k);
      if (++explored > MAX_STATES) return null;
      if (cur.k === key(toStop, '*') || cur.k.startsWith(`${toStop}|`)) return buildPath(prev, cur.k);

      const [sid, line] = cur.k.split('|');

      // marche vers un arrêt voisin (débarquement = correspondance payée)
      const walkPenalty = line === '*' ? 0 : TRANSFER_S;
      for (const w of walkAdj.get(sid) ?? []) {
        relax(key(w.id, '*'), cur.s + walkPenalty + w.dist / WALK_M_S,
          { key: cur.k, kind: 'walk', from: sid, to: w.id, seconds: Math.round(w.dist / WALK_M_S), penalty: walkPenalty });
      }

      for (const { routeId } of serving.get(sid) ?? []) {
        if (excluded?.has(routeId)) continue;
        const boardPenalty = line !== '*' && line !== routeId ? TRANSFER_S : 0;
        const wait = line !== routeId ? waitOf(routeId) : 0; // attente d'un nouveau véhicule
        for (const v of variantsCalc.get(routeId) ?? []) {
          const i = v.stops.indexOf(sid);
          if (i < 0) continue;
          for (let j = i + 1; j < v.stops.length; j++) {
            const secs = v.times[j] - v.times[i];
            relax(key(v.stops[j], routeId), cur.s + boardPenalty + wait + secs,
              { key: cur.k, kind: 'ride', routeId, board: sid, alight: v.stops[j], seconds: Math.round(secs), penalty: boardPenalty + wait });
          }
        }
      }
    }
    return null;
  }

  function buildPath(prev, endKey) {
    const steps = [];
    let k = endKey;
    while (prev.has(k)) {
      const n = prev.get(k);
      if (n) steps.push(n);
      k = n?.key;
      if (!k) break;
    }
    steps.reverse();
    return steps;
  }

  // --- API publique -----------------------------------------------------
  let rtCtx = null;
  // Fréquence par ligne (médiane des écarts de départ), pour pondérer le
  // temps d'attente théorique dans la recherche (sinon un chemin avec un
  // bus toutes les 30 min est préféré à un tram toutes les 6 min).
  const headway = new Map();
  const waitOf = (routeId) => {
    const h = headway.get(routeId);
    return h ? Math.min(Math.max(Math.round(h / 2), 60), 900) : 240;
  };
  const setFeed = (rt) => {
    rtCtx = rt;
    const perRoute = new Map(); // routeId -> firstStop -> [t]
    for (const e of rt?.entity ?? []) {
      const tu = e.trip_update;
      const routeId = tu?.trip?.route_id;
      if (!routeId) continue;
      const stus = (tu.stop_time_update ?? [])
        .filter((s) => (s.departure?.time ?? s.arrival?.time) != null)
        .sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0));
      if (!stus.length) continue;
      const first = stus[0];
      const t = first.departure?.time ?? first.arrival?.time;
      if (!perRoute.has(routeId)) perRoute.set(routeId, new Map());
      const m = perRoute.get(routeId);
      if (!m.has(first.stop_id)) m.set(first.stop_id, []);
      m.get(first.stop_id).push(t);
    }
    for (const [routeId, m] of perRoute) {
      const gaps = [];
      for (const times of m.values()) {
        times.sort((a, b) => a - b);
        for (let i = 1; i < times.length; i++) {
          const g = times[i] - times[i - 1];
          if (g > 60 && g < 3600) gaps.push(g);
        }
      }
      if (gaps.length) {
        gaps.sort((a, b) => a - b);
        headway.set(routeId, gaps[Math.floor(gaps.length / 2)]);
      }
    }
  };

  // Arrêts "montables" (stop_points desservis) dans un rayon donné.
  function stopsNear(lat, lon, radiusM = 150) {
    const out = [];
    for (const sid of serving.keys()) {
      const s = stops[sid];
      if (!s) continue;
      const d = haversineM(lat, lon, s.lat, s.lon);
      if (d <= radiusM) out.push({ id: sid, dist: d });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  function resolveEndpoint(p) {
    if (!p) return null;
    if (p.stop_id) {
      const s = stops[p.stop_id];
      if (!s) return null;
      return { stop_id: p.stop_id, label: s.n };
    }
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
      // coller au stop_point le plus proche quand on est déjà dessus :
      // évite un faux "marchage" de 4 s au début/à la fin du trajet.
      const near = stopsNear(p.lat, p.lon, 80)[0];
      if (near) return { stop_id: near.id, label: stops[near.id].n };
      return { lat: p.lat, lon: p.lon, label: p.label };
    }
    return null;
  }

  function nearestStop(lat, lon) {
    const best = stopsNear(lat, lon, SEARCH_RADIUS_M)[0];
    return best ? best.id : null;
  }

  const stopLabel = (id) => stops[id]?.n ?? id;

  // Fusionne les segments consécutifs de même nature : une seule montée
  // par ligne (au lieu d'un segment par arrêt) et une seule marche.
  function mergeSteps(steps) {
    const out = [];
    for (const s of steps) {
      const last = out[out.length - 1];
      if (last && s.kind === 'ride' && last.kind === 'ride'
        && last.routeId === s.routeId && last.alight === s.board) {
        last.alight = s.alight;
        last.seconds += s.seconds;
        continue;
      }
      if (last && s.kind === 'walk' && last.kind === 'walk') {
        last.to = s.to;
        last.seconds += s.seconds;
        continue;
      }
      out.push({ ...s });
    }
    return out;
  }

  // opts.nextDeparture(routeId, boardStop, alightStop, t) → epoch du prochain
  // départ théorique ≥ t (facultatif : sans lui, départ immédiat estimé).
  function journey(from, to, at = Math.floor(Date.now() / 1000), opts = {}) {
    const f = resolveEndpoint(from);
    const t = resolveEndpoint(to);
    if (!f || !t) return { error: 'Point de départ ou d’arrivée introuvable' };

    const fromStop = f.stop_id ?? nearestStop(f.lat, f.lon);
    const toStop = t.stop_id ?? nearestStop(t.lat, t.lon);
    if (!fromStop || !toStop) return { error: 'Aucun arrêt accessible à proximité' };
    if (fromStop === toStop) return { error: 'Départ et arrivée sur le même arrêt' };

    // Lignes qui ne roulent pas à l'heure du départ : écartées de la
    // recherche. Si plus rien ne passe (nuit), on retombe sur le réseau
    // entier plutôt que de ne rien proposer — et on le signale.
    // opts.exclude : lignes que l'utilisateur veut éviter — toujours respecté,
    // y compris dans le repli (on ne lui impose jamais une ligne refusée).
    const avoid = opts.exclude?.size ? opts.exclude : null;
    let excluded = avoid ? new Set(avoid) : null;
    if (opts.inService) {
      excluded ??= new Set();
      for (const routeId of variantsCalc.keys()) if (opts.inService(routeId, at) === false) excluded.add(routeId);
      if (!excluded.size) excluded = null;
    }
    let steps = mergeSteps(route(fromStop, toStop, excluded) ?? []);
    let outOfService = false;
    if (!steps.length && excluded && excluded !== avoid) {
      steps = mergeSteps(route(fromStop, toStop, avoid) ?? []);
      outOfService = steps.length > 0;
    }
    if (!steps.length) return { error: 'Aucun itinéraire trouvé (essayez un point plus proche du réseau)' };

    const legs = [];
    let clock = at;
    const walkIn = f.stop_id ? 0 : Math.round(haversineM(f.lat, f.lon, stops[fromStop].lat, stops[fromStop].lon) / WALK_M_S);
    if (walkIn > 0) legs.push({ type: 'walk', seconds: walkIn, from: f.label ?? 'Départ', to: stopLabel(fromStop) });
    clock += walkIn;

    let realCount = 0, estCount = 0;
    for (const s of steps) {
      if (s.kind === 'walk') {
        legs.push({ type: 'walk', seconds: s.seconds, from: stopLabel(s.from), to: stopLabel(s.to) });
        clock += s.seconds;
        continue;
      }
      const est = estLeg(s.routeId, s.board, s.alight);
      const rt = rtLeg(rtCtx, s.routeId, s.board, s.alight, clock);
      const r = routeById.get(s.routeId);
      const leg = {
        type: 'ride',
        route_id: s.routeId,
        line: r?.short_name ?? s.routeId,
        mode: MODE_LABEL[r?.type] ?? 'Bus',
        color: r?.color ?? '666666',
        text_color: r?.text_color ?? 'ffffff',
        from: stopLabel(s.board),
        from_id: s.board,
        to: stopLabel(s.alight),
        to_id: s.alight,
        transfer_s: s.penalty || 0,
      };
      if (rt) {
        leg.depart = rt.board_t; leg.arrive = rt.alight_t; leg.real = true;
        clock = rt.alight_t;
        realCount++;
      } else {
        const dur = est ?? s.seconds;
        // Sans temps réel, on attend le prochain passage THÉORIQUE s'il est
        // connu (métro, creux du flux) ; sinon départ immédiat, durée seule.
        const next = opts.nextDeparture?.(s.routeId, s.board, s.alight, clock);
        if (Number.isFinite(next) && next >= clock && next - clock <= MAX_WAIT_S) {
          clock = next;
          leg.scheduled = true;
        }
        leg.depart = clock; leg.arrive = clock + dur; leg.real = false;
        clock += dur;
        estCount++;
      }
      leg.seconds = Math.max(leg.arrive - leg.depart, 1);
      legs.push(leg);
    }

    const walkOut = t.stop_id ? 0 : Math.round(haversineM(t.lat, t.lon, stops[toStop].lat, stops[toStop].lon) / WALK_M_S);
    if (walkOut > 0) legs.push({ type: 'walk', seconds: walkOut, from: stopLabel(toStop), to: t.label ?? 'Arrivée' });
    clock += walkOut;

    const rides = legs.filter((l) => l.type === 'ride');
    return {
      depart_at: at,
      arrive_at: clock,
      duration_s: clock - at,
      transfers: Math.max(rides.length - 1, 0),
      legs,
      from: { stop_id: fromStop, name: stops[fromStop].n },
      to: { stop_id: toStop, name: stops[toStop].n },
      real: rides.length > 0 && realCount === rides.length,
      estimates: estCount,
      ...(outOfService ? { out_of_service: true } : {}),
    };
  }

  // Tous les arrêts atteignables depuis fromStop en moins de maxS secondes
  // (marche + lignes, correspondances et attentes moyennes comprises) :
  // stop_id -> { s, routes } où routes = lignes empruntées pour y arriver.
  function reach(fromStop, maxS, excluded = null) {
    const dist = new Map();
    const via = new Map();
    const heap = new Heap();
    const seen = new Set();
    const best = new Map(); // stop -> { s, routes }
    const key = (stopId, line) => `${stopId}|${line}`;
    const relax = (k, seconds, used) => {
      if (seconds > maxS) return;
      const cur = dist.get(k);
      if (cur !== undefined && cur <= seconds) return;
      dist.set(k, seconds);
      via.set(k, used);
      heap.push({ k, s: seconds });
    };
    relax(key(fromStop, '*'), 0, []);
    let explored = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (seen.has(cur.k)) continue;
      seen.add(cur.k);
      if (++explored > MAX_STATES) break;
      const [sid, line] = cur.k.split('|');
      const used = via.get(cur.k);
      const b = best.get(sid);
      if (!b || cur.s < b.s) best.set(sid, { s: Math.round(cur.s), routes: used });
      const walkPenalty = line === '*' ? 0 : TRANSFER_S;
      for (const w of walkAdj.get(sid) ?? []) relax(key(w.id, '*'), cur.s + walkPenalty + w.dist / WALK_M_S, used);
      for (const { routeId } of serving.get(sid) ?? []) {
        if (excluded?.has(routeId)) continue;
        const boardPenalty = line !== '*' && line !== routeId ? TRANSFER_S : 0;
        const wait = line !== routeId ? waitOf(routeId) : 0;
        const nextUsed = used[used.length - 1] === routeId ? used : [...used, routeId];
        for (const v of variantsCalc.get(routeId) ?? []) {
          const i = v.stops.indexOf(sid);
          if (i < 0) continue;
          for (let j = i + 1; j < v.stops.length; j++) {
            relax(key(v.stops[j], routeId), cur.s + boardPenalty + wait + v.times[j] - v.times[i], nextUsed);
          }
        }
      }
    }
    return best;
  }

  return { journey, setFeed, stopsNear, reach, nearestStop };
}
