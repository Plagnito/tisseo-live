// Vélos en libre-service des autres villes : stations et disponibilités (GBFS).
//
// Même source que les réseaux de transport : le point d'accès national
// (transport.data.gouv.fr), qui recense les systèmes et le territoire de chacun.
// Seuls les systèmes À STATIONS sont repris ici (Vélib', Vélo'v, V'lille,
// LeVélo…) : une station a un nom, une place, un nombre de vélos et de bornes
// libres. Les flottes sans station (vélos et trottinettes posés sur le
// trottoir) publient des milliers de points sans lieu : hors sujet pour cette carte.
//
// Le format GBFS a trois versions en circulation ; les différences sont
// absorbées dans `normalizeGbfs` :
//   · noms en texte (v1, v2) ou en liste par langue (v3) ;
//   · num_bikes_available (v1, v2) ou num_vehicles_available (v3) ;
//   · last_reported en secondes (v1, v2) ou en date ISO (v3) ;
//   · découverte par langue (data.fr.feeds) ou directe (data.feeds).
import { distM } from './gtfs.mjs';
import { publicUrl } from './instance.mjs';

const UA = 'TisseoLive/1.6 (https://tisseo.plagnito.com)';
const RAYON_M = 8000;      // stations gardées autour du centre de la ville
const MAX_STATIONS = 700;
const INFO_TTL = 6 * 3600_000, STATUT_TTL = 60_000;

// « VLS Le Vélo TBM Bordeaux Métropole » → « Le Vélo TBM Bordeaux Métropole ».
export const bikeName = (title) => String(title ?? '').replace(/^VLS\s+/i, '').trim();

// Systèmes de vélos à stations du catalogue brut.
export function bikeEntriesFromDatasets(datasets) {
  const out = [];
  for (const d of datasets ?? []) {
    if (d.type !== 'vehicles-sharing') continue;
    const sous = d.sub_types ?? [];
    if (!sous.includes('bicycle') || sous.includes('freefloating')) continue;
    const gbfs = (d.resources ?? []).filter((r) => r.is_available !== false && r.url && /^gbfs$/i.test(r.format || ''));
    if (!gbfs.length) continue;
    out.push({
      id: d.slug, title: d.title, name: bikeName(d.title), page: d.page_url, licence: d.licence ?? null,
      zones: (d.covered_area ?? []).map((z) => ({ type: z.type, insee: String(z.insee ?? ''), nom: z.nom })),
      gbfs: gbfs.slice(0, 5).map((r) => r.url),
    });
  }
  return out;
}

// Systèmes d'une commune, le plus local d'abord. `lieu` : { insee, epci, dep, region }.
// Un système déclaré à l'échelle d'un département ou d'une région (Vélib' :
// l'Île-de-France) est retenu aussi — ce sont ses stations, filtrées autour de
// la ville, qui diront s'il la dessert vraiment.
export function bikeSystemsFor(entries, lieu) {
  const hits = [];
  for (const e of entries) {
    let force = 0;
    for (const z of e.zones) {
      if (z.type === 'commune' && z.insee === lieu.insee) force = Math.max(force, 4);
      if (z.type === 'epci' && lieu.epci && z.insee === lieu.epci) force = Math.max(force, 3);
      if (z.type === 'departement' && lieu.dep && z.insee === lieu.dep) force = Math.max(force, 2);
      if (z.type === 'region' && lieu.region && z.insee === lieu.region) force = Math.max(force, 1);
    }
    // À territoire égal, le service public de vélos (« VLS … ») avant une
    // offre de micromobilité qui a aussi des stations.
    if (force) hits.push({ e, force: force + (/^VLS\b/i.test(e.title) ? 0.5 : 0) });
  }
  return hits.sort((a, b) => b.force - a.force).map((h) => h.e);
}

