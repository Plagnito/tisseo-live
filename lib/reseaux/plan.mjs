// GTFS statique d'un réseau quelconque → de quoi calculer un ITINÉRAIRE.
//
// Le résultat a exactement la forme des données de Tisséo (data/routes.json,
// stops.json, route_variants.json, schedules.json) : le routeur de Toulouse
// (lib/router.mjs) et ses horaires (lib/schedules.mjs) le lisent tels quels.
// Trois différences avec scripts/prepare-gtfs.mjs, écrites pour Tisséo seul :
//  · les jours de service viennent de calendar.txt ET de calendar_dates.txt ;
//  · une ligne garde PLUSIEURS parcours par sens (ses branches), chacun avec
//    ses propres horaires — sinon le « prochain départ » d'une branche serait
//    souvent celui de l'autre ;
//  · les durées entre arrêts sont celles des horaires, pas une vitesse moyenne.
// Seule une fenêtre de quelques jours est gardée : c'est elle qui tient la
// taille (stop_times.txt pèse 190 Mo à Bordeaux).
import { csvObjects, csvRows, simplify, distM } from './gtfs.mjs';
import { joli } from './instance.mjs';

const BASE_TYPE = (type) => {
  const t = Number(type);
  if ([0, 1, 2, 3, 4, 5, 6, 7, 11, 12].includes(t)) return t;
  if (t >= 100 && t < 200) return 2;
  if (t >= 400 && t < 500) return 1;
  if (t >= 900 && t < 1000) return 0;
  if (t >= 1000 && t < 1100) return 4;
  if (t >= 1300 && t < 1500) return 6;
  return 3;
};
const hex = (c) => (/^[0-9a-f]{6}$/i.test(c || '') ? c.toLowerCase() : null);
const secs = (hms) => {
  if (!hms) return -1;
  const a = hms.indexOf(':'), b = hms.indexOf(':', a + 1);
  if (a < 1 || b < 0) return -1;
  const v = Number(hms.slice(0, a)) * 3600 + Number(hms.slice(a + 1, b)) * 60 + Number(hms.slice(b + 1));
  return Number.isFinite(v) ? v : -1;
};

// Les `days` jours à partir de la veille, à l'heure de Paris : ["AAAAMMJJ", …].
export function windowDates(now, days) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)).split('-').map(Number);
  const out = [];
  for (let i = -1; i < days - 1; i++) {
    const t = new Date(Date.UTC(y, m - 1, d + i, 12));
    out.push({ ymd: `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`, dow: t.getUTCDay() });
  }
  return out;
}

// Dates de circulation de chaque service, dans la fenêtre.
export function serviceDates(calendarTxt, calendarDatesTxt, dates) {
  const JOURS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dans = new Set(dates.map((d) => d.ymd));
  const out = new Map();
  if (calendarTxt) {
    for (const c of csvObjects(calendarTxt)) {
      if (!c.service_id) continue;
      const set = new Set();
      for (const d of dates) if (d.ymd >= c.start_date && d.ymd <= c.end_date && c[JOURS[d.dow]] === '1') set.add(d.ymd);
      out.set(c.service_id, set);
    }
  }
  if (calendarDatesTxt) {
    for (const e of csvObjects(calendarDatesTxt, ['service_id', 'date', 'exception_type'])) {
      if (!e.service_id || !dans.has(e.date)) continue;
      let set = out.get(e.service_id);
      if (!set) out.set(e.service_id, set = new Set());
      if (e.exception_type === '1') set.add(e.date); else if (e.exception_type === '2') set.delete(e.date);
    }
  }
  return out;
}

// Un parcours contient-il l'autre, dans l'ordre ? (course partielle d'une ligne)
function sousSuite(petit, grand) {
  let k = 0;
  for (let i = 0; i < grand.length && k < petit.length; i++) if (grand[i] === petit[k]) k++;
  return k === petit.length;
}

