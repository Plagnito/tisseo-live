// GTFS statique d'un réseau quelconque → le peu dont la carte a besoin.
//
// On ne lit PAS stop_times.txt (des centaines de mégaoctets sur un grand
// réseau) : les passages viennent du temps réel. Il reste les lignes (nom,
// couleur, mode), les courses (ligne, sens, destination — pour étiqueter un
// véhicule dont le flux ne donne que le trip_id), les arrêts et un tracé
// représentatif par ligne et par sens.

// --- CSV ---------------------------------------------------------------------
// Lignes d'un CSV, champs entre guillemets compris (virgules, guillemets
// doublés, retours à la ligne). Générateur : shapes.txt fait vite 50 Mo.
export function* csvRows(text) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  let row = [], field = '', quoted = false, any = false;
  for (; i < n; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; any = true; continue; }
    if (c === ',') { row.push(field); field = ''; any = true; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (any || field) { row.push(field); yield row; }
      row = []; field = ''; any = false;
      continue;
    }
    field += c; any = true;
  }
  if (any || field) { row.push(field); yield row; }
}

// Objets { colonne: valeur } d'un CSV (colonnes nettoyées de leurs espaces).
export function* csvObjects(text, wanted = null) {
  let cols = null, idx = null;
  for (const row of csvRows(text)) {
    if (!cols) {
      cols = row.map((c) => c.trim());
      idx = (wanted ?? cols).map((c) => cols.indexOf(c));
      continue;
    }
    const o = {};
    const names = wanted ?? cols;
    for (let k = 0; k < names.length; k++) o[names[k]] = idx[k] >= 0 ? (row[idx[k]] ?? '').trim() : '';
    yield o;
  }
}

// --- géométrie -----------------------------------------------------------------
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function distM(aLat, aLon, bLat, bLon) {
  const x = rad(bLon - aLon) * Math.cos(rad((aLat + bLat) / 2)), y = rad(bLat - aLat);
  return Math.sqrt(x * x + y * y) * R;
}

// Douglas-Peucker en mètres (itératif : un tracé fait parfois 5 000 points).
export function simplify(points, tolM = 6) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [aLat, aLon] = points[a], [bLat, bLon] = points[b];
    const k = Math.cos(rad((aLat + bLat) / 2));
    const bx = (bLon - aLon) * k, by = bLat - aLat, len2 = bx * bx + by * by;
    let worst = -1, far = 0;
    for (let i = a + 1; i < b; i++) {
      const px = (points[i][1] - aLon) * k, py = points[i][0] - aLat;
      const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
      const dx = px - t * bx, dy = py - t * by;
      const d = Math.sqrt(dx * dx + dy * dy) * rad(1) * R;
      if (d > far) { far = d; worst = i; }
    }
    if (worst > 0 && far > tolM) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// --- construction ----------------------------------------------------------------
const MODES = { 0: 'Tram', 1: 'Métro', 2: 'Train', 3: 'Bus', 4: 'Bateau', 5: 'Tram', 6: 'Télécabine', 7: 'Funiculaire', 11: 'Trolleybus', 12: 'Monorail' };
// Types étendus (100–1799) ramenés aux modes simples.
export function modeOf(type) {
  const t = Number(type);
  if (MODES[t]) return MODES[t];
  if (t >= 100 && t < 200) return 'Train';
  if (t >= 400 && t < 500) return 'Métro';
  if (t >= 700 && t < 800) return 'Bus';
  if (t >= 900 && t < 1000) return 'Tram';
  if (t >= 1000 && t < 1100) return 'Bateau';
  if (t >= 1300 && t < 1500) return 'Télécabine';
  return 'Bus';
}
const hex = (c) => (/^[0-9a-f]{6}$/i.test(c || '') ? `#${c.toLowerCase()}` : null);
const round5 = (x) => Math.round(x * 1e5) / 1e5;

