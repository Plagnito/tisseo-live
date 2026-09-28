// Outils MCP de Tisséo Live : ce qu'un assistant (ChatGPT, Claude…) peut
// demander au réseau toulousain. Tout est en lecture seule.
//
// Le module est PUR : il reçoit un objet `svc` (branché par server.mjs sur le
// flux temps réel et les données GTFS) et renvoie la liste des outils. Les
// tests lui passent un `svc` factice, sans réseau.
//
// Choix de rédaction des réponses, pensés pour un modèle de langage :
//   - heures en clair, fuseau Europe/Paris (« 14:32 »), plus « dans N min » ;
//     jamais d'epoch seul, qu'un modèle convertit mal ;
//   - chaque point de départ/arrivée dit comment il a été COMPRIS
//     (« interprete_comme ») : le modèle peut corriger s'il s'est trompé ;
//   - la provenance de chaque horaire est dite (temps réel / théorique /
//     estimé) : une position de véhicule est une ESTIMATION, pas un GPS.
import { ToolError } from './mcp.mjs';

const TZ = 'Europe/Paris';
// Un lieu géocodé n'est retenu que s'il est DESSERVI : un arrêt Tisséo à
// moins de cette distance. C'est ce qui écarte « 12 rue Alsace-Lorraine » à
// Lavaur (Tarn), que le géocodeur classe devant celle de Toulouse.
const MAX_STOP_DIST_M = 1500;

// --- heures ------------------------------------------------------------

const fmtHM = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const fmtDay = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });

export const heure = (t) => (Number.isFinite(t) ? fmtHM.format(new Date(t * 1000)) : null);

function parisParts(t) {
  const p = Object.fromEntries(fmtParts.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// Heure murale de Paris → epoch (gère l'heure d'été : deux passes suffisent).
export function parisToEpoch(y, mo, d, h, mi) {
  const wall = Date.UTC(y, mo - 1, d, h, mi) / 1000;
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const p = parisParts(t);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000;
    t += wall - seen;
  }
  return t;
}

// « 8h15 », « 08:15 », « 2026-09-29T08:15 », « 2026-09-29 08:15 » ou epoch.
// Une heure seule déjà passée depuis plus d'une heure désigne demain.
export function parseHeure(raw, now) {
  if (raw === undefined || raw === null || raw === '') return now;
  const s = String(raw).trim().toLowerCase();
  if (/^\d{9,11}$/.test(s)) return Number(s);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{1,2})[:h](\d{2})/);
  if (m) return parisToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5]);
  m = s.match(/^(\d{1,2})\s*(?:h|:)\s*(\d{2})?$/) || s.match(/^(\d{1,2})$/);
  if (m) {
    const h = +m[1], mi = +(m[2] ?? 0);
    if (h > 23 || mi > 59) throw new ToolError(`Heure invalide : « ${raw} ».`);
    const p = parisParts(now);
    let t = parisToEpoch(p.y, p.mo, p.d, h, mi);
    if (t < now - 3600) t = parisToEpoch(p.y, p.mo, p.d + 1, h, mi);
    return t;
  }
  if (s === 'maintenant' || s === 'now') return now;
  throw new ToolError(`Heure non comprise : « ${raw} ». Formats acceptés : "08:15", "8h15", "2026-09-29T08:15".`);
}

const dansMin = (t, now) => (Number.isFinite(t) ? Math.max(0, Math.round((t - now) / 60)) : null);

// --- texte -------------------------------------------------------------