// feeds : [{ read(nom) → texte | null, lines(nom) → itérateur de lignes | null }].
export function buildPlan(feeds, { now = Date.now(), days = 15, maxVariants = 4, tolM = 8 } = {}) {
  const dates = windowDates(now, days);
  const routes = [], routeIdx = new Map();
  const stopIds = [], stopIdx = new Map(), stopInfo = new Map();
  const motifs = [], motifIdx = new Map();
  const variants = {}, lines = {};
  let passages = 0;

  for (const feed of feeds) {
    const rt = feed.read('routes.txt');
    if (!rt) continue;
    const mesRoutes = new Set();
    for (const r of csvObjects(rt, ['route_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color'])) {
      if (!r.route_id || routeIdx.has(r.route_id)) continue;
      routeIdx.set(r.route_id, routes.length); mesRoutes.add(r.route_id);
      routes.push({ route_id: r.route_id, short_name: r.route_short_name || r.route_long_name || r.route_id, long_name: r.route_long_name || '', color: hex(r.route_color) ?? '5b6b82', text_color: hex(r.route_text_color) ?? 'ffffff', type: BASE_TYPE(r.route_type) });
    }
    const st = feed.read('stops.txt');
    if (st) {
      for (const s of csvObjects(st, ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type', 'wheelchair_boarding'])) {
        const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
        if (!s.stop_id || stopInfo.has(s.stop_id) || !Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) continue;
        if (s.location_type && s.location_type !== '0') continue;
        stopInfo.set(s.stop_id, { n: s.stop_name || s.stop_id, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, ...(s.wheelchair_boarding === '1' || s.wheelchair_boarding === '2' ? { w: Number(s.wheelchair_boarding) } : {}) });
      }
    }
    const idx = (id) => { let i = stopIdx.get(id); if (i === undefined) { i = stopIds.length; stopIds.push(id); stopIdx.set(id, i); } return i; };

    // Services en circulation dans la fenêtre → motif de dates (dédupliqué).
    const svc = serviceDates(feed.read('calendar.txt'), feed.read('calendar_dates.txt'), dates);
    const motifDe = new Map();
    for (const [id, set] of svc) {
      if (!set.size) continue;
      const cle = [...set].sort().join(',');
      let pi = motifIdx.get(cle);
      if (pi === undefined) { pi = motifs.length; motifs.push(cle.split(',')); motifIdx.set(cle, pi); }
      motifDe.set(id, pi);
    }

    // Courses qui circulent dans la fenêtre.
    const trips = new Map();
    const tt = feed.read('trips.txt');
    if (tt) {
      for (const t of csvObjects(tt, ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id'])) {
        const pi = motifDe.get(t.service_id);
        if (pi === undefined || !mesRoutes.has(t.route_id) || !t.trip_id) continue;
        trips.set(t.trip_id, { r: t.route_id, d: t.direction_id === '0' || t.direction_id === '1' ? t.direction_id : '', h: t.trip_headsign, sh: t.shape_id, pi, q: [], s: [], t: [] });
      }
    }
    if (!trips.size) continue;

    // Horaires : une passe, ligne à ligne (le fichier ne tient pas en une chaîne).
    const it = feed.lines('stop_times.txt');
    if (!it) continue;
    let cols = null, iTrip, iStop, iSeq, iDep, iArr;
    for (const line of it) {
      if (!line) continue;
      const p = line.includes('"') ? [...csvRows(line)][0] ?? [] : line.split(',');
      if (!cols) {
        cols = p.map((c) => c.trim().replace(/^﻿/, ''));
        iTrip = cols.indexOf('trip_id'); iStop = cols.indexOf('stop_id'); iSeq = cols.indexOf('stop_sequence'); iDep = cols.indexOf('departure_time'); iArr = cols.indexOf('arrival_time');
        if (iTrip < 0 || iStop < 0 || iSeq < 0) break;
        continue;
      }
      const tr = trips.get(p[iTrip]);
      if (!tr || !stopInfo.has(p[iStop])) continue;
      let t = secs(iDep >= 0 ? p[iDep] : '');
      if (t < 0) t = secs(iArr >= 0 ? p[iArr] : '');
      tr.q.push(Number(p[iSeq])); tr.s.push(idx(p[iStop])); tr.t.push(t);
    }

    // Par ligne et par sens : les parcours (suites d'arrêts), des plus empruntés aux plus rares.
    const groupes = new Map(); // "ligne|sens" → Map(cle → { stops, trips[] })
    for (const tr of trips.values()) {
      const n = tr.q.length;
      if (n < 2) continue;
      let trie = true;
      for (let i = 1; i < n; i++) if (tr.q[i] < tr.q[i - 1]) { trie = false; break; }
      if (!trie) {
        const o = tr.q.map((_, i) => i).sort((a, b) => tr.q[a] - tr.q[b]);
        tr.s = o.map((i) => tr.s[i]); tr.t = o.map((i) => tr.t[i]);
      }
      // Heures manquantes (arrêts sans horaire propre) : réparties entre les deux voisines connues.
      if (tr.t.includes(-1)) {
        let a = -1;
        for (let i = 0; i < n; i++) {
          if (tr.t[i] >= 0) {
            if (a >= 0 && i - a > 1) for (let k = a + 1; k < i; k++) tr.t[k] = Math.round(tr.t[a] + ((tr.t[i] - tr.t[a]) * (k - a)) / (i - a));
            a = i;
          }
        }
        if (tr.t.includes(-1)) continue; // début ou fin sans heure : course écartée
      }
      tr.q = null;
      tr.cle = tr.s.join(',');
      const g = `${tr.r}|${tr.d}`;
      let m = groupes.get(g);
      if (!m) groupes.set(g, m = new Map());
      let pat = m.get(tr.cle);
      if (!pat) m.set(tr.cle, pat = { stops: tr.s, trips: [] });
      pat.trips.push(tr);
    }

    // Un GTFS sans direction_id : le sens se lit dans l'ordre des arrêts, ou à
    // défaut dans l'orientation du parcours, par rapport au parcours principal.
    for (const [g, m] of [...groupes]) {
      if (!g.endsWith('|')) continue;
      const pats = [...m.values()].sort((a, b) => b.trips.length - a.trips.length);
      const ref = pats[0].stops;
      const pos = new Map(ref.map((s, i) => [s, i]));
      const vec = (st) => { const a = stopInfo.get(stopIds[st[0]]), b = stopInfo.get(stopIds[st[st.length - 1]]); return [b.lat - a.lat, b.lon - a.lon]; };
      const vr = vec(ref);
      groupes.delete(g);
      for (const pat of pats) {
        const communs = pat.stops.filter((s) => pos.has(s));
        let meme;
        if (communs.length >= 2) meme = pos.get(communs[0]) < pos.get(communs[communs.length - 1]);
        else { const v = vec(pat.stops); meme = v[0] * vr[0] + v[1] * vr[1] >= 0; }
        const cle = `${g}${meme ? '0' : '1'}`;
        let mm = groupes.get(cle);
        if (!mm) groupes.set(cle, mm = new Map());
        mm.set(pat.stops.join(','), pat);
        for (const tr of pat.trips) tr.d = meme ? '0' : '1';
      }
    }

    // Parcours retenus : le principal, puis ceux qui desservent des arrêts que
    // les précédents ne desservent pas (les branches), dans la limite de quatre.
    const formes = new Map(); // shape_id → [variantes qui l'attendent]
    const seaux = new Map();  // parcours retenu → Map(arrêt → Map(motif → heures[]))
    for (const [g, m] of groupes) {
      const [routeId, d] = [g.slice(0, g.lastIndexOf('|')), g.slice(g.lastIndexOf('|') + 1)];
      const pats = [...m.values()].sort((a, b) => b.trips.length - a.trips.length || b.stops.length - a.stops.length);
      const retenus = [pats[0]];
      const couverts = new Set(pats[0].stops);
      for (const pat of pats.slice(1)) {
        if (retenus.length >= maxVariants) break;
        if (!pat.stops.some((s) => !couverts.has(s))) continue;
        retenus.push(pat);
        for (const s of pat.stops) couverts.add(s);
      }
      const lettres = ['', 'b', 'c', 'd', 'e', 'f'];
      retenus.forEach((pat, k) => {
        pat.vdir = d + lettres[k];
        // Durées cumulées : celles de la course de durée médiane sur ce parcours.
        const tri = [...pat.trips].sort((a, b) => (a.t[a.t.length - 1] - a.t[0]) - (b.t[b.t.length - 1] - b.t[0]));
        const ref = tri[tri.length >> 1];
        let prev = 0;
        const times = ref.t.map((x) => { prev = Math.max(prev, x - ref.t[0]); return prev; });
        const tetes = new Map(), traces = new Map();
        for (const tr of pat.trips) { if (tr.h) tetes.set(tr.h, (tetes.get(tr.h) || 0) + 1); if (tr.sh) traces.set(tr.sh, (traces.get(tr.sh) || 0) + 1); }
        const plusFrequent = (mm) => [...mm].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const dernier = stopInfo.get(stopIds[pat.stops[pat.stops.length - 1]]);
        const v = { dir: pat.vdir, headsign: joli(plusFrequent(tetes)) || dernier.n, stops: pat.stops.map((i) => stopIds[i]), times, shape: null };
        const sh = plusFrequent(traces);
        if (sh) { if (!formes.has(sh)) formes.set(sh, []); formes.get(sh).push(v); }
        (variants[routeId] ??= []).push(v);
        pat.variante = v;
      });
      // Chaque course va au parcours retenu qu'elle suit : le sien, sinon celui
      // dont elle est une partie, sinon celui qui partage le plus d'arrêts.
      for (const pat of pats) {
        let cible = pat.variante ? pat : retenus.find((r) => sousSuite(pat.stops, r.stops));
        if (!cible) {
          let best = 0;
          for (const r of retenus) { const set = new Set(r.stops); const n = pat.stops.filter((s) => set.has(s)).length; if (n > best) { best = n; cible = r; } }
        }
        if (!cible) continue;
        const dedans = cible === pat ? null : new Set(cible.stops);
        let parArret = seaux.get(cible);
        if (!parArret) seaux.set(cible, parArret = new Map());
        for (const tr of pat.trips) {
          for (let i = 0; i < tr.s.length; i++) {
            if (dedans && !dedans.has(tr.s[i])) continue;
            let mm = parArret.get(tr.s[i]);
            if (!mm) parArret.set(tr.s[i], mm = new Map());
            let l = mm.get(tr.pi);
            if (!l) mm.set(tr.pi, l = []);
            l.push(tr.t[i]);
          }
        }
      }
      for (const r of retenus) {
        const parArret = seaux.get(r);
        if (!parArret) continue;
        const L = ((lines[routeId] ??= {})[r.vdir] = { headsign: r.variante.headsign, stops: {} });
        for (const [si, mm] of parArret) {
          const out = {};
          for (const [pi, l] of mm) { const u = [...new Set(l)].sort((x, y) => x - y); out[pi] = u; passages += u.length; }
          L.stops[stopIds[si]] = out;
        }
        seaux.delete(r);
      }
      // Fréquence de la ligne en journée (écart médian entre deux départs du
      // parcours principal) : c'est elle qui dit combien on attend en moyenne.
      const r = routes[routeIdx.get(routeId)];
      if (r && r.headway_s == null) {
        const parMotif = new Map();
        for (const tr of pats[0].trips) { if (!parMotif.has(tr.pi)) parMotif.set(tr.pi, []); parMotif.get(tr.pi).push(tr.t[0]); }
        const plein = [...parMotif.values()].sort((a, b) => b.length - a.length)[0].filter((t) => t >= 7 * 3600 && t <= 19 * 3600).sort((a, b) => a - b);
        const ecarts = [];
        for (let i = 1; i < plein.length; i++) { const e = plein[i] - plein[i - 1]; if (e > 30) ecarts.push(e); }
        if (ecarts.length >= 2) { ecarts.sort((a, b) => a - b); r.headway_s = ecarts[ecarts.length >> 1]; }
      }
    }
    // Tracés des parcours retenus.
    const sh = formes.size ? feed.lines('shapes.txt') : null;
    if (sh) {
      let c = null, iId, iLat, iLon, iSq;
      const pts = new Map();
      for (const line of sh) {
        if (!line) continue;
        const p = line.includes('"') ? [...csvRows(line)][0] ?? [] : line.split(',');
        if (!c) { c = p.map((x) => x.trim().replace(/^﻿/, '')); iId = c.indexOf('shape_id'); iLat = c.indexOf('shape_pt_lat'); iLon = c.indexOf('shape_pt_lon'); iSq = c.indexOf('shape_pt_sequence'); if (iId < 0 || iLat < 0 || iLon < 0) break; continue; }
        if (!formes.has(p[iId])) continue;
        const lat = Number(p[iLat]), lon = Number(p[iLon]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) continue;
        let a = pts.get(p[iId]);
        if (!a) pts.set(p[iId], a = []);
        a.push([iSq >= 0 ? Number(p[iSq]) : a.length, lat, lon]);
      }
      for (const [id, a] of pts) {
        a.sort((x, y) => x[0] - y[0]);
        const line = simplify(a.map(([, lat, lon]) => [lat, lon]), tolM).map(([lat, lon]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]);
        if (line.length >= 2) for (const v of formes.get(id)) v.shape = line;
      }
    }
  }

  // Sans tracé publié : la suite des arrêts fait le tracé.
  const stops = {};
  for (const list of Object.values(variants)) {
    for (const v of list) {
      for (const id of v.stops) stops[id] ??= stopInfo.get(id);
      if (!v.shape) v.shape = v.stops.map((id) => [stopInfo.get(id).lat, stopInfo.get(id).lon]);
    }
    list.sort((a, b) => a.dir.localeCompare(b.dir));
  }
  let bbox = null;
  for (const s of Object.values(stops)) bbox = bbox ? [Math.min(bbox[0], s.lat), Math.min(bbox[1], s.lon), Math.max(bbox[2], s.lat), Math.max(bbox[3], s.lon)] : [s.lat, s.lon, s.lat, s.lon];
  const servies = routes.filter((r) => variants[r.route_id]);
  return {
    v: 1,
    built_at: new Date(now).toISOString(),
    from: dates[0].ymd, until: dates[dates.length - 1].ymd,
    routes: servies, stops, variants,
    schedules: { patterns: motifs, lines },
    bbox,
    counts: { routes: servies.length, stops: Object.keys(stops).length, variants: Object.values(variants).reduce((n, l) => n + l.length, 0), passages, motifs: motifs.length },
  };
}

// Distance entre deux arrêts d'un plan (pour les tests et les contrôles).
export const stopDistance = (plan, a, b) => distM(plan.stops[a].lat, plan.stops[a].lon, plan.stops[b].lat, plan.stops[b].lon);