const texte = (x) => {
  if (Array.isArray(x)) return String((x.find((t) => t?.language === 'fr') ?? x[0])?.text ?? '').trim();
  return String(x ?? '').trim();
};
const nombre = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
const instant = (x) => {
  if (x == null || x === '') return null;
  const n = Number(x);
  if (Number.isFinite(n)) return n > 0 ? Math.floor(n > 1e12 ? n / 1000 : n) : null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
const vrai = (x) => (x === true || x === 1 || x === '1' ? true : x === false || x === 0 || x === '0' ? false : null);
// Capitales intégrales (« ROUVILLE ») → « Rouville ».
const joli = (s) => (s && s === s.toUpperCase() && /[A-ZÀ-Ý]{2}/.test(s) ? s.toLowerCase().replace(/(^|[\s\-'’(/.])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase()) : s);

// Flux d'une découverte gbfs.json : { station_information: url, … }.
export function gbfsFeeds(discovery) {
  const d = discovery?.data;
  const feeds = Array.isArray(d?.feeds) ? d.feeds : (d?.fr?.feeds ?? Object.values(d ?? {}).find((x) => Array.isArray(x?.feeds))?.feeds ?? []);
  return Object.fromEntries(feeds.filter((f) => f?.name && f?.url).map((f) => [f.name, f.url]));
}

// Stations + statuts (+ types de véhicules) → lieux de la catégorie « vélos »,
// de la même forme que ceux de Toulouse (lib/city.mjs, normalizeBikes).
export function normalizeGbfs(info, status, types, { systeme, profile, rayonM = RAYON_M, max = MAX_STATIONS } = {}) {
  const parId = new Map((status?.data?.stations ?? []).map((s) => [String(s.station_id), s]));
  const genres = new Map((types?.data?.vehicle_types ?? []).map((t) => [String(t.vehicle_type_id), t]));
  const estVelo = (id) => { const t = genres.get(String(id)); return !t || /bicycle/.test(t.form_factor ?? ''); };
  const electrique = (id) => { const t = genres.get(String(id)); return t ? /electric/.test(t.propulsion_type ?? '') : /elec|ebike|e-bike/i.test(String(id)); };
  const out = [];
  for (const r of info?.data?.stations ?? []) {
    const lat = Number(r.lat), lon = Number(r.lon);
    const nom = joli(texte(r.name));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon) || !nom) continue;
    const d = profile ? distM(profile.lat, profile.lon, lat, lon) : 0;
    if (d > rayonM) continue;
    const s = parId.get(String(r.station_id));
    let velos = null, meca = null, elec = null;
    if (s) {
      const parType = Array.isArray(s.vehicle_types_available) ? s.vehicle_types_available.filter((v) => estVelo(v.vehicle_type_id)) : null;
      if (parType?.length && genres.size) {
        velos = parType.reduce((n, v) => n + (nombre(v.count) ?? 0), 0);
        elec = parType.filter((v) => electrique(v.vehicle_type_id)).reduce((n, v) => n + (nombre(v.count) ?? 0), 0);
        meca = velos - elec;
      } else {
        velos = nombre(s.num_bikes_available ?? s.num_vehicles_available);
        // Vélib' : [{ mechanical: 3 }, { ebike: 5 }].
        for (const t of Array.isArray(s.num_bikes_available_types) ? s.num_bikes_available_types : []) {
          if (nombre(t.mechanical) !== null) meca = nombre(t.mechanical);
          if (nombre(t.ebike) !== null) elec = nombre(t.ebike);
        }
        if (parType?.length && meca === null && elec === null) {
          elec = parType.filter((v) => electrique(v.vehicle_type_id)).reduce((n, v) => n + (nombre(v.count) ?? 0), 0);
          meca = Math.max(0, (velos ?? 0) - elec);
        }
      }
    }
    const places = s ? nombre(s.num_docks_available) : null;
    const service = s ? vrai(s.is_installed) : null;
    const details = [];
    if (nombre(r.capacity)) details.push({ label: 'Capacité', value: String(nombre(r.capacity)) });
    if (meca !== null && elec !== null && (meca || elec)) { details.push({ label: 'Vélos mécaniques', value: String(meca) }); details.push({ label: 'Vélos électriques', value: String(elec) }); }
    if (service === false) details.push({ label: 'État publié', value: 'station hors service' });
    out.push({
      lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5,
      category: 'bikes', id: `bikes:${systeme?.id ?? 'gbfs'}:${r.station_id}`,
      city_id: profile?.id, city: profile?.name ?? '',
      name: nom, address: joli(texte(r.address)), subtitle: `Station ${systeme?.name ?? 'vélos en libre-service'}`,
      bikes: velos, docks: places !== null && places < 5000 ? places : null,
      reported_at: s ? instant(s.last_reported) : null,
      renting: s ? vrai(s.is_renting) : null, returning: s ? vrai(s.is_returning) : null,
      details,
      description: 'La disponibilité est publiée par l’exploitant. Vérifie l’âge du relevé avant de te déplacer.',
      url: r.rental_uris?.web ?? systeme?.page ?? '', phone: '',
      opening_hours: '', wheelchair: 'unknown', vegetarian: false, free_access: null, opening_state: 'unknown',
      source_url: systeme?.page ?? '', source_label: `${systeme?.name ?? 'Vélos en libre-service'} · GBFS`,
      _d: d,
    });
  }
  out.sort((a, b) => a._d - b._d);
  return out.slice(0, max).map(({ _d, ...p }) => p);
}

// lieuDe(cityId) → { insee, epci, dep, region } ; systemes() → fiches du catalogue.
export function createBikes({ systemes, lieuDe, fetcher = fetch, now = () => Date.now() }) {
  const cache = new Map(); // url → { at, value }
  // Une réponse périmée est servie tout de suite, et relue derrière : le flux
  // de Vélib' met parfois vingt secondes à répondre, personne ne doit les attendre
  // deux fois. Au-delà de dix minutes, elle n'est plus servie.
  const enCours = new Map();
  async function json(url, ttl) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttl) return hit.value;
    if (!enCours.has(url)) enCours.set(url, lire(url).finally(() => enCours.delete(url)));
    const tache = enCours.get(url);
    if (hit && now() - hit.at < Math.max(ttl, 10 * 60_000)) { tache.catch(() => {}); return hit.value; }
    return tache;
  }
  async function lire(url) {
    let u = publicUrl(url), res = null;
    for (let saut = 0; u && saut < 5; saut++) {
      res = await fetcher(u, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = publicUrl(new URL(res.headers.get('location'), u).href); res = null; continue; }
      break;
    }
    if (!res) throw new Error('adresse refusée');
    if (!res.ok) throw new Error(`GBFS HTTP ${res.status}`);
    const value = await res.json();
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    cache.set(url, { at: now(), value });
    return value;
  }
  // Première découverte du système qui annonce des stations.
  async function flux(systeme) {
    for (const url of systeme.gbfs) {
      try {
        const f = gbfsFeeds(await json(url, INFO_TTL));
        if (f.station_information && f.station_status) return f;
      } catch { /* découverte suivante */ }
    }
    return null;
  }
  async function forCity(cityId) {
    const m = /^fr:([\dAB]{5})$/.exec(String(cityId ?? ''));
    if (!m) return [];
    return bikeSystemsFor(await systemes(), await lieuDe(m[1]));
  }
  // Lieux « vélos » d'une ville, ou null si aucun système à stations ne la dessert.
  async function places(profile) {
    let liste;
    try { liste = await forCity(profile?.id); } catch { return null; }
    for (const systeme of liste.slice(0, 3)) {
      const f = await flux(systeme);
      if (!f) continue;
      let info;
      try { info = await json(f.station_information, INFO_TTL); } catch { continue; }
      let status = null, types = null;
      try { status = await json(f.station_status, STATUT_TTL); if (!Array.isArray(status?.data?.stations)) status = null; } catch { /* stations sans disponibilités */ }
      if (f.vehicle_types) { try { types = await json(f.vehicle_types, INFO_TTL); } catch { /* types inconnus */ } }
      const stations = normalizeGbfs(info, status, types, { systeme, profile });
      if (!stations.length) continue; // le système couvre la région, pas cette ville
      const maj = instant(status?.last_updated);
      return {
        category: 'bikes', live: true, system: { id: systeme.id, name: systeme.name },
        source: { label: `${systeme.name} · GBFS`, url: systeme.page, license: systeme.licence === 'odc-odbl' ? 'ODbL' : 'Licence Ouverte' },
        status: 'ok', fetched_at: new Date(now()).toISOString(),
        source_updated_at: maj ? new Date(maj * 1000).toISOString() : null,
        places: stations,
        ...(status ? {} : { availability_unavailable: true, message: 'Stations localisées ; disponibilités indisponibles.' }),
      };
    }
    return null;
  }
  return { forCity, places };
}