export const norm = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const STOPWORDS = new Set(['arret', 'station', 'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'a', 'au', 'aux', 'en', 'sur']);
// Communes desservies : « aéroport de Blagnac » doit trouver l'arrêt
// « Aéroport », dont le nom ne contient pas la commune.
const COMMUNES = new Set(('toulouse blagnac colomiers balma ramonville tournefeuille cugnaux muret castanet tolosan labege '
  + 'beauzelle aussonne cornebarrieu fonsegrives aucamville fenouillet launaguet lespinasse seilh gagnac fonbeauzard pibrac '
  + 'brax portet escalquens auzeville mondonville mondouzil flourens dremil lafage quint villeneuve tolosane leguevin '
  + 'plaisance touch frouzins seysses roques villemur union orens').split(' '));

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<\s*(br|\/p|\/h\d|\/li)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// --- géométrie ------------------------------------------------------------

function distM(aLat, aLon, bLat, bLon) {
  const R = 6_371_000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const round5 = (x) => Math.round(x * 1e5) / 1e5;

// ----------------------------------------------------------------------------

export function createTools(svc) {
  const { routes, stops, variants, routeById, modeOf } = svc;
  const now = () => (svc.now ? svc.now() : Math.floor(Date.now() / 1000));

  // --- lignes ---------------------------------------------------------------
  const MODE_WORDS = /^(ligne|line|bus|tram|tramway|metro|navette|teleo|telepherique)\s+/;
  function findLines(q) {
    const raw = String(q ?? '').trim();
    if (!raw) return [];
    if (routeById.get(raw)) return [routeById.get(raw)];
    const n = norm(raw);
    const keys = [...new Set([n, n.replace(MODE_WORDS, '').trim()])].filter(Boolean);
    const exact = routes.filter((r) => keys.includes(norm(r.short_name)));
    if (exact.length) return exact;
    return routes.filter((r) => keys.some((k) => k.length >= 3 && norm(r.long_name).includes(k)));
  }
  function oneLine(q) {
    const hit = findLines(q);
    if (!hit.length) throw new ToolError(`Ligne inconnue : « ${q} ». Utilisez l'outil « lignes » pour voir les lignes (ex. "A", "T1", "L1", "14", "TELEO").`);
    return hit;
  }
  const lineLabel = (r) => `${modeOf(r)} ${r.short_name}`;

  // Direction (terminus) d'un trajet de board à alight sur une ligne.
  function headsignFor(routeId, board, alight) {
    for (const v of variants[routeId] ?? []) {
      const i = v.stops.indexOf(board), j = v.stops.indexOf(alight);
      if (i >= 0 && j > i) return v.headsign;
    }
    return null;
  }

  // --- homonymes ------------------------------------------------------------
  // Plusieurs arrêts portent le même nom dans des communes différentes
  // (« Jean Jaurès » : la station de métro du centre ET un arrêt près de
  // Muret). La recherche en prend un au hasard ; on choisit le lieu desservi
  // par le plus de lignes, et on signale les autres.
  const routesAt = new Map(); // stop_id -> Set(route_id)
  for (const [routeId, list] of Object.entries(variants)) {
    for (const v of list) for (const sid of v.stops) {
      if (!routesAt.has(sid)) routesAt.set(sid, new Set());
      routesAt.get(sid).add(routeId);
    }
  }
  const idsByName = new Map(); // nom normalisé -> [stop_id]
  for (const [id, s] of Object.entries(stops)) {
    const k = norm(s.n);
    if (!idsByName.has(k)) idsByName.set(k, []);
    idsByName.get(k).push(id);
  }
  const PLACE_SPLIT_M = 800; // au-delà, deux arrêts de même nom sont deux lieux
  function pickNamed(hit) {
    const ids = idsByName.get(norm(hit.name)) ?? [hit.id];
    const places = [];
    for (const id of ids) {
      const s = stops[id];
      const p = places.find((x) => distM(x.lat, x.lon, s.lat, s.lon) <= PLACE_SPLIT_M);
      if (p) p.ids.push(id);
      else places.push({ lat: s.lat, lon: s.lon, ids: [id] });
    }
    if (places.length < 2) return { id: hit.id, homonymes: [] };
    for (const p of places) {
      p.routes = new Set(p.ids.flatMap((id) => [...(routesAt.get(id) ?? [])]));
      // représentant : le quai qui voit passer le plus de lignes
      p.best = [...p.ids].sort((a, b) => (routesAt.get(b)?.size ?? 0) - (routesAt.get(a)?.size ?? 0) || (a.startsWith('stop_point:') ? -1 : 1))[0];
    }
    places.sort((a, b) => b.routes.size - a.routes.size);
    const [top, ...others] = places;
    return {
      id: top.best,
      homonymes: others.map((p) => ({
        lat: round5(p.lat),
        lon: round5(p.lon),
        lignes: [...p.routes].map((r) => routeById.get(r)?.short_name ?? r),
        arret_id: p.best,
      })),
    };
  }
  const stopPlace = (hit, extra = {}) => {
    const { id, homonymes } = pickNamed(hit);
    const s = stops[id];
    return { kind: 'arret', stop_id: id, lat: s.lat, lon: s.lon, label: s.n, ...(homonymes.length ? { homonymes } : {}), ...extra };
  };

  // --- lieux --------------------------------------------------------------
  // Arrêts correspondant à un texte, en cherchant AUSSI sans le nom de
  // commune (« aéroport de Blagnac » → arrêt « Aéroport »).
  function stopHits(raw, n) {
    const hits = svc.searchStops(raw, n);
    const all = norm(raw).split(' ').filter((t) => t && !STOPWORDS.has(t));
    const sansCommune = all.filter((t) => !COMMUNES.has(t));
    const tokens = sansCommune.length ? sansCommune : all;
    if (tokens.length < all.length) {
      for (const h of svc.searchStops(tokens.join(' '), n)) if (!hits.some((x) => x.id === h.id)) hits.push(h);
    }
    return { hits, tokens };
  }

  // Ordre : coordonnées → id d'arrêt → nom d'arrêt (correspondance franche)
  // → adresse / lieu (géocodeur IGN) → nom d'arrêt approché.
  async function resolvePlace(q, { allowGeocode = true } = {}) {
    const raw = String(q ?? '').trim();
    if (!raw) throw new ToolError('Lieu vide.');
    const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = Number(m[1]), lon = Number(m[2]);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new ToolError(`Coordonnées invalides : « ${raw} » (attendu "lat,lon").`);
      return { kind: 'coordonnees', lat, lon, label: `${round5(lat)},${round5(lon)}` };
    }
    if (stops[raw]) return { kind: 'arret', stop_id: raw, lat: stops[raw].lat, lon: stops[raw].lon, label: stops[raw].n };

    const { hits, tokens } = stopHits(raw, 5);
    const strong = hits.find((h) => {
      const nt = norm(h.name).split(' ');
      return tokens.length > 0 && tokens.every((t) => nt.some((w) => w.startsWith(t) || (t.length >= 4 && t.startsWith(w) && w.length >= 4)));
    });
    // Une adresse (« 12 rue … ») ne doit pas être prise pour l'arrêt « Rue … ».
    const looksLikeAddress = /^\d+\s*(bis|ter)?\s+\S/.test(norm(raw)) || /\b(rue|avenue|av|allee|allees|boulevard|bd|chemin|impasse|place|route|quai)\b/.test(norm(raw)) && /\d/.test(raw);
    if (strong && !looksLikeAddress) return stopPlace(strong);
    if (allowGeocode && svc.geocode) {
      const near = (await geocodeServed(raw))[0];
      if (near) return { kind: near.type === 'poi' ? 'lieu' : 'adresse', lat: near.lat, lon: near.lon, label: near.label };
    }
    if (strong) return stopPlace(strong);
    if (hits[0]) return stopPlace(hits[0], { approx: true });
    throw new ToolError(`Lieu introuvable : « ${raw} ». Essayez un nom d'arrêt Tisséo, une adresse toulousaine ou des coordonnées "lat,lon".`);
  }
  // Géocodage restreint aux lieux desservis. Sans commune dans la requête,
  // on interroge AUSSI « <requête> Toulouse » : la requête nue d'abord (elle
  // respecte une commune citée), la variante toulousaine ensuite.
  async function geocodeServed(q) {
    const hasPlace = /\b\d{5}\b/.test(q) || norm(q).split(' ').some((t) => COMMUNES.has(t));
    const queries = hasPlace ? [q] : [q, `${q} Toulouse`];
    const lists = await Promise.all(queries.map((x) => svc.geocode(x).catch(() => [])));
    const out = [];
    const seen = new Set();
    for (const f of lists.flat()) {
      const k = `${f.lat.toFixed(4)},${f.lon.toFixed(4)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const stop = svc.nearestStopPoints(f.lat, f.lon, 1)[0];
      if (stop && stop.dist_m <= MAX_STOP_DIST_M) out.push(f);
    }
    return out;
  }

  const describePlace = (p) => ({
    type: p.kind,
    nom: p.label,
    ...(p.stop_id ? { arret_id: p.stop_id } : {}),
    lat: round5(p.lat),
    lon: round5(p.lon),
    ...(p.approx ? { attention: 'correspondance approximative : vérifiez que c\'est bien le lieu voulu' } : {}),
    ...(p.homonymes ? {
      homonymes: p.homonymes,
      note_homonymes: `D'autres arrêts portent ce nom ailleurs (${p.homonymes.length}) ; celui retenu est le plus desservi. Pour un autre, repassez son arret_id.`,
    } : {}),
  });

  // --- mise en forme ----------------------------------------------------------
  function situation(v) {
    if (v.status === 'terminus') return `au terminus ${v.at_stop ?? v.destination}`;
    if (v.status === 'at_stop' && v.at_stop) return `à l'arrêt ${v.at_stop}`;
    if (v.from && v.to) return `entre ${v.from} et ${v.to}`;
    return v.next_stop ? `en approche de ${v.next_stop}` : 'en circulation';
  }
  function vehicleBrief(v, t, extra = {}) {
    return {
      ligne: v.line,
      mode: v.mode,
      vehicule_id: String(v.id),
      destination: v.destination,
      situation: situation(v),
      prochain_arret: v.next_stop ?? null,
      prochain_passage: heure(v.next_time),
      dans_min: dansMin(v.next_time, t),
      lat: round5(v.lat),
      lon: round5(v.lon),
      cap_deg: v.bearing ?? null,
      ...extra,
    };
  }
  function departureBrief(d, t) {
    return {
      ligne: d.line,
      mode: d.mode,
      destination: d.destination,
      heure: heure(d.time),
      dans_min: dansMin(d.time, t),
      source: d.source === 'rt' ? 'temps réel' : 'horaire théorique',
      ...(d.vehicle ? { vehicule_id: String(d.vehicle) } : {}),
    };
  }

  async function live() {
    try {
      return await svc.live();
    } catch (err) {
      throw new ToolError(`Le flux temps réel de Tisséo est injoignable pour le moment (${err?.message || err}). Réessayez dans une minute.`);
    }
  }

  // Les horaires théoriques (métro, creux du temps réel) couvrent une fenêtre
  // publiée par Tisséo : on dit jusqu'où, et on prévient quand elle s'achève.
  function horairesValidite(t) {
    const until = svc.scheduleUntil?.();
    if (!until) return { horaires_theoriques: 'indisponibles' };
    const y = +until.slice(0, 4), mo = +until.slice(4, 6), d = +until.slice(6, 8);
    const joursRestants = Math.floor((parisToEpoch(y, mo, d, 23, 59) - t) / 86400);
    return {
      horaires_theoriques_jusquau: `${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y}`,
      ...(joursRestants < 0 ? { attention_horaires: 'Horaires théoriques EXPIRÉS : le métro et les creux du temps réel n\'ont plus d\'horaires.' }
        : joursRestants < 7 ? { attention_horaires: `Horaires théoriques valables encore ${joursRestants + 1} jour(s).` } : {}),
    };
  }

  const PRECISION ='Positions ESTIMÉES : Tisséo ne publie pas le GPS de ses véhicules ; chaque position est interpolée entre les deux arrêts qui l\'encadrent d\'après les horaires temps réel. Le métro (A, B) n\'est pas couvert par le temps réel.';

  // ---------------------------------------------------------------------------
  const tools = [];

  tools.push({
    name: 'vehicules',
    title: 'Véhicules en circulation',
    description: 'Liste les bus, trams et Téléo Tisséo en circulation à Toulouse en ce moment, avec leur position estimée, leur destination et leur prochain arrêt. Filtrable par ligne, par mode ou autour d\'un lieu. Sans filtre : tout le réseau, avec un résumé par ligne. Le métro n\'est pas couvert (pas de temps réel publié).',
    inputSchema: {
      type: 'object',
      properties: {
        ligne: { type: 'string', description: 'Numéro ou nom de ligne : "L1", "T1", "14", "TELEO"…' },
        mode: { type: 'string', enum: ['bus', 'tram', 'teleo'], description: 'Limiter à un mode.' },
        autour_de: { type: 'string', description: 'Lieu (arrêt, adresse ou "lat,lon") : ne garde que les véhicules proches, triés par distance.' },
        rayon_m: { type: 'integer', minimum: 100, maximum: 10000, description: 'Rayon autour du lieu, en mètres (défaut 800).' },
        limite: { type: 'integer', minimum: 1, maximum: 500, description: 'Nombre maximum de véhicules détaillés (défaut 150).' },
      },
      additionalProperties: false,
    },
    async handler({ ligne, mode, autour_de: autour, rayon_m: rayon = 800, limite = 150 }) {
      const c = await live();
      const t = now();
      let list = c.snap.vehicles;
      let lignes = null;
      if (ligne) {
        lignes = oneLine(ligne);
        const ids = new Set(lignes.map((r) => r.route_id));
        list = list.filter((v) => ids.has(v.route_id));
      }
      if (mode) list = list.filter((v) => norm(v.mode) === mode);
      let centre = null;
      let items;
      if (autour) {
        centre = await resolvePlace(autour);
        items = list
          .map((v) => ({ v, d: distM(centre.lat, centre.lon, v.lat, v.lon) }))
          .filter((x) => x.d <= rayon)
          .sort((a, b) => a.d - b.d)
          .map(({ v, d }) => vehicleBrief(v, t, { distance_m: Math.round(d) }));
      } else {
        items = [...list]
          .sort((a, b) => a.line.localeCompare(b.line, 'fr', { numeric: true }) || String(a.id).localeCompare(String(b.id), 'fr', { numeric: true }))
          .map((v) => vehicleBrief(v, t));
      }
      const parLigne = {};
      for (const v of list) parLigne[v.line] = (parLigne[v.line] ?? 0) + 1;
      const out = {
        heure: heure(t),
        donnees_de: heure(c.snap.rt_timestamp),
        total: items.length,
        ...(centre ? { autour_de: describePlace(centre), rayon_m: rayon } : {}),
        ...(lignes ? { lignes: lignes.map(lineLabel) } : {}),
        par_ligne: Object.fromEntries(Object.entries(parLigne).sort((a, b) => b[1] - a[1])),
        vehicules: items.slice(0, limite),
        ...(items.length > limite ? { tronque: `${items.length - limite} véhicules non détaillés : filtrez par ligne ou augmentez « limite ».` } : {}),
        precision: PRECISION,
      };
      if (c.stale) out.attention = 'Données temps réel en retard : le flux Tisséo ne répond plus, dernières données connues.';
      if (lignes && lignes.every((r) => modeOf(r) === 'Métro')) {
        out.attention = 'Le métro n\'a pas de temps réel publié : aucune position disponible. Utilisez « prochains_passages » pour ses horaires théoriques.';
      }
      return out;
    },
  });

  tools.push({
    name: 'vehicule',
    title: 'Détail d\'un véhicule',
    description: 'Détail d\'un véhicule précis (obtenu via « vehicules ») : position estimée, arrêts restants avec heures de passage, et trace de son parcours des dernières minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        ligne: { type: 'string', description: 'Ligne du véhicule ("L1", "T2"…).' },
        vehicule_id: { type: 'string', description: 'Identifiant renvoyé par « vehicules ».' },
        points_trace: { type: 'integer', minimum: 0, maximum: 150, description: 'Nombre de points de trace à renvoyer (défaut 20).' },
      },
      required: ['ligne', 'vehicule_id'],
      additionalProperties: false,
    },
    async handler({ ligne, vehicule_id: id, points_trace: nTrace = 20 }) {
      const c = await live();
      const t = now();
      const lignes = oneLine(ligne);
      const v = c.snap.vehicles.find((x) => lignes.some((r) => r.route_id === x.route_id) && String(x.id) === String(id));
      if (!v) throw new ToolError(`Véhicule ${id} introuvable sur ${lignes.map(lineLabel).join(', ')} : il a peut-être terminé sa course. Relancez « vehicules ».`);
      const trace = (svc.track(v.route_id, v.id) ?? []).slice(-nTrace).map((p) => ({ heure: heure(p.t), lat: round5(p.lat), lon: round5(p.lon) }));
      return {
        heure: heure(t),
        ...vehicleBrief(v, t),
        arrets_restants: (v.remaining ?? []).map((s) => ({ arret: s.name, heure: heure(s.time), dans_min: dansMin(s.time, t), ...(s.last ? { terminus: true } : {}) })),
        trace,
        precision: PRECISION,
      };
    },
  });

  tools.push({
    name: 'lignes',
    title: 'Lignes du réseau',
    description: 'Liste les lignes Tisséo (métro, tram, bus, Téléo) avec leur nom complet et le nombre de véhicules en circulation. Filtrable par mode ou par texte.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['metro', 'tram', 'bus', 'teleo'], description: 'Limiter à un mode.' },
        recherche: { type: 'string', description: 'Texte cherché dans le numéro ou le nom de la ligne (ex. "Blagnac", "L").' },
      },
      additionalProperties: false,
    },
    async handler({ mode, recherche }) {
      let c = null;
      try { c = await svc.live(); } catch { /* sans temps réel : la liste reste utile */ }
      let list = routes;
      if (mode) list = list.filter((r) => norm(modeOf(r)) === mode);
      if (recherche) {
        const q = norm(recherche);
        list = list.filter((r) => norm(r.short_name).startsWith(q) || norm(r.long_name).includes(q));
      }
      const order = { Métro: 0, Tram: 1, Téléo: 2, Bus: 3 };
      list = [...list].sort((a, b) => (order[modeOf(a)] ?? 9) - (order[modeOf(b)] ?? 9) || a.short_name.localeCompare(b.short_name, 'fr', { numeric: true }));
      return {
        total: list.length,
        lignes: list.map((r) => ({
          ligne: r.short_name,
          mode: modeOf(r),
          nom: r.long_name,
          vehicules_en_circulation: modeOf(r) === 'Métro' ? 'non publié' : (c?.snap?.perRoute?.[r.route_id] ?? 0),
        })),
      };
    },
  });

  tools.push({
    name: 'ligne',
    title: 'Parcours d\'une ligne',
    description: 'Parcours d\'une ligne : ses sens (terminus), la liste ordonnée de ses arrêts, et les perturbations qui la concernent.',
    inputSchema: {
      type: 'object',
      properties: { ligne: { type: 'string', description: 'Numéro ou nom de ligne ("A", "T1", "L6", "14"…).' } },
      required: ['ligne'],
      additionalProperties: false,
    },
    async handler({ ligne }) {
      const lignes = oneLine(ligne);
      let c = null;
      try { c = await svc.live(); } catch { /* perturbations indisponibles */ }
      return {
        lignes: lignes.map((r) => ({
          ligne: r.short_name,
          mode: modeOf(r),
          nom: r.long_name,
          sens: (variants[r.route_id] ?? []).map((v) => ({
            vers: v.headsign,
            arrets: v.stops.filter((id) => stops[id]).map((id) => stops[id].n),
          })),
          perturbations: (c?.snap?.alerts ?? []).filter((a) => (a.routes ?? []).includes(r.route_id)).map((a) => ({ titre: stripHtml(a.title), lien: a.url })),
        })),
      };
    },
  });

  tools.push({
    name: 'rechercher_lieu',
    title: 'Chercher un arrêt ou un lieu',
    description: 'Trouve les arrêts Tisséo correspondant à un nom, et, si c\'est une adresse ou un lieu (gare, aéroport, université…), sa position et les arrêts les plus proches. Utile pour lever une ambiguïté avant « prochains_passages » ou « itineraire ».',
    inputSchema: {
      type: 'object',
      properties: { recherche: { type: 'string', description: 'Nom d\'arrêt, adresse ou lieu.' } },
      required: ['recherche'],
      additionalProperties: false,
    },
    async handler({ recherche }) {
      const arrets = stopHits(recherche, 8).hits.slice(0, 8).map((s) => ({ nom: s.name, arret_id: s.id, lat: round5(s.lat), lon: round5(s.lon), desservi: s.served }));
      let lieux = [];
      if (svc.geocode) {
        try {
          lieux = (await geocodeServed(recherche))
            .slice(0, 3)
            .map((f) => ({
              nom: f.label,
              type: f.type === 'poi' ? 'lieu' : 'adresse',
              lat: round5(f.lat),
              lon: round5(f.lon),
              arrets_proches: svc.nearestStopPoints(f.lat, f.lon, 3).map((s) => ({ nom: s.name, arret_id: s.id, distance_m: s.dist_m })),
            }));
        } catch { /* géocodeur indisponible */ }
      }
      if (!arrets.length && !lieux.length) throw new ToolError(`Rien trouvé pour « ${recherche} ».`);
      return { arrets, lieux };
    },
  });

  tools.push({
    name: 'prochains_passages',
    title: 'Prochains passages à un arrêt',
    description: 'Prochains départs à un arrêt (tous quais confondus), en temps réel quand Tisséo le publie, sinon horaires théoriques (c\'est toujours le cas du métro). Accepte un nom d\'arrêt, un id, une adresse (arrêt le plus proche) ou "lat,lon".',
    inputSchema: {
      type: 'object',
      properties: {
        arret: { type: 'string', description: 'Nom d\'arrêt ("Capitole", "Jean Jaurès"), id, adresse ou "lat,lon".' },
        ligne: { type: 'string', description: 'Ne garder que cette ligne.' },
        nombre: { type: 'integer', minimum: 1, maximum: 30, description: 'Nombre de passages (défaut 10).' },
      },
      required: ['arret'],
      additionalProperties: false,
    },
    async handler({ arret, ligne, nombre = 10 }) {
      const p = await resolvePlace(arret);
      let stopId = p.stop_id;
      let viaNearest = null;
      if (!stopId) {
        const near = svc.nearestStopPoints(p.lat, p.lon, 1)[0];
        if (!near) throw new ToolError('Aucun arrêt à proximité.');
        stopId = near.id;
        viaNearest = near;
      }
      const c = await svc.liveOrNull();
      const t = now();
      const lignes = ligne ? oneLine(ligne) : null;
      let deps = svc.departuresAt(stopId, c, t, lignes ? 60 : nombre);
      if (lignes) {
        const ids = new Set(lignes.map((r) => r.route_id));
        deps = deps.filter((d) => ids.has(d.route_id));
      }
      deps = deps.slice(0, nombre);
      const out = {
        heure: heure(t),
        arret: { nom: stops[stopId].n, arret_id: stopId },
        interprete_comme: describePlace(p),
        ...(viaNearest ? { note: `Arrêt le plus proche de ce lieu, à ${viaNearest.dist_m} m.` } : {}),
        passages: deps.map((d) => departureBrief(d, t)),
      };
      if (!c?.snap) out.attention = 'Temps réel indisponible : horaires théoriques uniquement.';
      if (!deps.length) out.note = `${out.note ? `${out.note} ` : ''}Aucun passage dans les deux prochaines heures${lignes ? ` pour ${lignes.map(lineLabel).join(', ')}` : ''}.`;
      return out;
    },
  });

  tools.push({
    name: 'arrets_proches',
    title: 'Arrêts autour d\'un lieu',
    description: 'Les arrêts Tisséo les plus proches d\'un lieu (adresse, lieu connu, arrêt ou "lat,lon"), avec la distance à pied et leurs trois prochains passages.',
    inputSchema: {
      type: 'object',
      properties: {
        lieu: { type: 'string', description: 'Adresse, lieu, nom d\'arrêt ou "lat,lon".' },
        nombre: { type: 'integer', minimum: 1, maximum: 15, description: 'Nombre d\'arrêts (défaut 6).' },
      },
      required: ['lieu'],
      additionalProperties: false,
    },
    async handler({ lieu, nombre = 6 }) {
      const p = await resolvePlace(lieu);
      const c = await svc.liveOrNull();
      const t = now();
      return {
        heure: heure(t),
        interprete_comme: describePlace(p),
        arrets: svc.nearestStopPoints(p.lat, p.lon, nombre).map((s) => ({
          nom: s.name,
          arret_id: s.id,
          distance_m: s.dist_m,
          a_pied_min: Math.max(1, Math.round(s.dist_m / 75)),
          passages: svc.departuresAt(s.id, c, t, 3).map((d) => departureBrief(d, t)),
        })),
      };
    },
  });

  tools.push({
    name: 'itineraire',
    title: 'Calculer un itinéraire',
    description: 'Calcule un trajet en transports Tisséo entre deux lieux de l\'agglomération toulousaine : arrêts, adresses, lieux connus (gare Matabiau, aéroport, universités…) ou coordonnées "lat,lon". Renvoie les étapes (marche, lignes à prendre, direction, arrêts de montée et de descente), les heures et le nombre de correspondances. Départ immédiat par défaut, ou à l\'heure indiquée.',
    inputSchema: {
      type: 'object',
      properties: {
        depart: { type: 'string', description: 'Lieu de départ.' },
        arrivee: { type: 'string', description: 'Lieu d\'arrivée.' },
        heure_depart: { type: 'string', description: 'Heure de départ, fuseau de Paris : "08:15", "8h15" ou "2026-09-29T08:15". Défaut : maintenant.' },
      },
      required: ['depart', 'arrivee'],
      additionalProperties: false,
    },
    async handler({ depart, arrivee, heure_depart: hd }) {
      const t0 = now();
      const at = parseHeure(hd, t0);
      const [from, to] = await Promise.all([resolvePlace(depart), resolvePlace(arrivee)]);
      const ep = (p) => (p.stop_id ? { stop_id: p.stop_id } : { lat: p.lat, lon: p.lon, label: p.label });
      const r = await svc.journey(ep(from), ep(to), at);
      if (!r || r.error) {
        throw new ToolError(`${r?.error ?? 'Aucun itinéraire trouvé'} (départ compris comme « ${from.label} », arrivée comme « ${to.label} »).`);
      }
      // Deux marches qui se suivent (accès à l'arrêt + passage à un arrêt
      // voisin) n'en font qu'une ; un simple changement de quai au tout début
      // ou à la toute fin n'est pas une étape pour le voyageur.
      const legs = [];
      for (const l of r.legs) {
        const last = legs[legs.length - 1];
        if (l.type === 'walk' && last?.type === 'walk') legs[legs.length - 1] = { ...last, to: l.to, seconds: last.seconds + l.seconds };
        else legs.push(l);
      }
      const quaiSeul = (l) => l?.type === 'walk' && norm(l.from) === norm(l.to) && l.seconds <= 240;
      let clock = at;
      if (quaiSeul(legs[0])) clock += legs.shift().seconds;
      if (quaiSeul(legs[legs.length - 1])) legs.pop();
      const etapes = [];
      for (const l of legs) {
        if (l.type === 'walk') {
          const min = Math.max(1, Math.round(l.seconds / 60));
          const memeArret = norm(l.from) === norm(l.to);
          etapes.push({
            type: memeArret ? 'correspondance' : 'marche',
            de: l.from,
            vers: l.to,
            duree_min: min,
            instruction: memeArret ? `Changer de quai à ${l.from} (${min} min à pied).` : `Marcher ${min} min de ${l.from} à ${l.to}.`,
          });
          clock += l.seconds;
          continue;
        }
        const attente = Math.max(0, Math.round((l.depart - clock) / 60));
        const direction = headsignFor(l.route_id, l.from_id, l.to_id);
        etapes.push({
          type: 'trajet',
          ligne: l.line,
          mode: l.mode,
          ...(direction ? { direction } : {}),
          monter_a: l.from,
          descendre_a: l.to,
          depart: heure(l.depart),
          arrivee: heure(l.arrive),
          duree_min: Math.max(1, Math.round(l.seconds / 60)),
          ...(attente ? { attente_min: attente } : {}),
          horaires: l.real ? 'temps réel' : (l.scheduled ? 'horaire théorique' : 'estimés (durée de trajet, sans horaire de passage)'),
          instruction: `Prendre ${l.mode.toLowerCase()} ${l.line}${direction ? ` direction ${direction}` : ''} à ${l.from} (${heure(l.depart)}), descendre à ${l.to} (${heure(l.arrive)}).`,
        });
        clock = l.arrive;
      }
      const p = parisParts(at);
      const q = parisParts(t0);
      const autreJour = p.y !== q.y || p.mo !== q.mo || p.d !== q.d;
      return {
        depart: describePlace(from),
        arrivee: describePlace(to),
        ...(autreJour ? { jour: fmtDay.format(new Date(at * 1000)) } : {}),
        partir_a: heure(r.depart_at),
        arriver_a: heure(r.arrive_at),
        duree_min: Math.round(r.duration_s / 60),
        correspondances: r.transfers,
        etapes,
        ...(r.out_of_service ? { attention: 'Aucun trajet trouvé avec les seules lignes en service à cette heure : cet itinéraire utilise des lignes peut-être déjà arrêtées (service de nuit réduit). Vérifiez les horaires.' } : {}),
        fiabilite: r.real
          ? 'Toutes les correspondances sont calées sur le temps réel.'
          : 'Une partie des horaires est théorique ou estimée : prévoyez une marge. Itinéraire calculé par Tisséo Live (pas par Tisséo) ; en cas de doute, vérifier sur tisseo.fr.',
      };
    },
  });

  tools.push({
    name: 'perturbations',
    title: 'Perturbations et infos trafic',
    description: 'Perturbations en cours ou annoncées sur le réseau Tisséo (travaux, manifestations, déviations…), en texte brut. Filtrable par ligne.',
    inputSchema: {
      type: 'object',
      properties: {
        ligne: { type: 'string', description: 'Ne garder que les perturbations de cette ligne.' },
        detail: { type: 'boolean', description: 'Inclure le texte complet (défaut : oui avec une ligne, non sinon).' },
      },
      additionalProperties: false,
    },
    async handler({ ligne, detail }) {
      const c = await live();
      let list = c.snap.alerts;
      const lignes = ligne ? oneLine(ligne) : null;
      if (lignes) {
        const ids = new Set(lignes.map((r) => r.route_id));
        list = list.filter((a) => (a.routes ?? []).some((id) => ids.has(id)));
      }
      const full = detail ?? Boolean(lignes);
      return {
        total: list.length,
        perturbations: list.map((a) => ({
          titre: stripHtml(a.title),
          lignes: (a.routes ?? []).map((id) => routeById.get(id)?.short_name ?? id),
          ...(full ? { texte: stripHtml(a.description).slice(0, 2500) } : {}),
          lien: a.url,
        })),
        ...(lignes && !list.length ? { note: `Aucune perturbation signalée spécifiquement pour ${lignes.map(lineLabel).join(', ')} (des perturbations générales peuvent exister : rappelez sans « ligne »).` } : {}),
      };
    },
  });

  tools.push({
    name: 'etat_du_reseau',
    title: 'État du service',
    description: 'Vue d\'ensemble instantanée : nombre de véhicules en circulation par mode, lignes actives, fraîcheur des données temps réel, nombre de perturbations.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const c = await live();
      const t = now();
      const parMode = {};
      for (const v of c.snap.vehicles) parMode[v.mode] = (parMode[v.mode] ?? 0) + 1;
      return {
        heure: heure(t),
        donnees_de: heure(c.snap.rt_timestamp),
        age_donnees_s: t - c.snap.rt_timestamp,
        vehicules: c.snap.vehicles.length,
        par_mode: parMode,
        lignes_actives: Object.keys(c.snap.perRoute).length,
        perturbations: c.snap.alerts.length,
        ...horairesValidite(t),
        ...(c.stale ? { attention: 'Flux Tisséo en retard : dernières données connues.' } : {}),
        precision: PRECISION,
      };
    },
  });

  return tools;
}

export const INSTRUCTIONS = [
  'Réseau de transports en commun de Toulouse (Tisséo) : métro A et B, tram T1, téléphérique Téléo, navette Aéroport, bus (Linéo L1…L14 et lignes numérotées). Appelle « lignes » pour la liste à jour.',
  'Les heures sont en heure de Paris. Les positions des véhicules sont ESTIMÉES d\'après les horaires temps réel (Tisséo ne publie pas le GPS) ; le métro n\'a pas de temps réel.',
  'Pour un trajet, appelle directement « itineraire » avec les lieux tels que l\'utilisateur les dit (adresse, lieu connu ou arrêt) ; vérifie « interprete_comme » dans la réponse et signale à l\'utilisateur si le lieu compris n\'est pas le bon.',
  'Pour « quand passe le prochain… », utilise « prochains_passages ». Pour « où est le bus / combien de trams roulent », utilise « vehicules ». Pour les travaux et grèves, « perturbations ».',
  'Données : Tisséo / Toulouse Métropole (licence ODbL), géocodage IGN Géoplateforme.',
].join('\n');
