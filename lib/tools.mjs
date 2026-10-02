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
import { tripDelay } from './realtime.mjs';
import { pairTimes } from './schedules.mjs';

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

const dansTexte = (m) => (m == null ? '' : m === 0 ? ' (imminent)' : ` (dans ${m} min)`);
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

// --- jours et grilles horaires -------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
export const ymdOf = (t) => { const p = parisParts(t); return `${p.y}${pad2(p.mo)}${pad2(p.d)}`; };
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

// « aujourd'hui », « demain », « samedi » (le prochain), « 2026-10-03 »,
// « 03/10 » ou « 03/10/2026 » → { ymd, midi (epoch 12 h, sert à nommer le
// jour), label }.
export function parseJour(raw, now) {
  const p = parisParts(now);
  const at = (y, mo, d) => {
    const t = parisToEpoch(y, mo, d, 12, 0);
    const q = parisParts(t);
    return { ymd: `${q.y}${pad2(q.mo)}${pad2(q.d)}`, midi: t, label: fmtDay.format(new Date(t * 1000)) };
  };
  if (raw === undefined || raw === null || raw === '') return at(p.y, p.mo, p.d);
  const s = norm(raw);
  if (s === 'aujourd hui' || s === 'aujourdhui' || s === 'ce jour') return at(p.y, p.mo, p.d);
  if (s === 'demain') return at(p.y, p.mo, p.d + 1);
  if (s === 'apres demain') return at(p.y, p.mo, p.d + 2);
  const wd = JOURS.indexOf(s.replace(/^(ce|le|prochain)\s+/, '').replace(/\s+prochain$/, ''));
  if (wd >= 0) {
    const today = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
    return at(p.y, p.mo, p.d + ((wd - today + 7) % 7));
  }
  let m = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return at(+m[1], +m[2], +m[3]);
  m = String(raw).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (m) return at(m[3] ? +m[3] : p.y, +m[2], +m[1]);
  throw new ToolError(`Jour non compris : « ${raw} ». Formats : "aujourd'hui", "demain", "samedi", "2026-10-03", "03/10".`);
}

// Secondes depuis minuit (peut dépasser 24 h : service après minuit) → « 00:35 ».
export const fmtSec = (sec) => `${pad2(Math.floor(sec / 3600) % 24)}:${pad2(Math.floor((sec % 3600) / 60))}`;

