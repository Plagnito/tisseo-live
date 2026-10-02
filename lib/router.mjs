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
import { normDelay } from './realtime.mjs';

const SPEED = { 0: 5.8, 1: 10.5, 3: 4.4, 6: 7.5 }; // vitesse utile (m/s)
const DWELL_S = 15;         // ouverture de porte par arrêt intermédiaire
const TRANSFER_S = 120;     // pénalité de correspondance
const WALK_M_S = 1.25;      // 4,5 km/h
const MAX_WALK_M = 500;     // rayon de marche entre deux arrêts
const SEARCH_RADIUS_M = 1200; // rayon d'accroche départ/arrivée
// Départ ou arrivée à une adresse : on ne s'accroche plus au SEUL arrêt le plus
// proche (un petit arrêt de bus à 100 m cachait la station de métro à 400 m).
// Tous les arrêts à portée de marche partent en même temps, chacun avec son
// temps d'accès, et le calcul choisit.
const ACCESS_RADIUS_M = 700;
const ACCESS_MAX = 14;
// À pied on ne va pas à vol d'oiseau : la distance par les rues vaut en ville
// environ 1,3 fois la distance en ligne droite.
const DETOUR = 1.3;
// En dessous, on compare toujours avec la marche directe de porte à porte.
const DIRECT_WALK_MAX_M = 2500;
const END = '\u0000fin|*';
const MAX_STATES = 400_000; // garde-fou de calcul
const MAX_WAIT_S = 45 * 60; // au-delà, l'attente est signalée comme longue
const NO_DEP_RETRIES = 3;   // lignes sans départ écartées avant d'abandonner

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

  // --- composantes connexes du graphe des lignes -------------------------
  // Le GTFS de Tisséo ne relie pas tout au tout : on le mesure pour pouvoir
  // expliquer « aucun itinéraire » quand ce n'est pas une panne mais deux
  // zones que rien ne relie.
  const composantDe = new Map(); // stopId -> entier de composante
  {
    const voisins = new Map();
    const relier = (a, b) => {
      if (!voisins.has(a)) voisins.set(a, new Set());
      voisins.get(a).add(b);
      if (!voisins.has(b)) voisins.set(b, new Set());
      voisins.get(b).add(a);
    };
    for (const list of Object.values(variants)) {
      for (const v of list) {
        for (let i = 1; i < v.stops.length; i++) relier(v.stops[i - 1], v.stops[i]);
      }
    }
    let num = 0;
    for (const depart of voisins.keys()) {
      if (composantDe.has(depart)) continue;
      const file = [depart];
      composantDe.set(depart, num);
      while (file.length) {
        const x = file.pop();
        for (const y of voisins.get(x) ?? []) {
          if (composantDe.has(y)) continue;
          composantDe.set(y, num);
          file.push(y);
        }
      }
      num++;
    }
  }
  const composant = (stopIds) => {
    for (const id of stopIds ?? []) if (composantDe.has(id)) return composantDe.get(id);
    return null;
  };

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
        .map((s) => ({
          id: s.stop_id, seq: s.stop_sequence ?? 0, t: s.arrival?.time ?? s.departure?.time ?? null, d: s.departure?.time ?? s.arrival?.time ?? null,
          delay: normDelay(s.departure?.delay ?? s.arrival?.delay),
        }))
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
        best = {
          trip_id: tu.trip?.trip_id ?? null, vehicle: tu.vehicle?.id ?? null, board_t: stus[i].d, alight_t: stus[j].t, real: true,
          delay: stus[i].delay, alight_delay: stus[j].delay, ts: Number(tu.timestamp) || null,
        };
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
  // fromStops / toStops accepte un OU PLUSIEURS arrêts : une station n'a pas
  // un seul stop_point. Sur le métro de Toulouse, les deux sens d'une ligne
  // n'emploient pas le même identifiant pour la même station, et la recherche
  // ne relie que les arrêts d'une même variante. En ne partant que du quai
  // « sens Basso-Cambo » de Capitole, aucun trajet vers « Jean Jaurès » n'était
  // possible alors que les deux stations sont à 300 m et desservies par la
  // même ligne. Tous les quais de la station partent en même temps.
  // blocked : vue des perturbations à l'heure du trajet (lib/perturbations.mjs).
  //   stopClosed(ligne, quai) : on n'y monte pas et on n'y descend pas ;
  //   cut(ligne, quai)        : la ligne n'y passe plus du tout — on ne le
  //                             traverse pas (tram coupé sur un tronçon).
  // Une déviation ferme des arrêts mais le bus continue : on peut les sauter.
  //
  // fromStops / toStops : un id, une liste d'ids, ou une liste de { id, s } —
  // s = secondes de marche pour rejoindre (ou quitter) cet arrêt. Renvoie
  // { steps, start, end } : le chemin, et les arrêts de départ et d'arrivée
  // RETENUS parmi les candidats ; ou null.
  function route(fromStops, toStops, excluded = null, blocked = null) {
    const liste = (x) => (Array.isArray(x) ? x : [x]).map((e) => (typeof e === 'string' ? { id: e, s: 0 } : e));
    const departs = liste(fromStops);
    const cibles = new Map(liste(toStops).map((e) => [e.id, e.s]));
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

    for (const d of departs) relax(key(d.id, '*'), d.s, { kind: 'start', stop: d.id });
    let explored = 0;

    while (heap.size) {
      const cur = heap.pop();
      if (seen.has(cur.k)) continue;
      seen.add(cur.k);
      if (++explored > MAX_STATES) return null;
      if (cur.k === END) return buildPath(prev, END);
      // Un quai d'arrivée est atteint, quel que soit le mode : il reste à
      // marcher jusqu'à la destination. Le premier état « fin » sorti de la
      // file est le meilleur, marche finale comprise.
      const sid = cur.k.slice(0, cur.k.lastIndexOf('|'));
      const line = cur.k.slice(cur.k.lastIndexOf('|') + 1);
      if (cibles.has(sid)) relax(END, cur.s + cibles.get(sid), { key: cur.k, kind: 'end', stop: sid });

      // marche vers un arrêt voisin (débarquement = correspondance payée)
      const walkPenalty = line === '*' ? 0 : TRANSFER_S;
      for (const w of walkAdj.get(sid) ?? []) {
        // Même détour que la marche d'accès : sans cela, « aller à l'arrêt le
        // plus proche puis marcher jusqu'au suivant » coûtait moins cher que d'y
        // aller directement, et le trajet commençait par un crochet.
        relax(key(w.id, '*'), cur.s + walkPenalty + (w.dist * DETOUR) / WALK_M_S,
          { key: cur.k, kind: 'walk', from: sid, to: w.id, seconds: Math.round((w.dist * DETOUR) / WALK_M_S), penalty: walkPenalty });
      }

      for (const { routeId } of serving.get(sid) ?? []) {
        if (excluded?.has(routeId)) continue;
        if (blocked?.stopClosed(routeId, sid)) continue;
        const boardPenalty = line !== '*' && line !== routeId ? TRANSFER_S : 0;
        const wait = line !== routeId ? waitOf(routeId) : 0; // attente d'un nouveau véhicule
        for (const v of variantsCalc.get(routeId) ?? []) {
          const i = v.stops.indexOf(sid);
          if (i < 0) continue;
          for (let j = i + 1; j < v.stops.length; j++) {
            if (blocked) {
              if (blocked.cut(routeId, v.stops[j])) break;
              if (blocked.stopClosed(routeId, v.stops[j])) continue;
            }
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
    let k = endKey, start = null, end = null;
    while (prev.has(k)) {
      const n = prev.get(k);
      if (!n) break;
      if (n.kind === 'start') { start = n.stop; break; }
      if (n.kind === 'end') end = n.stop; else steps.push(n);
      k = n.key;
      if (!k) break;
    }
    steps.reverse();
    return { steps, start, end };
  }

  // --- API publique -----------------------------------------------------
  let rtCtx = null;
  // Fréquence par ligne (médiane des écarts de départ), pour pondérer le
  // temps d'attente théorique dans la recherche (sinon un chemin avec un
  // bus toutes les 30 min est préféré à un tram toutes les 6 min).
  const headway = new Map();
  // Attente avant de monter, par mode. Deux raisons de ne pas se contenter
  // d'une constante :
  //  - la fréquence réelle n'est connue que pour les lignes qui circulent dans
  //    le flux temps réel ; le reste retombe sur une valeur par défaut, et 240 s
  //    rendaient toute correspondance moins avantageuse qu'une marche de
  //    300 m (4 min à 1,25 m/s) — c'est-à-dire que le planificateur
  //    proposait de marcher entre deux stations de métro distantes de 300 m ;
  //  - un métro toutes les 4 min ne s'attend pas comme un bus toutes les
  //    30 min : plafonner l'attente à 15 min pour tout le monde rendait le
  //    métro inutilisable sur les courts trajets.
  const ATTENTE = { 1: { defaut: 120, max: 300 }, 0: { defaut: 180, max: 480 } };
  const defautAttente = { defaut: 240, max: 900 };
  const waitOf = (routeId) => {
    const cfg = ATTENTE[Number(routeById.get(routeId)?.type)] ?? defautAttente;
    const h = headway.get(routeId);
    return h ? Math.min(Math.max(Math.round(h / 2), 60), cfg.max) : cfg.defaut;
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
    // Plusieurs quais fournis : la station entière. On garde ceux qui
    // existent, et le premier sert de repère pour la marche finale.
    if (Array.isArray(p.stop_ids) && p.stop_ids.length) {
      const ids = p.stop_ids.filter((id) => stops[id]);
      if (!ids.length) return null;
      const premier = ids[0];
      return { stop_id: premier, stop_ids: ids, label: stops[premier].n };
    }
    if (p.stop_id) {
      const s = stops[p.stop_id];
      if (!s) return null;
      return { stop_id: p.stop_id, stop_ids: [p.stop_id], label: s.n };
    }
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
      // coller au stop_point le plus proche quand on est déjà dessus :
      // évite un faux "marchage" de 4 s au début/à la fin du trajet.
      const near = stopsNear(p.lat, p.lon, 80)[0];
      if (near) return { stop_id: near.id, stop_ids: [near.id], label: stops[near.id].n };
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

    // Arrêts candidats : les quais de la station nommée (accès immédiat), ou
    // ceux à portée de marche de l'adresse, chacun avec son temps d'accès.
    const acces = (p) => {
      if (p.stop_ids) return p.stop_ids.map((id) => ({ id, s: 0 }));
      let near = stopsNear(p.lat, p.lon, ACCESS_RADIUS_M).slice(0, ACCESS_MAX);
      if (!near.length) near = stopsNear(p.lat, p.lon, SEARCH_RADIUS_M).slice(0, 1);
      return near.map((x) => ({ id: x.id, s: Math.round((x.dist * DETOUR) / WALK_M_S) }));
    };
    const sources = acces(f), cibles = acces(t);
    const fromStops = sources.map((x) => x.id);
    const toStops = cibles.map((x) => x.id);
    if (!fromStops.length || !toStops.length) return { error: 'Aucun arrêt accessible à proximité' };
    if (f.stop_ids && t.stop_ids && fromStops.length === 1 && toStops.length === 1 && fromStops[0] === toStops[0]) {
      return { error: 'Départ et arrivée sur le même arrêt' };
    }
    const accesDe = new Map(sources.map((x) => [x.id, x.s]));
    const sortieDe = new Map(cibles.map((x) => [x.id, x.s]));
    // Position d'un bout du trajet (pour le tracé) : le lieu donné, sinon l'arrêt.
    const posDe = (p, stopId) => (Number.isFinite(p.lat) ? [p.lat, p.lon] : stops[stopId] ? [stops[stopId].lat, stops[stopId].lon] : null);
    const posArret = (id) => (stops[id] ? [stops[id].lat, stops[id].lon] : null);
    // Recherche : rend { steps (fusionnées), start, end } — jamais null.
    const chercher = (ex) => {
      const found = route(sources, cibles, ex, blocked);
      return found ? { steps: mergeSteps(found.steps), start: found.start, end: found.end } : { steps: [], start: null, end: null };
    };

    // Lignes qui ne roulent pas à l'heure du départ : écartées de la
    // recherche. Si plus rien ne passe (nuit), on retombe sur le réseau
    // entier plutôt que de ne rien proposer — et on le signale.
    // opts.exclude : lignes que l'utilisateur veut éviter — toujours respecté,
    // y compris dans le repli (on ne lui impose jamais une ligne refusée).
    const avoid = opts.exclude?.size ? opts.exclude : null;
    // Arrêts fermés et tronçons coupés à l'heure du trajet : jamais empruntés,
    // même dans le repli « réseau entier ».
    const blocked = opts.blocked?.size ? opts.blocked : null;
    let excluded = avoid ? new Set(avoid) : null;
    if (opts.inService) {
      excluded ??= new Set();
      for (const routeId of variantsCalc.keys()) if (opts.inService(routeId, at) === false) excluded.add(routeId);
      if (!excluded.size) excluded = null;
    }

    // Horaires d'un chemin. Chaque étape en véhicule reçoit un départ :
    // temps réel, sinon horaire théorique (même lointain : la nuit, le
    // prochain est à 05 h 15 et il faut le dire). Une étape sans AUCUN
    // départ connu n'est jamais « partie tout de suite » : on la marque
    // no_departure et l'appelant cherche un autre chemin.
    function timeSteps(found) {
      const { steps } = found;
      const fromStop = found.start, toStop = found.end;
      const walkIn = accesDe.get(fromStop) ?? 0, walkOut = sortieDe.get(toStop) ?? 0;
      const legs = [];
      let clock = at;
      if (walkIn > 0) legs.push({ type: 'walk', access: true, seconds: walkIn, from: f.label ?? 'Départ', to: stopLabel(fromStop), to_id: fromStop, from_pos: posDe(f, fromStop), to_pos: posArret(fromStop) });
      clock += walkIn;
      let realCount = 0, estCount = 0;
      const missing = [];
      for (const s of steps) {
        if (s.kind === 'walk') {
          legs.push({ type: 'walk', seconds: s.seconds, from: stopLabel(s.from), to: stopLabel(s.to), from_id: s.from, to_id: s.to, from_pos: posArret(s.from), to_pos: posArret(s.to) });
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
          ready_at: clock,
        };
        if (rt) {
          leg.depart = rt.board_t; leg.arrive = rt.alight_t; leg.real = true;
          leg.trip_id = rt.trip_id;
          if (rt.vehicle) leg.vehicle = rt.vehicle;
          if (rt.delay != null) leg.delay_s = rt.delay;
          if (rt.alight_delay != null) leg.arrive_delay_s = rt.alight_delay;
          if (rt.ts) leg.rt_ts = rt.ts;
          clock = rt.alight_t;
          realCount++;
        } else {
          const dur = est ?? s.seconds;
          const next = opts.nextDeparture?.(s.routeId, s.board, s.alight, clock);
          if (Number.isFinite(next) && next >= clock) {
            clock = next;
            leg.scheduled = true;
            if (next - leg.ready_at > MAX_WAIT_S) leg.long_wait = true;
            // Arrivée lue dans la grille théorique quand on sait apparier la
            // course ; sinon la durée estimée.
            const arr = opts.scheduledArrival?.(s.routeId, s.board, s.alight, next, est ?? s.seconds);
            if (Number.isFinite(arr) && arr > next) {
              leg.depart = next; leg.arrive = arr; leg.real = false; leg.arrive_scheduled = true;
              clock = arr;
              estCount++;
              leg.seconds = Math.max(leg.arrive - leg.depart, 1);
              legs.push(leg);
              continue;
            }
          } else if (opts.nextDeparture) {
            leg.no_departure = true;
            missing.push(s.routeId);
          }
          leg.depart = clock; leg.arrive = clock + dur; leg.real = false;
          clock += dur;
          estCount++;
        }
        leg.seconds = Math.max(leg.arrive - leg.depart, 1);
        legs.push(leg);
      }
      if (walkOut > 0) legs.push({ type: 'walk', access: true, seconds: walkOut, from: stopLabel(toStop), to: t.label ?? 'Arrivée', from_id: toStop, from_pos: posArret(toStop), to_pos: posDe(t, toStop) });
      clock += walkOut;
      // Deux marches qui se suivent (de l'adresse à un arrêt, puis à l'arrêt
      // voisin) n'en font qu'une pour le voyageur : de l'adresse au second arrêt.
      for (let i = legs.length - 1; i > 0; i--) {
        const a = legs[i - 1], b = legs[i];
        if (a.type !== 'walk' || b.type !== 'walk') continue;
        legs.splice(i - 1, 2, {
          type: 'walk', ...(a.access || b.access ? { access: true } : {}), seconds: a.seconds + b.seconds,
          from: a.from, to: b.to, ...(a.from_id ? { from_id: a.from_id } : {}), ...(b.to_id ? { to_id: b.to_id } : {}),
          from_pos: a.from_pos, to_pos: b.to_pos, ...(a.to_pos ? { via_pos: a.to_pos } : {}),
        });
      }
      return { legs, clock, realCount, estCount, missing };
    }

    let found = chercher(excluded);
    let steps = found.steps;
    // Repli : si rien ne circule à cette heure (la nuit), on préfère proposer
    // un trajet sur le réseau entier plutôt que rien — mais en SIGNALANT les
    // lignes qui ne roulent pas. C'est ce que l'interface affiche (« hors
    // service maintenant : … ») ; sans ce signal, on enverrait le voyageur
    // prendre le métro à 3 h du matin comme si c'était normal.
    //
    // Le repli ne se déclenche pas seulement sur « aucun résultat » : sans
    // transports, la marche reste toujours possible, et Capitole → Basso
    // Cambo devenait 90 minutes de marche à pied, sans un mot d'avertissement.
    // Un résultat entièrement à pied n'est donc pas un résultat.
    const queDesMarches = (st) => st.length > 0 && st.every((s) => s.kind === 'walk');
    let repli = false;
    let horsService = [];
    if ((!steps.length || queDesMarches(steps)) && excluded && excluded !== avoid) {
      const autre = chercher(avoid);
      const alt = autre.steps;
      if (alt.length && (steps.length === 0 || queDesMarches(steps))) {
        found = autre;
        steps = alt;
        repli = true;
        horsService = [...new Map(steps
          .filter((s) => s.kind === 'ride' && excluded.has(s.routeId))
          .map((s) => [s.routeId, {
            route_id: s.routeId,
            line: routeById.get(s.routeId)?.short_name ?? s.routeId,
          }])).values()];
      }
    }
    // Marche directe, de porte à porte : quand au moins un bout est une adresse
    // et que la destination est proche, on la compare à tout ce qu'on a trouvé.
    // Sans cela, deux adresses voisines donnaient « marcher jusqu'à l'arrêt,
    // puis de l'arrêt à la porte » — ou un bus pour 300 mètres.
    const aUnPoint = !f.stop_ids || !t.stop_ids;
    const pf = posDe(f, fromStops[0]), pt = posDe(t, toStops[0]);
    const directM = aUnPoint && pf && pt ? haversineM(pf[0], pf[1], pt[0], pt[1]) : Infinity;
    const directS = directM <= DIRECT_WALK_MAX_M ? Math.round((directM * DETOUR) / WALK_M_S) : Infinity;
    const marcheDirecte = () => ({
      depart_at: at,
      arrive_at: at + directS,
      duration_s: directS,
      transfers: 0,
      legs: [{ type: 'walk', access: true, direct: true, seconds: directS, from: f.label ?? stopLabel(fromStops[0]), to: t.label ?? stopLabel(toStops[0]), from_pos: pf, to_pos: pt }],
      from: { stop_id: fromStops[0], name: f.label ?? stops[fromStops[0]].n },
      to: { stop_id: toStops[0], name: t.label ?? stops[toStops[0]].n },
      real: false,
      estimates: 0,
      walk_only: true,
    });
    if (!steps.length && found.start == null) {
      // Déjà sur place : le départ et l'arrivée partagent un arrêt. Ce n'est
      // pas une erreur, c'est LA réponse — « vous êtes à 100 m de votre
      // destination ». Traité comme une erreur, le planificateur passait à
      // l'homonyme suivant : depuis la place Wilson, à 100 m de la station
      // Jean Jaurès, il proposait 58 minutes jusqu'au Jean Jaurès de Purpan.
      const dejaSurPlace = fromStops.some((s) => toStops.includes(s));
      if (Number.isFinite(directS)) return marcheDirecte();
      if (!dejaSurPlace) {
        const fromStop = fromStops[0], toStop = toStops[0];
        // Le réseau Tisséo n'est pas d'un seul tenant : 11 îlots (Lacassagne,
        // Lévignac, Mérenvielle…) ne sont reliés à rien dans le GTFS, et
        // représentent ~4 % des arrêts. « Aucun itinéraire trouvé » sans
        // explication y laisserait croire à une panne de l'appli.
        const departSeul = composant(fromStops);
        const arriveeSeule = composant(toStops);
        return {
          error: 'Aucun itinéraire trouvé entre ces deux points',
          ...(departSeul && arriveeSeule && departSeul !== arriveeSeule
            ? {
              hint: `${stopLabel(fromStop)} et ${stopLabel(toStop)} ne sont reliés par aucune ligne `
                + 'dans les horaires publiés — le réseau comporte des zones que les '
                + 'horaires ne relient pas entre elles.',
              reseau: 'deux zones non reliées',
            }
            : { hint: 'Essayez un arrêt plus proche du réseau, ou des coordonnées « lat,lon ».' }),
        };
      }
    }

    let timed = timeSteps(found);
    // Des lignes sans aucun départ connu : on les écarte et on recommence,
    // quelques fois au plus. Si rien d'autre ne marche, on garde le chemin
    // mais ses étapes restent marquées sans départ.
    const noDep = new Set();
    for (let k = 0; k < NO_DEP_RETRIES && timed.missing.length; k++) {
      for (const id of timed.missing) noDep.add(id);
      const ex = new Set([...(excluded ?? []), ...(avoid ?? []), ...noDep]);
      const autre = chercher(ex);
      if (!autre.steps.length) break;
      const altTimed = timeSteps(autre);
      if (altTimed.missing.length > timed.missing.length) break;
      found = autre;
      steps = autre.steps;
      timed = altTimed;
    }

    const { legs, clock, realCount, estCount } = timed;
    const rides = legs.filter((l) => l.type === 'ride');
    // À pied, de porte à porte, on arrive plus tôt (ou il n'y a aucun véhicule
    // à prendre) : c'est la réponse.
    if (Number.isFinite(directS) && (at + directS <= clock || !rides.length)) return marcheDirecte();
    const fromStop = found.start ?? fromStops[0], toStop = found.end ?? toStops[0];
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
      ...(timed.missing.length ? { no_departure: true } : {}),
      // La clé est présente dès que le repli a servi, même avec une liste
      // vide : l'interface distingue alors « rien ne circule » de « tout
      // roule », et ne se tait pas.
      ...(repli ? { out_of_service: horsService } : {}),
    };
  }

  // Tous les arrêts atteignables depuis fromStop en moins de maxS secondes
  // (marche + lignes, correspondances et attentes moyennes comprises) :
  // stop_id -> { s, routes } où routes = lignes empruntées pour y arriver.
  function reach(fromStop, maxS, excluded = null, blocked = null) {
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
      for (const w of walkAdj.get(sid) ?? []) relax(key(w.id, '*'), cur.s + walkPenalty + (w.dist * DETOUR) / WALK_M_S, used);
      for (const { routeId } of serving.get(sid) ?? []) {
        if (excluded?.has(routeId)) continue;
        if (blocked?.stopClosed(routeId, sid)) continue;
        const boardPenalty = line !== '*' && line !== routeId ? TRANSFER_S : 0;
        const wait = line !== routeId ? waitOf(routeId) : 0;
        const nextUsed = used[used.length - 1] === routeId ? used : [...used, routeId];
        for (const v of variantsCalc.get(routeId) ?? []) {
          const i = v.stops.indexOf(sid);
          if (i < 0) continue;
          for (let j = i + 1; j < v.stops.length; j++) {
            if (blocked) {
              if (blocked.cut(routeId, v.stops[j])) break;
              if (blocked.stopClosed(routeId, v.stops[j])) continue;
            }
            relax(key(v.stops[j], routeId), cur.s + boardPenalty + wait + v.times[j] - v.times[i], nextUsed);
          }
        }
      }
    }
    return best;
  }

  // Durée de référence d'un trajet sur une ligne (tracé + arrêts), en s.
  const estimate = (routeId, board, alight) => estLeg(routeId, board, alight);
  return { journey, setFeed, stopsNear, reach, nearestStop, estimate };
}