// feeds : [{ read(name) → texte du fichier, ou null }] — un par archive GTFS du
// réseau (certains en publient une par exploitant).
export function buildNetwork(feeds, { now = Date.now(), tracesParSens = 2, tolM = 6 } = {}) {
  const routes = [], routeIdx = new Map();
  const headsigns = [], headIdx = new Map();
  const trips = {};
  const stops = [], seenStops = new Set();
  const shapes = {};
  const head = (s) => {
    if (!s) return -1;
    let i = headIdx.get(s);
    if (i === undefined) { i = headsigns.length; headsigns.push(s); headIdx.set(s, i); }
    return i;
  };

  for (const feed of feeds) {
    const txt = feed.read('routes.txt');
    if (!txt) continue;
    for (const r of csvObjects(txt, ['route_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color'])) {
      if (!r.route_id || routeIdx.has(r.route_id)) continue;
      routeIdx.set(r.route_id, routes.length);
      routes.push({
        id: r.route_id,
        short: r.route_short_name || r.route_long_name || r.route_id,
        long: r.route_long_name || '',
        mode: modeOf(r.route_type),
        color: hex(r.route_color),
        text: hex(r.route_text_color),
      });
    }

    // Courses : ligne, sens, destination ; et le compte des tracés par ligne et sens.
    const usage = new Map(); // "ri|dir" → Map(shape_id → nombre de courses)
    const tt = feed.read('trips.txt');
    if (tt) {
      for (const t of csvObjects(tt, ['route_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id'])) {
        const ri = routeIdx.get(t.route_id);
        if (ri === undefined || !t.trip_id) continue;
        const dir = t.direction_id === '1' ? 1 : 0;
        if (!(t.trip_id in trips)) trips[t.trip_id] = [ri, dir, head(t.trip_headsign)];
        if (t.shape_id) {
          const k = `${ri}|${dir}`;
          let m = usage.get(k);
          if (!m) usage.set(k, m = new Map());
          m.set(t.shape_id, (m.get(t.shape_id) || 0) + 1);
        }
      }
    }

    // Tracés retenus : le plus emprunté de chaque sens, et le suivant s'il porte
    // au moins un quart des courses (une branche).
    const wanted = new Map(); // shape_id → ["ri|dir", …]
    for (const [k, m] of usage) {
      const tri = [...m].sort((a, b) => b[1] - a[1]);
      const total = tri.reduce((s, x) => s + x[1], 0);
      tri.slice(0, tracesParSens).forEach(([sid, n], i) => {
        if (i > 0 && n < total / 4) return;
        if (!wanted.has(sid)) wanted.set(sid, []);
        wanted.get(sid).push(k);
      });
    }
    const st = wanted.size ? feed.read('shapes.txt') : null;
    if (st) {
      const pts = new Map();
      for (const p of csvObjects(st, ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'])) {
        if (!wanted.has(p.shape_id)) continue;
        const lat = Number(p.shape_pt_lat), lon = Number(p.shape_pt_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) continue;
        let a = pts.get(p.shape_id);
        if (!a) pts.set(p.shape_id, a = []);
        a.push([Number(p.shape_pt_sequence) || a.length, lat, lon]);
      }
      for (const [sid, a] of pts) {
        a.sort((x, y) => x[0] - y[0]);
        const line = simplify(a.map(([, lat, lon]) => [lat, lon]), tolM).map(([lat, lon]) => [round5(lat), round5(lon)]);
        if (line.length < 2) continue;
        for (const k of wanted.get(sid)) (shapes[k] ??= []).push(line);
      }
    }

    const ss = feed.read('stops.txt');
    if (ss) {
      for (const s of csvObjects(ss, ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type', 'parent_station'])) {
        const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
        if (!s.stop_id || seenStops.has(s.stop_id) || !Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) continue;
        if (s.location_type && s.location_type !== '0' && s.location_type !== '1') continue; // entrées, nœuds de cheminement
        seenStops.add(s.stop_id);
        stops.push([s.stop_id, s.stop_name || s.stop_id, round5(lat), round5(lon), s.location_type === '1' ? 1 : 0]);
      }
    }
  }

  let bbox = null;
  for (const [, , lat, lon] of stops) {
    bbox = bbox ? [Math.min(bbox[0], lat), Math.min(bbox[1], lon), Math.max(bbox[2], lat), Math.max(bbox[3], lon)] : [lat, lon, lat, lon];
  }
  return {
    v: 1,
    built_at: new Date(now).toISOString(),
    routes, headsigns, trips, stops, shapes, bbox,
    counts: { routes: routes.length, trips: Object.keys(trips).length, stops: stops.length, shapes: Object.values(shapes).reduce((s, x) => s + x.length, 0) },
  };
}