// Tranches de la journée pour résumer une fréquence : un voyageur demande
// « toutes les combien à l'heure de pointe », pas une liste de 300 horaires.
const TRANCHES = [
  ['début de service (avant 7 h)', 0, 7],
  ['pointe du matin (7 h – 9 h)', 7, 9],
  ['journée (9 h – 16 h)', 9, 16],
  ['pointe du soir (16 h – 19 h)', 16, 19],
  ['soirée (19 h – 22 h)', 19, 22],
  ['fin de service (après 22 h)', 22, 30],
];
export function frequences(times) {
  const out = {};
  for (const [label, h0, h1] of TRANCHES) {
    const ts = times.filter((x) => x >= h0 * 3600 && x < h1 * 3600);
    if (!ts.length) continue;
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    gaps.sort((a, b) => a - b);
    const med = gaps.length ? gaps[gaps.length >> 1] : null;
    out[label] = {
      passages: ts.length,
      ...(med ? { toutes_les_min: Math.max(1, Math.round(med / 60)) } : {}),
    };
  }
  return out;
}

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
  // Tous les quais d'un même lieu : même nom, à moins de PLACE_SPLIT_M.
  function placeGroup(stopId) {
    const s = stops[stopId];
    if (!s) return [stopId];
    return (idsByName.get(norm(s.n)) ?? [stopId]).filter((id) => distM(s.lat, s.lon, stops[id].lat, stops[id].lon) <= PLACE_SPLIT_M);
  }

  // Grille horaire théorique d'un lieu (tous quais) pour un jour donné :
  // [{ route, dir, destination, times[] (s depuis minuit, triées) }].
  function timetable(stopIds, ymd) {
    const pis = new Set(svc.patternsOn?.(ymd) ?? []);
    const acc = new Map();
    for (const id of stopIds) {
      for (const e of svc.scheduleEntries?.(id) ?? []) {
        const k = `${e.route_id}|${e.dir}`;
        let a = acc.get(k);
        if (!a) { a = { route_id: e.route_id, dir: e.dir, destination: e.destination, times: new Set() }; acc.set(k, a); }
        for (const pi of pis) for (const x of e.perPat?.[pi] ?? []) a.times.add(x);
      }
    }
    return [...acc.values()]
      .map((a) => ({ ...a, times: [...a.times].sort((x, y) => x - y) }))
      .filter((a) => a.times.length);
  }

  // Tarif d'un ensemble de lignes (GTFS fare_rules / fare_attributes). Un
  // ticket vaut 1 h (1 h 30 pour la navette aéroport), correspondances
  // comprises ; le plus cher des tarifs des lignes empruntées s'applique.
  const euros = (x) => `${x.toFixed(2).replace('.', ',')} €`;
  function fareFor(routeIds, dureeS = 0) {
    const F = svc.fares;
    if (!F?.fares?.length) return null;
    const byId = new Map(F.fares.map((f) => [f.id, f]));
    let avant = null, bord = null;
    for (const rid of routeIds) {
      for (const fid of F.routes?.[rid] ?? []) {
        const f = byId.get(fid);
        if (!f) continue;
        if (f.on_board) { if (!bord || f.price > bord.price) bord = f; }
        else if (!avant || f.price > avant.price) avant = f;
      }
    }
    const ref = avant ?? bord;
    if (!ref) return null;
    const tickets = ref.duration_s && dureeS > ref.duration_s ? Math.ceil(dureeS / ref.duration_s) : 1;
    return {
      ticket: avant ? euros(avant.price) : null,
      achete_a_bord: bord ? euros(bord.price) : null,
      validite_min: ref.duration_s ? Math.round(ref.duration_s / 60) : null,
      correspondances_incluses: ref.transfers,
      ...(tickets > 1 ? { attention: `Trajet plus long que la validité d'un ticket : ${tickets} tickets.` } : {}),
      note: 'Tarif plein d\'après les données publiées par Tisséo ; abonnements, tarifs réduits et Pastel ne sont pas publiés.',
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
    // Un résultat obtenu en AJOUTANT « Toulouse » doit encore répondre à ce
    // qui était demandé. Sans cela, n'importe quel texte (« xqzwvk ») trouve
    // la commune « Toulouse » elle-même — et l'on enregistrait, ou calculait,
    // un trajet vers le centre-ville à la place d'un lieu qui n'existe pas.
    const mots = norm(q).split(' ').filter((t) => t.length >= 3 && !/^\d+$/.test(t));
    const repond = (f) => {
      if (!mots.length) return true;
      const libelle = norm(f.label).split(' ');
      return mots.some((t) => libelle.some((w) => w.startsWith(t) || (w.length >= 4 && t.startsWith(w))));
    };
    const out = [];
    const seen = new Set();
    for (const [i, f] of lists.flatMap((l, n) => l.map((x) => [n, x]))) {
      if (i > 0 && !repond(f)) continue;
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
    if (v.from && v.to && norm(v.from) === norm(v.to)) return `à l'approche de ${v.to}`;
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
      ...vehicleTiming(v, t),
      ...extra,
    };
  }
  // Provenance et retard d'un véhicule : la position est INTERPOLÉE entre
  // deux heures temps réel, ou déduite des horaires théoriques (métro).
  function vehicleTiming(v, t, rx = rtx()) {
    if (sourceOf(v) === 'horaire théorique') return { source: 'gtfs', note_source: 'position d\'après les horaires théoriques (pas de temps réel)' };
    const trip = rx?.vehicles.get(`${v.route_id}|${v.id}`);
    const delay = tripDelay(trip, t);
    const ts = trip?.ts ?? rx?.feedTs ?? null;
    return {
      source: 'interpolation',
      ...(delay != null ? { retard_sec: delay, ponctualite: retardTexte(delay) } : {}),
      ...(ts ? { age_donnees_sec: Math.max(0, t - ts) } : {}),
    };
  }
  // Le métro n'a pas de temps réel : s'il apparaît, c'est reconstitué d'après
  // les horaires théoriques. On le dit par véhicule, pas seulement en note.
  const isMetro = (v) => norm(v.mode) === 'metro';
  function sourceOf(v) {
    if (v.theoretical) return 'horaire théorique';
    if (v.source && /theori|schedule|gtfs|horaire/i.test(String(v.source))) return 'horaire théorique';
    return isMetro(v) ? 'horaire théorique' : 'estimée (temps réel)';
  }
  function precisionFor(list) {
    return list.some(isMetro)
      ? `${PRECISION_BASE} Les rames de MÉTRO n'ont pas de temps réel : elles sont placées d'après les horaires théoriques (sans retards ni incidents).`
      : `${PRECISION_BASE} Le métro n'apparaît pas tant que ses rames ne sont pas reconstituées d'après les horaires.`;
  }
  // --- provenance, retard, jour de service ------------------------------------
  // Chaque horaire dit d'où il vient, par un code stable :
  //   realtime      heure publiée par le temps réel de Tisséo
  //   gtfs          horaire théorique publié (sans retards)
  //   interpolation position ou heure déduite entre deux données réelles
  //   estimation    durée calculée (aucun horaire ne la publie)
  const rtx = () => { try { return svc.rtIndex?.() ?? null; } catch { return null; } };
  const isoDay = (ymd) => (ymd ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null);
  const midnightOf = (ymd) => parisToEpoch(+ymd.slice(0, 4), +ymd.slice(4, 6), +ymd.slice(6, 8), 0, 0);
  const prevYmd = (ymd) => ymdOf(midnightOf(ymd) - 12 * 3600);
  // Jour de SERVICE d'un horaire théorique : à 00:25, c'est souvent le
  // service de la veille (25:25 dans le GTFS). La veille d'abord.
  function serviceDayOf(stopId, routeId, schedT) {
    const civil = ymdOf(schedT);
    const entries = (svc.scheduleEntries?.(stopId) ?? []).filter((e) => e.route_id === routeId);
    for (const day of [prevYmd(civil), civil]) {
      const secs = schedT - midnightOf(day);
      for (const pi of svc.patternsOn?.(day) ?? []) {
        for (const e of entries) if ((e.perPat?.[pi] ?? []).some((x) => Math.abs(x - secs) <= 60)) return day;
      }
    }
    return null;
  }
  const retardTexte = (s) => {
    if (s == null) return null;
    const m = Math.round(Math.abs(s) / 60);
    if (m === 0) return 'à l\'heure';
    return s > 0 ? `retard de ${m} min` : `avance de ${m} min`;
  };
  // Heure théorique, retard, âge et jour de service d'un passage à un quai.
  function timing(d, t, rx = rtx()) {
    if (d.source === 'rt') {
      const st = d.trip_id && d.stop_id ? rx?.stopTimes.get(`${d.trip_id}|${d.stop_id}`) : null;
      const delay = st?.delay ?? null;
      const sched = delay != null ? d.time - delay : null;
      const ts = st?.ts ?? rx?.feedTs ?? null;
      return {
        source: 'realtime', delay, sched, age: ts ? Math.max(0, t - ts) : null,
        serviceDay: sched != null && d.stop_id ? serviceDayOf(d.stop_id, d.route_id, sched) : null,
      };
    }
    return { source: 'gtfs', delay: null, sched: d.time, age: null, serviceDay: d.service_day ?? null };
  }
  function timingFields(time, tm, t) {
    const civil = ymdOf(time);
    return {
      source: tm.source,
      ...(tm.sched != null ? { horaire_theorique: heure(tm.sched) } : {}),
      ...(tm.source === 'realtime' ? { horaire_estime: heure(time) } : {}),
      ...(tm.delay != null ? { retard_sec: tm.delay, ponctualite: retardTexte(tm.delay) } : {}),
      ...(tm.age != null ? { age_donnees_sec: tm.age } : {}),
      ...(tm.serviceDay && tm.serviceDay !== civil ? { jour_service: isoDay(tm.serviceDay), note_jour: `passage après minuit rattaché au service du ${isoDay(tm.serviceDay)}` } : {}),
    };
  }
  function departureBrief(d, t, rx = rtx()) {
    const tm = timing(d, t, rx);
    return {
      ligne: d.line,
      mode: d.mode,
      destination: d.destination,
      heure: heure(d.time),
      dans_min: dansMin(d.time, t),
      ...timingFields(d.time, tm, t),
      ...(d.vehicle ? { vehicule_id: String(d.vehicle) } : {}),
    };
  }

  // Un horaire théorique dont la course est déjà suivie en temps réel (même
  // ligne, horaire théorique retrouvé grâce au retard publié) est un doublon.
  function dedupeBySched(deps, t, rx = rtx()) {
    const scheds = deps.filter((d) => d.source === 'rt').map((d) => ({ d, tm: timing(d, t, rx) })).filter((x) => x.tm.sched != null);
    return deps.filter((d) => d.source === 'rt' || !scheds.some((x) => x.d.route_id === d.route_id && Math.abs(x.tm.sched - d.time) <= 60
      && norm(x.d.destination) === norm(d.destination)));
  }

  // Ponctualité instantanée : retard de chaque course en circulation (au
  // prochain arrêt), agrégé. « À l'heure » = moins de 2 min d'écart.
  function punctuality(t, keepRoute = () => true, rx = rtx()) {
    const per = new Map();
    for (const trip of rx?.trips.values() ?? []) {
      if (!trip.route_id || !keepRoute(trip.route_id)) continue;
      const next = trip.stops.find((x) => x.t >= t - 30);
      if (!next || next.t > t + 3600 || trip.stops[0].t > t) continue; // pas encore partie
      const d = tripDelay(trip, t);
      if (d == null) continue;
      (per.get(trip.route_id) ?? per.set(trip.route_id, []).get(trip.route_id)).push(d);
    }
    const all = [...per.values()].flat();
    if (!all.length) return null;
    const mean = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    const lignes = [...per].map(([id, xs]) => ({ ligne: routeById.get(id)?.short_name ?? id, courses: xs.length, retard_moyen_sec: mean(xs), en_retard_de_plus_de_5_min: xs.filter((x) => x > 300).length }))
      .sort((a, b) => b.retard_moyen_sec - a.retard_moyen_sec);
    return {
      courses_suivies: all.length,
      a_l_heure_pct: Math.round((100 * all.filter((x) => Math.abs(x) <= 120).length) / all.length),
      retard_moyen_sec: mean(all),
      en_retard_de_plus_de_5_min: all.filter((x) => x > 300).length,
      lignes,
      note: 'Instantané calculé sur les courses en circulation publiées avec un retard (hors métro, sans temps réel). À l\'heure = moins de 2 min d\'écart.',
    };
  }

  // --- sens de circulation -------------------------------------------------------
  // Arrêts qu'un passage desservira APRÈS le quai où on le prend : la course
  // temps réel quand on l'a, sinon les parcours de la ligne dans ce sens.
  function downstreamIds(d, rx = rtx()) {
    const trip = d.trip_id ? rx?.trips.get(d.trip_id) : null;
    if (trip) {
      const i = trip.stops.findIndex((s) => s.id === d.stop_id);
      if (i >= 0) return trip.stops.slice(i + 1).map((s) => s.id);
    }
    const out = new Set();
    for (const v of variants[d.route_id] ?? []) {
      if (d.dir != null && v.dir != null && String(v.dir) !== String(d.dir)) continue;
      if (d.dir == null && d.destination && norm(v.headsign) !== norm(d.destination)) continue;
      const i = v.stops.indexOf(d.stop_id);
      if (i >= 0) for (const id of v.stops.slice(i + 1)) out.add(id);
    }
    return [...out];
  }
  // « direction » : texte du terminus (« Fenouillet ») OU arrêt desservi
  // plus loin dans ce sens. C'est ce qui écarte le bus qui revient.
  function goesToward(d, text, rx) {
    const q = norm(text);
    if (!q) return true;
    if (norm(d.destination).includes(q)) return true;
    return downstreamIds(d, rx).some((id) => stops[id] && norm(stops[id].n).includes(q));
  }
  // Un passage qui ARRIVE au terminus ici ne part vers nulle part.
  const endsHere = (d, stopId) => norm(d.destination) === norm(stops[stopId]?.n);

  // Passages des 15 dernières minutes : « le 00:25 est parti il y a 3 min ».
  // Un horaire théorique passé n'est « parti » que si aucun véhicule en
  // approche ne correspond à cet horaire (sinon il est juste en retard).
  const MISSED_WINDOW_S = 15 * 60;
  function recentlyGone(group, t, keep, upcoming, rx = rtx()) {
    const lateScheds = upcoming.map((d) => timing(d, t, rx)).filter((x) => x.sched != null && x.source === 'realtime').map((x) => x.sched);
    const rtRoutes = new Set([...(rx?.trips.values() ?? [])].map((x) => x.route_id));
    const out = [];
    const seen = new Set();
    // Départs CONFIRMÉS : une course temps réel qui a déjà desservi le quai.
    const groupSet = new Set(group);
    const goneScheds = [];
    for (const trip of rx?.trips.values() ?? []) {
      for (const s of trip.stops) {
        if (!groupSet.has(s.id) || s.d >= t || s.d < t - MISSED_WINDOW_S) continue;
        const last = trip.stops[trip.stops.length - 1];
        const d = { source: 'rt', trip_id: trip.trip_id, stop_id: s.id, route_id: trip.route_id, time: s.d, destination: stops[last.id]?.n, line: routeById.get(trip.route_id)?.short_name ?? trip.route_id };
        if (last.id === s.id || !keep(d)) continue;
        if (s.delay != null) goneScheds.push(s.d - s.delay);
        out.push({
          ligne: d.line,
          destination: d.destination,
          heure: heure(s.d),
          ...(s.delay != null ? { horaire_theorique: heure(s.d - s.delay), retard_sec: s.delay } : {}),
          il_y_a_min: Math.max(1, Math.round((t - s.d) / 60)),
          source: 'realtime',
          statut: 'parti (confirmé par le temps réel)',
        });
      }
    }
    for (const sid of group) {
      for (const d of svc.scheduleAt?.(sid, t - MISSED_WINDOW_S, 80, MISSED_WINDOW_S) ?? []) {
        if (d.time >= t) continue;
        const dd = { ...d, stop_id: d.stop_id ?? sid };
        if (!keep(dd)) continue;
        const k = `${d.route_id}|${d.dir}|${d.time}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (lateScheds.some((s) => Math.abs(s - d.time) <= 60)) continue; // en retard, pas parti
        if (goneScheds.some((s) => Math.abs(s - d.time) <= 60)) continue; // déjà compté, confirmé
        out.push({
          ligne: d.line,
          destination: d.destination,
          horaire_theorique: heure(d.time),
          il_y_a_min: Math.max(1, Math.round((t - d.time) / 60)),
          source: 'gtfs',
          statut: rtRoutes.has(d.route_id)
            ? 'passé : aucun véhicule en approche ne correspond à cet horaire'
            : 'probablement passé (horaire théorique, pas de temps réel pour confirmer)',
        });
      }
    }
    return out.sort((a, b) => a.il_y_a_min - b.il_y_a_min);
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

  const PRECISION_BASE = 'Positions ESTIMÉES : Tisséo ne publie pas le GPS de ses véhicules ; chaque position est interpolée entre les deux arrêts qui l\'encadrent.';
  const PRECISION = `${PRECISION_BASE} Le métro (A, B) n'a pas de temps réel.`;

  // ---------------------------------------------------------------------------
  const tools = [];

  tools.push({
    name: 'vehicules',
    title: 'Véhicules en circulation',
    description: 'Liste les véhicules Tisséo en circulation à Toulouse en ce moment (bus, Linéo, tram, Téléo, et métro quand ses rames sont reconstituées d\'après les horaires) : position estimée, destination, arrêt actuel ou tronçon, prochain arrêt et heure. Filtrable par ligne, mode, destination ou autour d\'un lieu. Sans filtre : tout le réseau, avec un décompte par ligne.',
    inputSchema: {
      type: 'object',
      properties: {
        ligne: { type: 'string', description: 'Numéro ou nom de ligne : "L1", "T1", "14", "TELEO"…' },
        mode: { type: 'string', enum: ['bus', 'tram', 'teleo', 'metro'], description: 'Limiter à un mode.' },
        destination: { type: 'string', description: 'Ne garder que les véhicules allant vers ce terminus (texte contenu, ex. "Balma").' },
        autour_de: { type: 'string', description: 'Lieu (arrêt, adresse ou "lat,lon") : ne garde que les véhicules proches, triés par distance.' },
        rayon_m: { type: 'integer', minimum: 100, maximum: 10000, description: 'Rayon autour du lieu, en mètres (défaut 800).' },
        limite: { type: 'integer', minimum: 1, maximum: 500, description: 'Nombre maximum de véhicules détaillés (défaut 150).' },
      },
      additionalProperties: false,
    },
    async handler({ ligne, mode, destination, autour_de: autour, rayon_m: rayon = 800, limite = 150 }) {
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
      if (destination) list = list.filter((v) => norm(v.destination).includes(norm(destination)));
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
        precision: precisionFor(list),
      };
      if (c.stale) out.attention = 'Données temps réel en retard : le flux Tisséo ne répond plus, dernières données connues.';
      if (lignes && lignes.every((r) => modeOf(r) === 'Métro') && !list.length) {
        out.attention = 'Aucune rame de métro disponible pour le moment (pas de temps réel publié, et reconstitution d\'après les horaires absente ou hors service). Utilisez « prochains_passages » ou « horaires ».';
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
      const trip = rtx()?.vehicles.get(`${v.route_id}|${v.id}`);
      const trace = (svc.track(v.route_id, v.id) ?? []).slice(-nTrace).map((p) => ({ heure: heure(p.t), lat: round5(p.lat), lon: round5(p.lon) }));
      return {
        heure: heure(t),
        ...vehicleBrief(v, t),
        arrets_restants: (v.remaining ?? []).map((s) => {
          const st = trip?.stops.find((x) => x.id === s.id);
          return {
            arret: s.name,
            heure: heure(s.time),
            dans_min: dansMin(s.time, t),
            ...(st?.delay != null ? { horaire_theorique: heure(s.time - st.delay), retard_sec: st.delay } : {}),
            ...(s.last ? { terminus: true } : {}),
          };
        }),
        trace,
        precision: precisionFor([v]),
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
          vehicules_en_circulation: c?.snap ? c.snap.vehicles.filter((v) => v.route_id === r.route_id).length : null,
          tarif: fareFor([r.route_id])?.ticket ?? null,
        })),
      };
    },
  });

  tools.push({
    name: 'ligne',
    title: 'Parcours d\'une ligne',
    description: 'Fiche complète d\'une ligne : ses sens et terminus, la liste ordonnée de ses arrêts (avec accessibilité en fauteuil), la longueur du parcours, l\'amplitude du jour (premier et dernier départ), la fréquence par tranche horaire (pointe, journée, soirée), le tarif, les véhicules en circulation et les perturbations.',
    inputSchema: {
      type: 'object',
      properties: {
        ligne: { type: 'string', description: 'Numéro ou nom de ligne ("A", "T1", "L6", "14"…).' },
        jour: { type: 'string', description: 'Jour pour l\'amplitude et les fréquences : "aujourd\'hui" (défaut), "demain", "samedi", "2026-10-03".' },
        avec_arrets: { type: 'boolean', description: 'Inclure la liste des arrêts (défaut : oui).' },
      },
      required: ['ligne'],
      additionalProperties: false,
    },
    async handler({ ligne, jour, avec_arrets: avecArrets = true }) {
      const lignes = oneLine(ligne);
      const j = parseJour(jour, now());
      let c = null;
      try { c = await svc.live(); } catch { /* perturbations indisponibles */ }
      return {
        jour: j.label,
        lignes: lignes.map((r) => {
          const vs = variants[r.route_id] ?? [];
          const arretsIds = [...new Set(vs.flatMap((v) => v.stops))].filter((id) => stops[id]);
          const acc = arretsIds.filter((id) => stops[id].w === 1).length;
          const nonAcc = arretsIds.filter((id) => stops[id].w === 2).length;
          return {
            ligne: r.short_name,
            mode: modeOf(r),
            nom: r.long_name,
            vehicules_en_circulation: c?.snap ? c.snap.vehicles.filter((v) => v.route_id === r.route_id).length : null,
            tarif: fareFor([r.route_id]),
            ...(() => { const p = punctuality(now(), (id) => id === r.route_id); return p ? { ponctualite_actuelle: { courses_suivies: p.courses_suivies, a_l_heure_pct: p.a_l_heure_pct, retard_moyen_sec: p.retard_moyen_sec, en_retard_de_plus_de_5_min: p.en_retard_de_plus_de_5_min } } : {}; })(),
            ...(acc + nonAcc ? { accessibilite: `${acc} arrêt(s) accessible(s) en fauteuil, ${nonAcc} non accessible(s), ${arretsIds.length - acc - nonAcc} non renseigné(s)` } : {}),
            sens: vs.map((v) => {
              const first = v.stops.find((id) => stops[id]);
              const tt = first ? timetable([first], j.ymd).filter((x) => x.route_id === r.route_id && x.dir === v.dir) : [];
              const times = [...new Set(tt.flatMap((x) => x.times))].sort((a, b) => a - b);
              let km = 0;
              for (let i = 1; i < (v.shape?.length ?? 0); i++) km += distM(v.shape[i - 1][0], v.shape[i - 1][1], v.shape[i][0], v.shape[i][1]) / 1000;
              return {
                vers: v.headsign,
                depart_de: first ? stops[first].n : null,
                nombre_arrets: v.stops.length,
                ...(km ? { longueur_km: Math.round(km * 10) / 10 } : {}),
                ...(times.length ? {
                  premier_depart: fmtSec(times[0]),
                  dernier_depart: fmtSec(times[times.length - 1]),
                  departs_du_jour: times.length,
                  frequences: frequences(times),
                } : { service: 'aucun départ théorique ce jour-là' }),
                ...(avecArrets ? {
                  arrets: v.stops.filter((id) => stops[id]).map((id) => (stops[id].w === 2 ? `${stops[id].n} (non accessible)` : stops[id].n)),
                } : {}),
              };
            }),
            perturbations: (c?.snap?.alerts ?? []).filter((a) => (a.routes ?? []).includes(r.route_id)).map((a) => ({ titre: stripHtml(a.title), lien: a.url })),
          };
        }),
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
    description: 'Prochains départs à un arrêt (tous quais confondus), en temps réel quand Tisséo le publie, sinon horaires théoriques (toujours le cas du métro). Chaque passage donne l\'heure estimée, l\'horaire théorique, le retard en secondes, la provenance (realtime / gtfs) et l\'âge de la donnée. Avec « direction », seuls les passages qui vont vers ce terminus ou cet arrêt sont gardés (on écarte le bus qui revient). Signale aussi les passages des 15 dernières minutes (« le 00:25 est parti il y a 3 min ») et, la nuit, va chercher le premier passage du matin. Accepte un nom d\'arrêt, un id, une adresse (arrêt le plus proche) ou "lat,lon".',
    inputSchema: {
      type: 'object',
      properties: {
        arret: { type: 'string', description: 'Nom d\'arrêt ("Capitole", "Jean Jaurès"), id, adresse ou "lat,lon".' },
        ligne: { type: 'string', description: 'Ne garder que cette ligne.' },
        direction: { type: 'string', description: 'Sens voulu : terminus ("Fenouillet") ou arrêt desservi plus loin ("Fenouillet Ctre Cial").' },
        nombre: { type: 'integer', minimum: 1, maximum: 30, description: 'Nombre de passages (défaut 10).' },
      },
      required: ['arret'],
      additionalProperties: false,
    },
    async handler({ arret, ligne, direction, nombre = 10 }) {
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
      const rx = rtx();
      const lignes = ligne ? oneLine(ligne) : null;
      const ids = lignes ? new Set(lignes.map((r) => r.route_id)) : null;
      const keep = (d) => (!ids || ids.has(d.route_id)) && (!direction || goesToward(d, direction, rx)) && !endsHere(d, stopId);
      const filtered = Boolean(lignes || direction);
      let deps = dedupeBySched(svc.departuresAt(stopId, c, t, filtered ? 80 : nombre + 10).filter(keep), t, rx).slice(0, nombre);
      const group = [...new Set([stopId, ...placeGroup(stopId).filter((id) => distM(stops[stopId].lat, stops[stopId].lon, stops[id].lat, stops[id].lon) <= 300)])];
      // Rien dans les 2 h : on va chercher plus loin dans les horaires (nuit).
      let lointain = false;
      if (!deps.length && svc.scheduleAt) {
        const far = [];
        for (const sid of group) for (const d of svc.scheduleAt(sid, t, 400, 14 * 3600)) far.push({ ...d, stop_id: d.stop_id ?? sid });
        const seen = new Set();
        deps = far.sort((a, b) => a.time - b.time).filter((d) => {
          const k = `${d.route_id}|${d.dir}|${d.time}`;
          if (seen.has(k) || !keep(d)) return false;
          seen.add(k);
          return true;
        }).slice(0, nombre);
        lointain = deps.length > 0;
      }
      const partis = filtered ? recentlyGone(group, t, keep, deps, rx) : [];
      const passages = deps.map((d) => departureBrief(d, t, rx));
      const out = {
        heure: heure(t),
        date: isoDay(ymdOf(t)),
        arret: { nom: stops[stopId].n, arret_id: stopId },
        interprete_comme: describePlace(p),
        ...(viaNearest ? { note: `Arrêt le plus proche de ce lieu, à ${viaNearest.dist_m} m.` } : {}),
        ...(direction ? { direction_demandee: direction } : {}),
        ...(partis.length ? { deja_partis: partis } : {}),
        passages,
      };
      if (filtered) {
        const nxt = passages[0];
        const parts = [];
        if (partis[0]) parts.push(`Le ${partis[0].heure ?? partis[0].horaire_theorique} ${partis[0].statut.startsWith('parti') ? 'est parti' : 'est probablement passé'} il y a ~${partis[0].il_y_a_min} min`);
        if (nxt) parts.push(`${partis[0] ? 'prochain' : 'Prochain'} à ${nxt.heure}${dansTexte(nxt.dans_min)}, ${nxt.source === 'realtime' ? `temps réel${nxt.ponctualite ? `, ${nxt.ponctualite}` : ''}` : 'horaire théorique'}`);
        else parts.push(`${partis[0] ? 'aucun' : 'Aucun'} autre passage connu`);
        out.resume = `${parts.join(' ; ')}.`;
      }
      if (lointain) out.note = `${out.note ? `${out.note} ` : ''}Aucun passage dans les deux prochaines heures : premiers passages théoriques suivants.`;
      if (!c?.snap) out.attention = 'Temps réel indisponible : horaires théoriques uniquement.';
      if (!deps.length) out.note = `${out.note ? `${out.note} ` : ''}Aucun passage connu${lignes ? ` pour ${lignes.map(lineLabel).join(', ')}` : ''}${direction ? ` vers « ${direction} »` : ''} dans les 14 prochaines heures (vérifiez la direction : terminus ou arrêt situé après celui-ci).`;
      return out;
    },
  });

  // --- Trajets directs A → B ---------------------------------------------------
  // Toutes les courses d'une même ligne qui passent par un quai de A PUIS par
  // un quai de B : temps réel (course suivie, heure d'arrivée publiée) et
  // horaires théoriques (appariés course par course), sans doublon.
  function directTrips(boardIds, alightIds, t, { pastS = 15 * 60, horizonS = 14 * 3600 } = {}) {
    const B = new Set(boardIds), A = new Set(alightIds);
    const pairs = new Map(); // "route|dir|board|alight" -> option
    for (const [routeId, list] of Object.entries(variants)) {
      for (const v of list) {
        for (let i = 0; i < v.stops.length; i++) {
          if (!B.has(v.stops[i])) continue;
          const j = v.stops.findIndex((id, k) => k > i && A.has(id));
          if (j < 0) continue;
          const k = `${routeId}|${v.dir}|${v.stops[i]}|${v.stops[j]}`;
          if (!pairs.has(k)) pairs.set(k, { route_id: routeId, dir: v.dir, headsign: v.headsign, board: v.stops[i], alight: v.stops[j], n: j - i });
        }
      }
    }
    const routeIds = new Set([...pairs.values()].map((p) => p.route_id));
    const out = [];
    const rx = rtx();
    for (const trip of rx?.trips.values() ?? []) {
      if (!routeIds.has(trip.route_id)) continue;
      const i = trip.stops.findIndex((s) => B.has(s.id));
      if (i < 0) continue;
      const j = trip.stops.findIndex((s, k) => k > i && A.has(s.id));
      if (j < 0) continue;
      const b = trip.stops[i], a = trip.stops[j];
      if (b.d < t - pastS || b.d > t + horizonS) continue;
      out.push({
        route_id: trip.route_id, trip_id: trip.trip_id, vehicle: trip.vehicleId, board: b.id, alight: a.id,
        dep: b.d, arr: a.t, source: 'realtime', delay: b.delay, sched: b.delay != null ? b.d - b.delay : null,
        arrDelay: a.delay, ts: trip.ts, destination: stops[trip.stops[trip.stops.length - 1].id]?.n, n: j - i,
      });
    }
    const rtCount = out.length;
    const today = ymdOf(t);
    const days = [prevYmd(today), today, ymdOf(midnightOf(today) + 36 * 3600)];
    const seen = new Set();
    for (const p of pairs.values()) {
      const eB = (svc.scheduleEntries?.(p.board) ?? []).filter((e) => e.route_id === p.route_id && String(e.dir) === String(p.dir));
      const eA = (svc.scheduleEntries?.(p.alight) ?? []).filter((e) => e.route_id === p.route_id && String(e.dir) === String(p.dir));
      if (!eB.length || !eA.length) continue;
      for (const day of days) {
        const mid = midnightOf(day);
        for (const pi of svc.patternsOn?.(day) ?? []) {
          const Bt = [...new Set(eB.flatMap((e) => e.perPat?.[pi] ?? []))].sort((x, y) => x - y);
          const At = [...new Set(eA.flatMap((e) => e.perPat?.[pi] ?? []))].sort((x, y) => x - y);
          if (!Bt.length || !At.length) continue;
          // Course par course : appariement des départs aux arrivées (voir
          // pairTimes, qui ne confond pas deux rames qui se suivent).
          const est = svc.rideEstimate?.(p.route_id, p.board, p.alight) ?? null;
          let ref = est;
          if (!(ref > 0)) { // sans estimation : le plus court écart plausible
            ref = Infinity;
            for (const b of Bt) { const a = At.find((x) => x > b); if (a != null) ref = Math.min(ref, a - b); }
          }
          if (!Number.isFinite(ref)) continue;
          for (const [b, a] of pairTimes(Bt, At, ref)) {
            const dep = mid + b;
            if (dep < t - pastS || dep > t + horizonS) continue;
            const k = `${p.route_id}|${p.dir}|${dep}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ route_id: p.route_id, dir: p.dir, board: p.board, alight: p.alight, dep, arr: mid + a, source: 'gtfs', sched: dep, serviceDay: day, destination: p.headsign, n: p.n });
          }
        }
      }
    }
    // Un horaire théorique déjà couvert par une course temps réel est la
    // même course : on ne garde que le temps réel.
    const taken = new Set();
    const merged = out.filter((g) => {
      if (g.source !== 'gtfs') return true;
      for (let i = 0; i < rtCount; i++) {
        const r = out[i];
        if (taken.has(i) || r.route_id !== g.route_id) continue;
        const same = r.sched != null ? Math.abs(r.sched - g.dep) <= 60 : Math.abs(r.dep - g.dep) <= 180;
        if (same) { taken.add(i); return false; }
      }
      return true;
    });
    return { trips: merged.sort((a, b) => a.dep - b.dep), lines: routeIds };
  }
  function tripBrief(x, t, walkS = 0) {
    const r = routeById.get(x.route_id);
    const tm = { source: x.source, delay: x.delay ?? null, sched: x.sched ?? null, age: x.ts ? Math.max(0, t - x.ts) : null, serviceDay: x.serviceDay ?? (x.sched != null ? serviceDayOf(x.board, x.route_id, x.sched) : null) };
    return {
      ligne: r?.short_name ?? x.route_id,
      mode: modeOf(r),
      direction: x.destination ?? headsignFor(x.route_id, x.board, x.alight),
      monter_a: stops[x.board]?.n,
      descendre_a: stops[x.alight]?.n,
      depart: heure(x.dep),
      dans_min: dansMin(x.dep, t),
      arrivee: heure(x.arr),
      duree_min: Math.max(1, Math.round((x.arr - x.dep) / 60)),
      arrets: x.n,
      ...timingFields(x.dep, tm, t),
      ...(x.arrDelay != null ? { retard_arrivee_sec: x.arrDelay } : {}),
      ...(x.vehicle ? { vehicule_id: String(x.vehicle) } : {}),
      ...(walkS ? { marche_jusqu_au_quai_min: Math.max(1, Math.round(walkS / 60)) } : {}),
      quai_montee: x.board,
      quai_descente: x.alight,
    };
  }
  // Quais utilisables pour un lieu : ceux de l'arrêt (même nom, < 300 m), ou
  // les quais à moins de 600 m d'une adresse, avec la marche.
  function quaysFor(p) {
    if (p.stop_id) {
      const s = stops[p.stop_id];
      const ids = placeGroup(p.stop_id).filter((id) => distM(s.lat, s.lon, stops[id].lat, stops[id].lon) <= 300);
      return new Map([p.stop_id, ...ids].map((id) => [id, 0]));
    }
    const near = svc.nearestStopPoints(p.lat, p.lon, 12).filter((x) => x.dist_m <= 600);
    return new Map(near.map((x) => [x.id, Math.round(x.dist_m / 1.25)]));
  }

  tools.push({
    name: 'prochains_passages_vers',
    title: 'Prochains trajets directs d\'un lieu à un autre',
    description: 'Les prochains trajets DIRECTS (sans correspondance) d\'un lieu à un autre : trouve seul les lignes, le bon sens et les quais, et donne pour chaque course l\'heure de départ, l\'heure d\'arrivée, le retard et la provenance (realtime / gtfs). Signale les courses qui viennent de partir (« parti il y a 3 min ») et, la nuit, le premier départ du matin. Ex. depart="La Vache", arrivee="Fenouillet Ctre Cial". Pour un trajet avec correspondances : « itineraire » ou « trajet_maintenant ».',
    inputSchema: {
      type: 'object',
      properties: {
        depart: { type: 'string', description: 'Arrêt ou lieu de départ.' },
        arrivee: { type: 'string', description: 'Arrêt ou lieu d\'arrivée.' },
        ligne: { type: 'string', description: 'Ne garder que cette ligne.' },
        nombre: { type: 'integer', minimum: 1, maximum: 15, description: 'Nombre de trajets à venir (défaut 3).' },
      },
      required: ['depart', 'arrivee'],
      additionalProperties: false,
    },
    async handler({ depart, arrivee, ligne, nombre = 3 }) {
      const [from, to] = await Promise.all([resolvePlace(depart), resolvePlace(arrivee)]);
      await svc.liveOrNull?.();
      const t = now();
      const qFrom = quaysFor(from), qTo = quaysFor(to);
      if (!qFrom.size) throw new ToolError(`Aucun arrêt à moins de 600 m de « ${from.label} ».`);
      if (!qTo.size) throw new ToolError(`Aucun arrêt à moins de 600 m de « ${to.label} ».`);
      let { trips, lines } = directTrips([...qFrom.keys()], [...qTo.keys()], t);
      if (ligne) {
        const ids = new Set(oneLine(ligne).map((r) => r.route_id));
        trips = trips.filter((x) => ids.has(x.route_id));
        lines = new Set([...lines].filter((id) => ids.has(id)));
      }
      const base = { heure: heure(t), date: isoDay(ymdOf(t)), depart: describePlace(from), arrivee: describePlace(to) };
      if (!lines.size) {
        return { ...base, lignes_directes: [], trajets: [], note: `Aucune ligne directe${ligne ? ` (${ligne})` : ''} entre ces deux lieux : utilisez « itineraire » ou « trajet_maintenant » (avec correspondance).` };
      }
      // Un trajet n'est atteignable que si l'on a le temps de marcher jusqu'au quai.
      const walkOf = (x) => qFrom.get(x.board) ?? 0;
      const upcoming = trips.filter((x) => x.dep >= t + walkOf(x) - 30);
      const gone = trips.filter((x) => x.dep < t + walkOf(x) - 30);
      const trajets = upcoming.slice(0, nombre).map((x) => tripBrief(x, t, walkOf(x)));
      const partis = gone.slice(-3).reverse().map((x) => ({
        ...(({ dans_min: _, ...rest }) => rest)(tripBrief(x, t)),
        il_y_a_min: x.dep <= t ? Math.max(1, Math.round((t - x.dep) / 60)) : 0,
        statut: x.dep > t ? 'trop proche : impossible d\'atteindre le quai à temps'
          : x.source === 'realtime' ? 'parti (confirmé par le temps réel)' : 'probablement passé (horaire théorique)',
      }));
      const n = trajets[0];
      const p0 = partis[0];
      const parts = [];
      if (p0) parts.push(p0.il_y_a_min ? `Le ${p0.ligne} de ${p0.depart} est ${p0.source === 'realtime' ? 'parti' : 'probablement passé'} il y a ~${p0.il_y_a_min} min` : `Le ${p0.ligne} de ${p0.depart} est trop proche pour être attrapé`);
      if (n) parts.push(`${p0 ? 'prochain' : 'Prochain'} : ${n.ligne} direction ${n.direction} à ${n.depart} depuis ${n.monter_a}${dansTexte(n.dans_min)}, arrivée ${n.arrivee} à ${n.descendre_a}, ${n.source === 'realtime' ? `temps réel${n.ponctualite ? `, ${n.ponctualite}` : ''}` : 'horaire théorique'}`);
      else parts.push(`${p0 ? 'aucun' : 'Aucun'} autre départ direct dans les 14 prochaines heures`);
      return {
        ...base,
        lignes_directes: [...lines].map((id) => routeById.get(id)?.short_name ?? id),
        resume: `${parts.join(' ; ')}.`,
        ...(partis.length ? { deja_partis: partis } : {}),
        trajets,
        ...(trajets.some((x) => x.source === 'gtfs') ? { note: 'Les courses « gtfs » sont des horaires théoriques : leur arrivée est déduite de la grille, sans retards.' } : {}),
      };
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
          passages: dedupeBySched(svc.departuresAt(s.id, c, t, 8).filter((d) => !endsHere(d, s.id)), t).slice(0, 3).map((d) => departureBrief(d, t)),
        })),
      };
    },
  });

  // Calcul commun à « itineraire » et « trajet_maintenant ».
  async function planJourney({ depart, arrivee, heure_depart: hd, arriver_avant: aa, options = 1, eviter, sans_modes: sansModes }) {
    if (hd && aa) throw new ToolError('Donnez soit « heure_depart », soit « arriver_avant », pas les deux.');
    const t0 = now();
    const [from, to] = await Promise.all([resolvePlace(depart), resolvePlace(arrivee)]);
    const ep = (p) => (p.stop_id ? { stop_id: p.stop_id } : { lat: p.lat, lon: p.lon, label: p.label });
    // Lignes exclues par l'utilisateur (jamais réintroduites, même en repli).
    const exclude = new Set();
    for (const q of String(eviter ?? '').split(',').map((x) => x.trim()).filter(Boolean)) for (const r of oneLine(q)) exclude.add(r.route_id);
    for (const r of routes) if ((sansModes ?? []).includes(norm(modeOf(r)))) exclude.add(r.route_id);
    const run = (at, extra = new Set()) => svc.journey(ep(from), ep(to), at, { exclude: new Set([...exclude, ...extra]) });

    // Arriver avant T : on cale le départ par approximations successives
    // (le routeur ne sait calculer qu'en partant) et on garde le départ le
    // plus TARDIF qui arrive à temps.
    let at = parseHeure(hd, t0);
    let target = null;
    if (aa) {
      target = parseHeure(aa, t0);
      let dep = target - 45 * 60;
      let best = null;
      for (let i = 0; i < 8; i++) {
        const r = await run(dep);
        if (!r || r.error) break;
        if (r.arrive_at <= target && !r.no_departure) {
          if (!best || dep > best) best = dep;
          const marge = target - r.arrive_at;
          if (marge < 120) break;
          dep += marge - 60;
        } else dep -= Math.max(r.arrive_at - target, 0) + 60;
      }
      if (best === null) throw new ToolError(`Impossible d'arriver avant ${heure(target)} avec les lignes disponibles (départ compris comme « ${from.label} », arrivée comme « ${to.label} »).`);
      at = best;
    }

    let r = await run(at);
    if (!r || r.error) {
      throw new ToolError(`${r?.error ?? 'Aucun itinéraire trouvé'} (départ compris comme « ${from.label} », arrivée comme « ${to.label} »).`);
    }
    // La nuit, la première ligne ne repart qu'au matin : on recalcule à
    // l'heure où l'on partira vraiment, avec les lignes en service ALORS.
    let nuit = null;
    const firstRide = r.legs.find((l) => l.type === 'ride');
    if (!target && firstRide?.long_wait) {
      const later = firstRide.depart - (firstRide.ready_at - at);
      const r2 = await run(later);
      nuit = { premier_depart: heure(firstRide.depart), attente_min: Math.round((firstRide.depart - firstRide.ready_at) / 60) };
      if (r2 && !r2.error && !r2.no_departure && r2.arrive_at <= r.arrive_at) {
        r = r2;
        at = later;
      }
    }
    return { r, at, t0, target, from, to, run, exclude, nuit, options };
  }

  async function itineraryOut(plan) {
    const { r, at, t0, target, from, to, run, exclude, nuit, options } = plan;
    const best = formatJourney(r, plan.at);
    const out = {
      depart: describePlace(from),
      arrivee: describePlace(to),
      ...(target ? { arriver_avant: heure(target) } : {}),
      ...best,
    };
    if (nuit) {
      out.alertes = [`Plus de passage utile avant ${nuit.premier_depart} (attente de ${Math.floor(nuit.attente_min / 60)} h ${String(nuit.attente_min % 60).padStart(2, '0')}) : service de nuit terminé. Horaires de reprise du matin.`, ...(out.alertes ?? [])];
    }
    const p = parisParts(at);
    const q = parisParts(t0);
    if (p.y !== q.y || p.mo !== q.mo || p.d !== q.d) out.jour = fmtDay.format(new Date(at * 1000));
    if (exclude.size) out.lignes_evitees = [...exclude].map((id) => routeById.get(id)?.short_name ?? id);

    // Options : on écarte tour à tour chaque ligne de la meilleure option,
    // puis toutes ; on garde les trajets dont la suite de lignes diffère.
    if (options > 1) {
      const sig = (x) => x.legs.filter((l) => l.type === 'ride').map((l) => l.route_id).join('>');
      const seen = new Set([sig(r)]);
      const rides = [...new Set(r.legs.filter((l) => l.type === 'ride').map((l) => l.route_id))];
      const tries = [...rides.map((id) => new Set([id])), new Set(rides)];
      const alts = [];
      for (const ex of tries) {
        const x = await run(at, ex);
        if (!x || x.error || x.no_departure || seen.has(sig(x))) continue;
        if (target && x.arrive_at > target) continue;
        // Une « alternative » deux fois plus longue n'aide personne.
        if (x.duration_s > r.duration_s * 1.6 + 600) continue;
        seen.add(sig(x));
        alts.push(x);
      }
      alts.sort((a, b) => a.arrive_at - b.arrive_at);
      out.autres_options = alts.slice(0, options - 1).map((x) => formatJourney(x, at));
      if (!out.autres_options.length) out.autres_options_note = 'Aucun autre trajet raisonnable trouvé.';
    }
    return out;
  }

  tools.push({
    name: 'itineraire',
    title: 'Calculer un itinéraire',
    description: 'Calcule un trajet en transports Tisséo entre deux lieux de l\'agglomération toulousaine : arrêts, adresses, lieux connus (gare Matabiau, aéroport, universités…) ou coordonnées "lat,lon". Renvoie les étapes (marche, lignes à prendre, direction, arrêts de montée et de descente, attente), les heures, les correspondances et le prix du ticket. Chaque départ dit sa provenance (realtime = confirmé par le temps réel, gtfs = horaire théorique) ; un départ n\'est JAMAIS inventé : sans horaire, l\'étape est marquée « aucun départ disponible ». Signale les correspondances trop courtes. Départ à une heure donnée OU arrivée avant une heure ; jusqu\'à 3 options différentes ; lignes ou modes à éviter. Pour « comment j\'y vais maintenant », préférer « trajet_maintenant ».',
    inputSchema: {
      type: 'object',
      properties: {
        depart: { type: 'string', description: 'Lieu de départ.' },
        arrivee: { type: 'string', description: 'Lieu d\'arrivée.' },
        heure_depart: { type: 'string', description: 'Heure de départ, fuseau de Paris : "08:15", "8h15" ou "2026-09-29T08:15". Défaut : maintenant.' },
        arriver_avant: { type: 'string', description: 'Heure limite d\'arrivée (même format) : on cherche le départ le plus tardif qui arrive à temps. Exclusif avec heure_depart.' },
        options: { type: 'integer', minimum: 1, maximum: 3, description: 'Nombre d\'itinéraires différents à proposer (défaut 1).' },
        eviter: { type: 'string', description: 'Lignes à ne pas emprunter, séparées par des virgules ("L1, 14").' },
        sans_modes: { type: 'array', items: { type: 'string', enum: ['bus', 'tram', 'metro', 'teleo'] }, description: 'Modes à exclure, ex. ["bus"] pour métro et tram seulement.' },
      },
      required: ['depart', 'arrivee'],
      additionalProperties: false,
    },
    async handler(args) {
      return itineraryOut(await planJourney(args));
    },
  });

  // Une correspondance de moins de 2 min tient au moindre retard.
  const RISKY_TRANSFER_S = 120;

  // Mise en forme d'un résultat du routeur pour un modèle de langage.
  function formatJourney(r, at) {
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
    const alertes = [];
    const t = now();
    let rideNo = 0;
    for (const l of legs) {
      if (l.type === 'walk') {
        const min = Math.max(1, Math.round(l.seconds / 60));
        const memeArret = norm(l.from) === norm(l.to);
        etapes.push({
          type: memeArret ? 'correspondance' : 'marche',
          de: l.from,
          vers: l.to,
          duree_min: min,
          source: 'estimation',
          instruction: memeArret ? `Changer de quai à ${l.from} (${min} min à pied).` : `Marcher ${min} min de ${l.from} à ${l.to}.`,
        });
        clock += l.seconds;
        continue;
      }
      rideNo++;
      const direction = headsignFor(l.route_id, l.from_id, l.to_id);
      if (l.no_departure) {
        etapes.push({
          type: 'trajet',
          ligne: l.line,
          mode: l.mode,
          ...(direction ? { direction } : {}),
          monter_a: l.from,
          descendre_a: l.to,
          depart: null,
          statut: 'aucun départ disponible',
          source: 'estimation',
          instruction: `${l.mode} ${l.line}${direction ? ` direction ${direction}` : ''} de ${l.from} à ${l.to} : AUCUN départ connu (ni temps réel ni horaire théorique). Ne pas compter dessus.`,
        });
        alertes.push(`Aucun départ connu pour ${l.line} à ${l.from} : les heures suivantes de ce trajet ne sont pas fiables.`);
        clock = l.arrive;
        continue;
      }
      const attenteS = Math.max(0, l.depart - (l.ready_at ?? clock));
      const attente = Math.round(attenteS / 60);
      const tm = l.real
        ? { source: 'realtime', delay: l.delay_s ?? null, sched: l.delay_s != null ? l.depart - l.delay_s : null, age: l.rt_ts ? Math.max(0, t - l.rt_ts) : null, serviceDay: l.delay_s != null ? serviceDayOf(l.from_id, l.route_id, l.depart - l.delay_s) : null }
        : { source: 'gtfs', delay: null, sched: l.depart, age: null, serviceDay: serviceDayOf(l.from_id, l.route_id, l.depart) };
      const e = {
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
        statut: l.real ? 'départ confirmé (temps réel)' : 'départ théorique (horaire publié)',
        ...timingFields(l.depart, tm, t),
        source_arrivee: l.real ? 'realtime' : l.arrive_scheduled ? 'gtfs' : 'estimation',
        ...(l.vehicle ? { vehicule_id: String(l.vehicle) } : {}),
        instruction: `Prendre ${l.mode.toLowerCase()} ${l.line}${direction ? ` direction ${direction}` : ''} à ${l.from} (${heure(l.depart)}), descendre à ${l.to} (${heure(l.arrive)}).`,
      };
      if (l.long_wait) e.attention = `Longue attente : prochain passage à ${heure(l.depart)}.`;
      // Correspondance : le temps entre l'arrivée sur le quai et le départ.
      if (rideNo > 1) {
        e.marge_correspondance_min = Math.round(attenteS / 60);
        if (attenteS < RISKY_TRANSFER_S) {
          e.correspondance_risquee = `Seulement ${Math.max(0, Math.round(attenteS / 60))} min pour changer à ${l.from} : au moindre retard, la correspondance est manquée.`;
          alertes.push(e.correspondance_risquee);
        }
      }
      etapes.push(e);
      clock = l.arrive;
    }
    const rides = r.legs.filter((l) => l.type === 'ride');
    const tarif = fareFor(rides.map((l) => l.route_id), (r.arrive_at ?? at) - (rides[0]?.depart ?? at));
    const allRt = rides.length && rides.every((l) => l.real);
    const anyNone = rides.some((l) => l.no_departure);
    return {
      partir_a: heure(r.depart_at),
      arriver_a: anyNone ? null : heure(r.arrive_at),
      ...(anyNone ? { arrivee_estimee_non_fiable: heure(r.arrive_at) } : {}),
      duree_min: Math.round(r.duration_s / 60),
      correspondances: r.transfers,
      lignes: rides.map((l) => l.line),
      etapes,
      ...(alertes.length ? { alertes } : {}),
      ...(tarif ? { tarif } : {}),
      ...(r.out_of_service ? { attention: 'Aucun trajet trouvé avec les seules lignes en service à cette heure : cet itinéraire utilise des lignes peut-être déjà arrêtées (service de nuit réduit). Vérifiez les horaires.' } : {}),
      fiabilite: anyNone
        ? 'Au moins une étape n\'a aucun départ connu : itinéraire indicatif seulement.'
        : allRt
          ? 'Tous les départs sont confirmés par le temps réel.'
          : 'Une partie des départs est théorique (sans retards) et les arrivées sans temps réel sont estimées : prévoyez une marge. Itinéraire calculé par Tisséo Live (pas par Tisséo) ; en cas de doute, vérifier sur tisseo.fr.',
    };
  }

  tools.push({
    name: 'trajet_maintenant',
    title: 'Comment y aller maintenant',
    description: 'L\'outil de conversation pour « comment je vais à X maintenant ? » : meilleur trajet en partant tout de suite, avec la marche jusqu\'au quai, l\'attente, chaque ligne et sa direction, le départ confirmé ou théorique (et son retard), les correspondances (trop courtes signalées), les perturbations des lignes empruntées, l\'arrivée estimée, un plan B si l\'on rate le premier véhicule, et une autre option. Répond en une phrase dans « resume ».',
    inputSchema: {
      type: 'object',
      properties: {
        depart: { type: 'string', description: 'Lieu de départ (arrêt, adresse, lieu, "lat,lon").' },
        arrivee: { type: 'string', description: 'Lieu d\'arrivée.' },
        eviter: { type: 'string', description: 'Lignes à ne pas emprunter, séparées par des virgules.' },
        sans_modes: { type: 'array', items: { type: 'string', enum: ['bus', 'tram', 'metro', 'teleo'] }, description: 'Modes à exclure.' },
      },
      required: ['depart', 'arrivee'],
      additionalProperties: false,
    },
    async handler({ depart, arrivee, eviter, sans_modes: sansModes }) {
      const plan = await planJourney({ depart, arrivee, options: 2, eviter, sans_modes: sansModes });
      const out = await itineraryOut(plan);
      const { r } = plan;
      const t = now();
      const rides = r.legs.filter((l) => l.type === 'ride');
      // Perturbations des lignes empruntées.
      let c = null;
      try { c = await svc.liveOrNull(); } catch { /* sans alertes */ }
      const used = new Set(rides.map((l) => l.route_id));
      const perturbations = (c?.snap?.alerts ?? []).filter((a) => (a.routes ?? []).some((id) => used.has(id)))
        .map((a) => ({ titre: stripHtml(a.title), lignes: (a.routes ?? []).filter((id) => used.has(id)).map((id) => routeById.get(id)?.short_name ?? id), lien: a.url }));
      // Plan B : les courses suivantes de la première ligne, même quai.
      const first = rides[0];
      let planB = [];
      if (first && !first.no_departure) {
        const { trips } = directTrips([first.from_id], [first.to_id], t, { pastS: 0 });
        planB = trips.filter((x) => x.route_id === first.route_id && x.dep > first.depart + 30).slice(0, 2).map((x) => {
          const b = tripBrief(x, t);
          return { ligne: b.ligne, direction: b.direction, depart: b.depart, arrivee_a_descente: b.arrivee, descendre_a: b.descendre_a, source: b.source, ...(b.retard_sec != null ? { retard_sec: b.retard_sec } : {}) };
        });
      }
      const e1 = out.etapes.find((e) => e.type === 'trajet');
      const marche = out.etapes[0]?.type === 'marche' ? out.etapes[0] : null;
      const parts = [];
      if (plan.nuit) parts.push(`Plus de service utile avant ${plan.nuit.premier_depart}`);
      parts.push(`Partez à ${out.partir_a}`);
      if (marche) parts.push(`marchez ${marche.duree_min} min jusqu'à ${marche.vers}`);
      for (const e of out.etapes.filter((x) => x.type === 'trajet')) {
        parts.push(e.depart
          ? `prenez ${e.mode.toLowerCase()} ${e.ligne}${e.direction ? ` direction ${e.direction}` : ''} à ${e.monter_a} à ${e.depart} (${e.source === 'realtime' ? `temps réel${e.ponctualite ? `, ${e.ponctualite}` : ''}` : 'horaire théorique'}) jusqu'à ${e.descendre_a}`
          : `${e.ligne} de ${e.monter_a} : aucun départ connu`);
      }
      parts.push(out.arriver_a ? `arrivée vers ${out.arriver_a}` : 'heure d\'arrivée inconnue');
      out.resume = `${parts.join(', ')}.${out.alertes?.length ? ` Attention : ${out.alertes.join(' ')}` : ''}${perturbations.length ? ` ${perturbations.length} perturbation(s) sur ces lignes.` : ''}`;
      return {
        heure: heure(t),
        date: isoDay(ymdOf(t)),
        resume: out.resume,
        ...out,
        perturbations,
        ...(planB.length ? { si_vous_ratez_le_premier: planB } : e1 ? { si_vous_ratez_le_premier_note: 'Pas de course suivante connue sur cette ligne dans les prochaines heures.' } : {}),
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
        recherche: { type: 'string', description: 'Mot cherché dans le titre ou le texte ("grève", "travaux", "Capitole"…).' },
        detail: { type: 'boolean', description: 'Inclure le texte complet (défaut : oui avec une ligne ou une recherche, non sinon).' },
      },
      additionalProperties: false,
    },
    async handler({ ligne, recherche, detail }) {
      const c = await live();
      let list = c.snap.alerts;
      const lignes = ligne ? oneLine(ligne) : null;
      if (lignes) {
        const ids = new Set(lignes.map((r) => r.route_id));
        list = list.filter((a) => (a.routes ?? []).some((id) => ids.has(id)));
      }
      if (recherche) {
        const toks = norm(recherche).split(' ').filter(Boolean);
        list = list.filter((a) => { const txt = norm(`${a.title} ${stripHtml(a.description)}`); return toks.every((t) => txt.includes(t)); });
      }
      const full = detail ?? Boolean(lignes || recherche);
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
    description: 'Vue d\'ensemble et statistiques instantanées : véhicules en circulation par mode et par ligne (les plus chargées), véhicules à l\'arrêt ou au terminus, lignes actives, taille du réseau (lignes par mode, arrêts, accessibilité), fraîcheur des données temps réel, perturbations, validité des horaires théoriques.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const c = await live();
      const t = now();
      const vs = c.snap.vehicles;
      const parMode = {}, parLigne = {};
      for (const v of vs) {
        parMode[v.mode] = (parMode[v.mode] ?? 0) + 1;
        parLigne[v.line] = (parLigne[v.line] ?? 0) + 1;
      }
      const lignesParMode = {};
      for (const r of routes) lignesParMode[modeOf(r)] = (lignesParMode[modeOf(r)] ?? 0) + 1;
      const points = Object.keys(stops).filter((id) => id.startsWith('stop_point:'));
      return {
        heure: heure(t),
        donnees_de: heure(c.snap.rt_timestamp),
        age_donnees_s: t - c.snap.rt_timestamp,
        vehicules: vs.length,
        par_mode: parMode,
        lignes_les_plus_chargees: Object.fromEntries(Object.entries(parLigne).sort((a, b) => b[1] - a[1]).slice(0, 10)),
        a_l_arret: vs.filter((v) => v.status === 'at_stop').length,
        au_terminus: vs.filter((v) => v.status === 'terminus').length,
        lignes_actives: new Set(vs.map((v) => v.route_id)).size,
        reseau: {
          lignes: routes.length,
          lignes_par_mode: lignesParMode,
          arrets: new Set(points.map((id) => norm(stops[id].n))).size,
          quais: points.length,
          quais_accessibles_fauteuil: points.filter((id) => stops[id].w === 1).length,
          ...(svc.gtfsMeta?.generated_at ? { donnees_gtfs_du: svc.gtfsMeta.generated_at.slice(0, 10) } : {}),
        },
        perturbations: c.snap.alerts.length,
        ...(() => { const p = punctuality(t); return p ? { ponctualite: { ...p, lignes_les_plus_en_retard: p.lignes.slice(0, 8), lignes: undefined } } : {}; })(),
        ...horairesValidite(t),
        ...(c.stale ? { attention: 'Flux Tisséo en retard : dernières données connues.' } : {}),
        precision: precisionFor(vs),
      };
    },
  });

  // --- Fiche d'arrêt -----------------------------------------------------------
  async function stopFromArg(arret) {
    const p = await resolvePlace(arret);
    if (p.stop_id) return { p, stopId: p.stop_id, viaNearest: null };
    const near = svc.nearestStopPoints(p.lat, p.lon, 1)[0];
    if (!near) throw new ToolError('Aucun arrêt à proximité.');
    return { p, stopId: near.id, viaNearest: near };
  }
  function linesAt(group) {
    const out = new Map();
    for (const id of group) {
      for (const rid of routesAt.get(id) ?? []) {
        const r = routeById.get(rid);
        if (!r) continue;
        let e = out.get(rid);
        if (!e) { e = { r, dirs: new Set() }; out.set(rid, e); }
        for (const v of variants[rid] ?? []) {
          const i = v.stops.indexOf(id);
          if (i >= 0 && i < v.stops.length - 1) e.dirs.add(v.headsign);
        }
      }
    }
    const order = { Métro: 0, Tram: 1, Téléo: 2, Bus: 3 };
    return [...out.values()]
      .sort((a, b) => (order[modeOf(a.r)] ?? 9) - (order[modeOf(b.r)] ?? 9) || a.r.short_name.localeCompare(b.r.short_name, 'fr', { numeric: true }))
      .map((e) => ({ ligne: e.r.short_name, mode: modeOf(e.r), directions: [...e.dirs] }));
  }

  tools.push({
    name: 'arret',
    title: 'Fiche d\'un arrêt',
    description: 'Tout sur un arrêt ou une station : ses quais, les lignes qui le desservent et leurs directions, son accessibilité en fauteuil, ses prochains passages, et les perturbations des lignes qui y passent. Accepte un nom, un id, une adresse (arrêt le plus proche) ou "lat,lon".',
    inputSchema: {
      type: 'object',
      properties: {
        arret: { type: 'string', description: 'Nom d\'arrêt, id, adresse ou "lat,lon".' },
        passages: { type: 'integer', minimum: 0, maximum: 30, description: 'Nombre de prochains passages (défaut 8, 0 pour aucun).' },
      },
      required: ['arret'],
      additionalProperties: false,
    },
    async handler({ arret, passages = 8 }) {
      const { p, stopId, viaNearest } = await stopFromArg(arret);
      const group = placeGroup(stopId);
      const s = stops[stopId];
      const t = now();
      const c = passages ? await svc.liveOrNull() : null;
      const lignes = linesAt(group);
      const rids = new Set(group.flatMap((id) => [...(routesAt.get(id) ?? [])]));
      const w = group.map((id) => stops[id].w);
      const alerts = (c?.snap?.alerts ?? []).filter((a) => (a.routes ?? []).some((id) => rids.has(id)));
      return {
        heure: heure(t),
        arret: { nom: s.n, arret_id: stopId, lat: round5(s.lat), lon: round5(s.lon), quais: group.length },
        interprete_comme: describePlace(p),
        ...(viaNearest ? { note: `Arrêt le plus proche de ce lieu, à ${viaNearest.dist_m} m.` } : {}),
        accessibilite_fauteuil: w.every((x) => x === 1) ? 'accessible'
          : w.some((x) => x === 1) ? 'partiellement (certains quais seulement)'
            : w.some((x) => x === 2) ? 'non accessible' : 'non renseignée',
        lignes,
        ...(passages ? { prochains_passages: dedupeBySched(svc.departuresAt(stopId, c, t, passages + 8).filter((d) => !endsHere(d, stopId)), t).slice(0, passages).map((d) => departureBrief(d, t)) } : {}),
        perturbations: alerts.map((a) => ({ titre: stripHtml(a.title), lignes: (a.routes ?? []).filter((id) => rids.has(id)).map((id) => routeById.get(id)?.short_name ?? id), lien: a.url })),
      };
    },
  });

  // --- Grille horaire -----------------------------------------------------------
  tools.push({
    name: 'horaires',
    title: 'Horaires et fréquences à un arrêt',
    description: 'Horaires THÉORIQUES d\'un arrêt pour un jour donné, comme une fiche horaire : premier et dernier passage, fréquence par tranche (pointe, journée, soirée) et, sur demande, la liste complète heure par heure. Répond à « à quelle heure passe le dernier métro ? », « le 14 passe toutes les combien le dimanche ? ». Tous les modes, métro compris.',
    inputSchema: {
      type: 'object',
      properties: {
        arret: { type: 'string', description: 'Nom d\'arrêt, id, adresse ou "lat,lon".' },
        ligne: { type: 'string', description: 'Ne garder que cette ligne (recommandé).' },
        jour: { type: 'string', description: '"aujourd\'hui" (défaut), "demain", "samedi", "2026-10-03", "03/10".' },
        direction: { type: 'string', description: 'Ne garder que la direction dont le terminus contient ce texte.' },
        detail: { type: 'boolean', description: 'Inclure la grille heure par heure (défaut : oui si une ligne est donnée).' },
      },
      required: ['arret'],
      additionalProperties: false,
    },
    async handler({ arret, ligne, jour, direction, detail }) {
      const { p, stopId, viaNearest } = await stopFromArg(arret);
      const j = parseJour(jour, now());
      const lignes = ligne ? oneLine(ligne) : null;
      const ids = lignes ? new Set(lignes.map((r) => r.route_id)) : null;
      let tt = timetable(placeGroup(stopId), j.ymd);
      if (ids) tt = tt.filter((x) => ids.has(x.route_id));
      if (direction) tt = tt.filter((x) => norm(x.destination).includes(norm(direction)));
      // Un départ au terminus ne dessert pas l'arrêt « vers » lui-même : on
      // retire les entrées dont la destination est l'arrêt demandé.
      tt = tt.filter((x) => norm(x.destination) !== norm(stops[stopId].n));
      const full = detail ?? Boolean(lignes);
      const order = { Métro: 0, Tram: 1, Téléo: 2, Bus: 3 };
      tt.sort((a, b) => {
        const ra = routeById.get(a.route_id), rb = routeById.get(b.route_id);
        return (order[modeOf(ra)] ?? 9) - (order[modeOf(rb)] ?? 9) || String(ra?.short_name).localeCompare(String(rb?.short_name), 'fr', { numeric: true }) || a.dir.localeCompare(b.dir);
      });
      const out = {
        jour: j.label,
        arret: { nom: stops[stopId].n, arret_id: stopId },
        interprete_comme: describePlace(p),
        ...(viaNearest ? { note: `Arrêt le plus proche de ce lieu, à ${viaNearest.dist_m} m.` } : {}),
        source: 'horaires théoriques publiés par Tisséo (hors retards et perturbations)',
        lignes: tt.map((x) => {
          const r = routeById.get(x.route_id);
          const parHeure = {};
          // Une chaîne par heure (« 02 06 10 … ») : la grille d'une journée de
          // métro fait ~300 passages, autant ne pas en faire 300 éléments JSON.
          if (full) for (const sec of x.times) { const h = fmtSec(sec).slice(0, 2); parHeure[h] = parHeure[h] ? `${parHeure[h]} ${fmtSec(sec).slice(3)}` : fmtSec(sec).slice(3); }
          return {
            ligne: r?.short_name ?? x.route_id,
            mode: modeOf(r),
            direction: x.destination,
            premier: fmtSec(x.times[0]),
            dernier: fmtSec(x.times[x.times.length - 1]),
            ...(x.times[x.times.length - 1] >= 86400 ? { note: 'le dernier passage a lieu après minuit' } : {}),
            passages: x.times.length,
            frequences: frequences(x.times),
            ...(full ? { grille: parHeure } : {}),
          };
        }),
      };
      if (!tt.length) {
        out.note = `${out.note ? `${out.note} ` : ''}Aucun passage théorique ${lignes ? `de ${lignes.map(lineLabel).join(', ')} ` : ''}à cet arrêt ce jour-là (ligne qui ne dessert pas cet arrêt, ou pas de service ce jour).`;
        const until = svc.scheduleUntil?.();
        if (until && j.ymd > until) out.attention = `Les horaires publiés s'arrêtent au ${until.slice(6, 8)}/${until.slice(4, 6)}/${until.slice(0, 4)}.`;
      }
      return out;
    },
  });

  // --- Isochrone ------------------------------------------------------------------
  tools.push({
    name: 'accessibles_depuis',
    title: 'Où aller en N minutes',
    description: 'Tous les arrêts atteignables depuis un lieu en moins de N minutes en transports Tisséo (marche, attentes moyennes et correspondances comprises), avec le temps estimé et les lignes à prendre. Répond à « jusqu\'où peut-on aller en 20 minutes depuis Capitole ? ».',
    inputSchema: {
      type: 'object',
      properties: {
        lieu: { type: 'string', description: 'Lieu de départ (arrêt, adresse, lieu, "lat,lon").' },
        minutes: { type: 'integer', minimum: 5, maximum: 90, description: 'Temps maximum (défaut 20).' },
        heure: { type: 'string', description: 'Heure de départ ("08:15", "2026-10-03T14:00") : seules les lignes en service à cette heure comptent. Défaut : maintenant.' },
        eviter: { type: 'string', description: 'Lignes à ne pas emprunter, séparées par des virgules.' },
        limite: { type: 'integer', minimum: 5, maximum: 300, description: 'Nombre d\'arrêts détaillés, les plus lointains en premier (défaut 40).' },
      },
      required: ['lieu'],
      additionalProperties: false,
    },
    async handler({ lieu, minutes = 20, heure: hd, eviter, limite = 40 }) {
      if (!svc.reach) throw new ToolError('Calcul indisponible sur ce serveur.');
      const p = await resolvePlace(lieu);
      const t = now();
      let startId = p.stop_id;
      let walk0 = 0;
      if (!startId) {
        const near = svc.nearestStopPoints(p.lat, p.lon, 1)[0];
        if (!near || near.dist_m > MAX_STOP_DIST_M) throw new ToolError('Aucun arrêt à proximité de ce lieu.');
        startId = near.id;
        walk0 = Math.round(near.dist_m / 1.25);
      }
      const exclude = new Set();
      for (const q of String(eviter ?? '').split(',').map((x) => x.trim()).filter(Boolean)) for (const r of oneLine(q)) exclude.add(r.route_id);
      const at = parseHeure(hd, t);
      const best = svc.reach(startId, minutes * 60 - walk0, exclude, at);
      // Un résultat par arrêt (nom), le plus rapide de ses quais.
      const byName = new Map();
      for (const [id, v] of best) {
        const s = stops[id];
        if (!s) continue;
        const k = norm(s.n);
        const cur = byName.get(k);
        if (!cur || v.s < cur.s) byName.set(k, { id, s: v.s, routes: v.routes });
      }
      const list = [...byName.values()].map((x) => ({
        nom: stops[x.id].n,
        arret_id: x.id,
        minutes: Math.max(1, Math.round((x.s + walk0) / 60)),
        via: x.routes.length ? x.routes.map((id) => routeById.get(id)?.short_name ?? id) : ['à pied'],
      })).sort((a, b) => b.minutes - a.minutes || a.nom.localeCompare(b.nom));
      const lignes = new Set(list.flatMap((x) => x.via).filter((x) => x !== 'à pied'));
      let far = null;
      for (const x of list) {
        const s = stops[x.arret_id];
        const d = distM(p.lat, p.lon, s.lat, s.lon);
        if (!far || d > far.d) far = { d, nom: x.nom, minutes: x.minutes };
      }
      return {
        depuis: describePlace(p),
        a_partir_de: heure(at),
        en_moins_de_min: minutes,
        arrets_atteignables: list.length,
        lignes_utilisees: [...lignes],
        ...(far ? { le_plus_loin: { arret: far.nom, a_vol_d_oiseau_km: Math.round(far.d / 100) / 10, minutes: far.minutes } } : {}),
        arrets: list.slice(0, limite),
        ...(list.length > limite ? { tronque: `${list.length - limite} arrêts plus proches non détaillés.` } : {}),
        ...(!lignes.size ? { note: 'Aucune ligne utilisable (hors service à cette heure, ou trop loin) : seuls les arrêts accessibles à pied sont listés. Essayez un autre « heure ».' } : {}),
        precision: 'Temps estimés avec des attentes MOYENNES (moitié de l\'intervalle entre deux passages) : un trajet précis se calcule avec « itineraire ».',
      };
    },
  });

  // --- Tarifs --------------------------------------------------------------------
  tools.push({
    name: 'tarifs',
    title: 'Tarifs des tickets',
    description: 'Prix du ticket Tisséo (acheté avant de monter ou à bord), durée de validité et correspondances incluses, pour une ligne ou pour tout le réseau (dont la navette Aéroport). Abonnements et tarifs réduits ne sont pas publiés en open data.',
    inputSchema: {
      type: 'object',
      properties: { ligne: { type: 'string', description: 'Une ligne précise (sinon : tous les tarifs du réseau).' } },
      additionalProperties: false,
    },
    async handler({ ligne }) {
      if (!svc.fares?.fares?.length) throw new ToolError('Tarifs non disponibles (absents des données chargées).');
      if (ligne) {
        const lignes = oneLine(ligne);
        return { lignes: lignes.map((r) => ({ ligne: r.short_name, mode: modeOf(r), tarif: fareFor([r.route_id]) })) };
      }
      const byFare = new Map();
      for (const r of routes) for (const fid of svc.fares.routes?.[r.route_id] ?? []) (byFare.get(fid) ?? byFare.set(fid, []).get(fid)).push(r.short_name);
      return {
        tarifs: svc.fares.fares.map((f) => {
          const ls = byFare.get(f.id) ?? [];
          return {
            prix: euros(f.price),
            achat: f.on_board ? 'à bord' : 'avant de monter (distributeur, appli, agence)',
            validite_min: f.duration_s ? Math.round(f.duration_s / 60) : null,
            correspondances_incluses: f.transfers,
            lignes: ls.length > 12 ? `${ls.length} lignes` : ls,
          };
        }),
        note: 'Tarif plein d\'après les données publiées par Tisséo. Abonnements, tarifs réduits, Pastel et gratuités ne sont pas publiés en open data : voir tisseo.fr.',
      };
    },
  });

  // --- search / fetch (recherche approfondie de ChatGPT) ---------------------------
  // ChatGPT exige ces deux noms et ces formes pour la recherche approfondie et
  // les connaissances d'entreprise : search → { results: [{ id, title, url }] },
  // fetch → { id, title, text, url, metadata }.
  const BASE = svc.publicUrl || 'https://tisseo.plagnito.com';
  tools.push({
    name: 'search',
    title: 'Rechercher (lignes, arrêts, perturbations)',
    description: 'Recherche dans le réseau Tisséo : lignes, arrêts et perturbations correspondant à la requête. Renvoie des identifiants à passer à « fetch » pour le détail.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Texte recherché (ex. "métro A", "Jean Jaurès", "travaux").' } },
      required: ['query'],
      additionalProperties: false,
    },
    async handler({ query }) {
      const results = [];
      for (const r of findLines(query).slice(0, 5)) {
        results.push({ id: `ligne:${r.route_id}`, title: `${lineLabel(r)} — ${r.long_name}`, url: `${BASE}/?ligne=${encodeURIComponent(r.short_name)}` });
      }
      const seen = new Set();
      for (const h of stopHits(query, 6).hits) {
        const { id } = pickNamed(h);
        if (seen.has(norm(stops[id].n))) continue;
        seen.add(norm(stops[id].n));
        results.push({ id: `arret:${id}`, title: `Arrêt ${stops[id].n}`, url: `${BASE}/?arret=${encodeURIComponent(id)}` });
      }
      try {
        const c = await svc.liveOrNull();
        const toks = norm(query).split(' ').filter((x) => x.length > 2);
        for (const a of c?.snap?.alerts ?? []) {
          const txt = norm(`${a.title} ${stripHtml(a.description)}`);
          if (toks.length && toks.every((x) => txt.includes(x))) results.push({ id: `alerte:${a.id}`, title: stripHtml(a.title), url: a.url || BASE });
          if (results.length >= 20) break;
        }
      } catch { /* sans temps réel : lignes et arrêts suffisent */ }
      return { results };
    },
  });

  tools.push({
    name: 'fetch',
    title: 'Détail d\'un résultat',
    description: 'Détail complet d\'un résultat de « search » (ligne, arrêt ou perturbation), en texte.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Identifiant renvoyé par « search » (ex. "ligne:line:61").' } },
      required: ['id'],
      additionalProperties: false,
    },
    async handler({ id }) {
      const [kind, ...rest] = String(id).split(':');
      const key = rest.join(':');
      const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
      if (kind === 'ligne') {
        const r = routeById.get(key);
        if (!r) throw new ToolError(`Ligne inconnue : ${key}`);
        const f = await byName.ligne.handler({ ligne: key });
        const L = f.lignes[0];
        const text = [
          `${lineLabel(r)} — ${r.long_name}.`,
          L.vehicules_en_circulation != null ? `Véhicules en circulation : ${L.vehicules_en_circulation}.` : '',
          L.tarif?.ticket ? `Ticket : ${L.tarif.ticket} (${L.tarif.validite_min} min, correspondances incluses).` : '',
          L.accessibilite ? `Accessibilité : ${L.accessibilite}.` : '',
          ...L.sens.map((s) => `Vers ${s.vers} (${s.nombre_arrets} arrêts${s.longueur_km ? `, ${s.longueur_km} km` : ''}) : ${s.premier_depart ? `premier départ ${s.premier_depart}, dernier ${s.dernier_depart}, ${s.departs_du_jour} départs ${f.jour}. Fréquences : ${Object.entries(s.frequences).map(([k, v]) => `${k} ${v.toutes_les_min ? `toutes les ${v.toutes_les_min} min` : `${v.passages} passage(s)`}`).join(' ; ')}.` : s.service}${s.arrets ? ` Arrêts : ${s.arrets.join(', ')}.` : ''}`),
          L.perturbations.length ? `Perturbations : ${L.perturbations.map((a) => a.titre).join(' | ')}.` : 'Aucune perturbation signalée sur cette ligne.',
        ].filter(Boolean).join('\n');
        return { id, title: `${lineLabel(r)} — ${r.long_name}`, text, url: `${BASE}/?ligne=${encodeURIComponent(r.short_name)}`, metadata: { type: 'ligne', mode: modeOf(r), ligne: r.short_name } };
      }
      if (kind === 'arret') {
        if (!stops[key]) throw new ToolError(`Arrêt inconnu : ${key}`);
        const f = await byName.arret.handler({ arret: key, passages: 10 });
        const text = [
          `Arrêt ${f.arret.nom} (${f.arret.quais} quai(s), ${f.arret.lat},${f.arret.lon}). Accessibilité en fauteuil : ${f.accessibilite_fauteuil}.`,
          `Lignes : ${f.lignes.map((l) => `${l.mode} ${l.ligne}${l.directions.length ? ` (vers ${l.directions.join(' / ')})` : ''}`).join(' ; ')}.`,
          f.prochains_passages?.length ? `Prochains passages (à ${f.heure}) : ${f.prochains_passages.map((d) => `${d.ligne} → ${d.destination} à ${d.heure} (${d.source})`).join(' ; ')}.` : 'Aucun passage dans les deux prochaines heures.',
          f.perturbations.length ? `Perturbations : ${f.perturbations.map((a) => a.titre).join(' | ')}.` : '',
        ].filter(Boolean).join('\n');
        return { id, title: `Arrêt ${f.arret.nom}`, text, url: `${BASE}/?arret=${encodeURIComponent(key)}`, metadata: { type: 'arret', lignes: f.lignes.map((l) => l.ligne) } };
      }
      if (kind === 'alerte') {
        const c = await live();
        const a = c.snap.alerts.find((x) => x.id === key);
        if (!a) throw new ToolError('Perturbation introuvable (terminée ou retirée par Tisséo).');
        const ls = (a.routes ?? []).map((x) => routeById.get(x)?.short_name ?? x);
        return { id, title: stripHtml(a.title), text: `${stripHtml(a.description)}${ls.length ? `\nLignes concernées : ${ls.join(', ')}.` : ''}`, url: a.url || BASE, metadata: { type: 'perturbation', lignes: ls } };
      }
      throw new ToolError(`Identifiant non reconnu : « ${id} » (attendu ligne:…, arret:… ou alerte:…).`);
    },
  });

  // Les comptes enregistrent des lieux : ils passent par le MÊME résolveur que
  // les outils, pour qu'un trajet enregistré désigne exactement l'endroit que
  // « itineraire » aurait compris. Propriété non énumérable : la liste d'outils
  // reste une liste d'outils.
  Object.defineProperty(tools, 'resoudreLieu', { value: async (q) => describePlace(await resolvePlace(q)) });
  return tools;
}

export const INSTRUCTIONS = [
  'Réseau de transports en commun de Toulouse (Tisséo) : métro A et B, tram T1, téléphérique Téléo, navette Aéroport, bus (Linéo L1…L14 et lignes numérotées). Appelle « lignes » pour la liste à jour.',
  'Les heures sont en heure de Paris. Les positions des véhicules sont ESTIMÉES (Tisséo ne publie pas le GPS) ; le métro n\'a pas de temps réel : ses positions et passages viennent des horaires théoriques. Chaque réponse dit la provenance de ses données : répète-la quand elle compte.',
  'Provenance : chaque horaire porte « source » = realtime (publié par le temps réel de Tisséo), gtfs (horaire théorique, sans retards), interpolation (position déduite entre deux heures réelles) ou estimation (durée calculée). « age_donnees_sec » dit l\'âge d\'une donnée temps réel, « retard_sec » le retard (négatif = avance), « horaire_theorique » l\'heure prévue. Ne présente jamais un gtfs ou une estimation comme certain. Après minuit, « jour_service » indique à quel jour de service le passage appartient.',
  'Pour « comment j\'y vais maintenant ? » : « trajet_maintenant » (résumé en une phrase dans « resume », plan B si l\'on rate le premier véhicule, perturbations). Pour un trajet plus tard ou comparé : « itineraire » avec les lieux tels que l\'utilisateur les dit (adresse, lieu connu, arrêt) ; « arriver_avant » pour une heure d\'arrivée, « options » pour comparer, « eviter » / « sans_modes » pour exclure. Vérifie « interprete_comme » et signale un lieu mal compris. Signale toute « correspondance_risquee » et toute étape « aucun départ disponible ».',
  'Prochain bus d\'un arrêt vers un autre (ligne directe) : « prochains_passages_vers » (trouve seul la ligne, le sens et les quais, et dit si le dernier vient de partir). Prochains passages dans un sens précis : « prochains_passages » avec « direction » (terminus ou arrêt plus loin) — sinon les deux sens sont mêlés. Utilise « resume » quand il existe.',
  'Prochain passage : « prochains_passages ». Premier/dernier passage, fréquences, horaires d\'un autre jour : « horaires ». Tout sur un arrêt : « arret ». Tout sur une ligne : « ligne ». Véhicules en circulation : « vehicules » / « vehicule ». Jusqu\'où aller en N minutes : « accessibles_depuis ». Prix : « tarifs ». Travaux, grèves, déviations : « perturbations ». Vue d\'ensemble et ponctualité en direct : « etat_du_reseau ».',
  'Données : Tisséo / Toulouse Métropole (licence ODbL), géocodage IGN Géoplateforme.',
].join('\n');
