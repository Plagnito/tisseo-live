// Sources publiques du mode Ville. Aucun lieu ni disponibilité inventés.
import { facts, openingState, eventTags, deduplicateEvents, slimEvent } from './city-explore.mjs';
const ODS = 'https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/';
const GBFS = 'https://api.cyclocity.fr/contracts/toulouse/gbfs/';
const PUBLIC_ODS = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/';
const HOUR = 3_600_000;
const datasetUrl = (id) => `https://data.toulouse-metropole.fr/explore/dataset/${id}/`;

export const CITY_CATEGORIES = [
  { id: 'bikes', label: 'VélÔToulouse', group: 'mobility', icon: 'bike', color: '#55c9bc', live: true },
  { id: 'parking', label: 'Parkings', group: 'mobility', icon: 'parking', color: '#79a9f4' },
  { id: 'events', label: 'Événements', group: 'discover', icon: 'calendar', color: '#f5bd71' },
  { id: 'culture', label: 'Culture', group: 'discover', icon: 'culture', color: '#bf9af1' },
  { id: 'visits', label: 'À visiter', group: 'discover', icon: 'landmark', color: '#edb09e' },
  { id: 'food', label: 'Restaurants & cafés', group: 'discover', icon: 'food', color: '#f19585' },
  { id: 'parks', label: 'Parcs & jardins', group: 'discover', icon: 'leaf', color: '#9ace83' },
  { id: 'markets', label: 'Marchés', group: 'discover', icon: 'market', color: '#e4ba7a' },
  { id: 'sports', label: 'Sport', group: 'discover', icon: 'sport', color: '#75b9c5' },
  { id: 'libraries', label: 'Bibliothèques', group: 'daily', icon: 'book', color: '#acb9f7' },
  { id: 'services', label: 'Mairies & services', group: 'daily', icon: 'building', color: '#9cb8c8' },
  { id: 'water', label: 'Fontaines à boire', group: 'daily', icon: 'water', color: '#7ec8f1' },
  { id: 'toilets', label: 'Toilettes', group: 'daily', icon: 'pin', color: '#c3b9b0' },
  { id: 'works', label: 'Travaux & voirie', group: 'daily', icon: 'works', color: '#f4ac69' },
];

const SOURCES = {
  parking: { dataset: 'parcs-de-stationnement', fields: 'geo_point_2d,id,nom,adresse,commune,nb_places,nb_pmr,gratuit,hauteur_max,tarif_1h,gestionnaire' },
  events: { dataset: 'agenda-des-manifestations-culturelles-so-toulouse', ttl: 20 * 60_000,
    fields: 'geo_point,identifiant,nom_de_la_manifestation,descriptif_court,date_debut,date_fin,horaires,lieu_nom,lieu_adresse_2,commune,categorie_de_la_manifestation,reservation_site_internet,manifestation_gratuite,tarif_normal' },
  culture: { dataset: 'equipements-culturels1', fields: 'geo_point_2d,eq_nom_equipement,numero,lib_off,eq_ville,eq_musee,eq_cinema,eq_galerie_lieu_exposition,eq_salle_de_spectacle,eq_centre_culturel,eq_cafe_concert' },
  parks: { dataset: 'espaces-verts', fields: 'geo_point_2d,id_vert,nom,adresse,commune' },
  markets: { dataset: 'marches-couverts-et-de-plein-vent', fields: 'geo_point_2d,nom,type,adresse,jours_de_tenue,lundi,mardi,mercredi,jeudi,vendredi,samedi,dimanche' },
  sports: { dataset: 'equipements-sportifs', fields: 'geo_point_2d,oid,nom_installation,nom_equipement,type_equipement,adresse,acces_libre' },
  libraries: { dataset: 'mediatheques-bibliotheques-et-bibliobus', fields: 'geo_point_2d,oid,nom,adresse,telephone,site_internet,commune,accessibilite_pmr,wifi' },
  services: { dataset: 'mairies-annexes', fields: 'geo_point_2d,mairie,num,libelle,horaire_ouverture,telephone,type' },
  water: { dataset: 'fontaines-a-boire', fields: 'geo_point_2d,id_fontaines_a_boire,localisation,adresse,commune,statut' },
  works: { dataset: 'chantiers-en-cours', ttl: 20 * 60_000, fields: 'geo_point_2d,numero,voie,commune,datedebut,datefin,libelle,commentaire,circulation' },
};
const text = (v) => v == null ? '' : String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const yes = (v) => /^(oui|yes|true|t|1)$/i.test(String(v));
const num = (v) => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
export function safeUrl(value) {
  const raw = text(value);
  if (!raw || /^(javascript|data|file|vbscript):/i.test(raw)) return null;
  try {
    const u = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
export function parisDay(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

function point(r) {
  const p = r.geo_point_2d || r.geo_point || r.geopoint;
  const lat = num(p?.lat ?? r.lat), lon = num(p?.lon ?? r.lon);
  // Périmètre métropolitain. Rejette aussi les valeurs nulles et les 0,0.
  return lat !== null && lon !== null && lat >= 43.35 && lat <= 43.9 && lon >= 1.05 && lon <= 1.85 ? { lat, lon } : null;
}
const fields = (pairs) => pairs.filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([label, value]) => ({ label, value: text(value) }));

export function normalizeRecord(category, r, index = 0, today = parisDay()) {
  const p = point(r);
  if (!p) return null;
  const stableKey = `${text(r.nom || r.eq_nom_equipement || r.mairie)}|${p.lat}|${p.lon}`;
  const place = { ...p, category, id: `${category}:${r.id ?? r.oid ?? r.identifiant ?? (category === 'works' ? r.numero : null) ?? r.id_vert ?? r.id_fontaines_a_boire ?? stableKey}`,
    name: text(r.nom || r.eq_nom_equipement || r.nom_installation || r.localisation || r.mairie || r.nom_de_la_manifestation || r.voie),
    address: text(r.adresse || r.lieu_adresse_2 || [category === 'services' ? r.num : category === 'culture' ? r.numero : '', category === 'services' ? r.libelle : r.lib_off].filter(Boolean).join(' ')),
    city: text(r.commune || r.eq_ville), description: '', details: [], url: safeUrl(r.site_internet), phone: text(r.telephone) };
  switch (category) {
    case 'parking':
      place.subtitle = 'Parking public';
      place.details = fields([['Capacité totale', num(r.nb_places)], ['Places PMR', num(r.nb_pmr)], ['Tarif publié / 1 h', num(r.tarif_1h) === null ? null : `${r.tarif_1h} €`], ['Hauteur maximale', num(r.hauteur_max) === null ? null : `${r.hauteur_max} m`], ['Gestionnaire', r.gestionnaire]]);
      place.description = 'Capacité et tarifs publiés. Le nombre de places libres et les tarifs actuels ne sont pas vérifiés en direct.';
      break;
    case 'events': {
      const start = text(r.date_debut).slice(0, 10), end = text(r.date_fin || r.date_debut).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < today) return null;
      place.start_date = start; place.end_date = end;
      place.subtitle = text(r.categorie_de_la_manifestation || 'Événement');
      place.description = text(r.descriptif_court);
      place.details = fields([['Lieu', r.lieu_nom], ['Horaires', r.horaires], ['Tarif publié', yes(r.manifestation_gratuite) ? 'Gratuit' : r.tarif_normal]]);
      place.url = safeUrl(r.reservation_site_internet);
      break;
    }
    case 'culture': {
      const types = [['eq_musee', 'Musée'], ['eq_cinema', 'Cinéma'], ['eq_galerie_lieu_exposition', 'Galerie / exposition'], ['eq_salle_de_spectacle', 'Salle de spectacle'], ['eq_centre_culturel', 'Centre culturel'], ['eq_cafe_concert', 'Café concert']];
      const kind = types.filter(([key]) => yes(r[key])).map(([, label]) => label).join(' · ');
      // Plusieurs indicateurs de type sont à F même pour des théâtres et
      // centres culturels. L'appartenance au jeu reste l'information fiable.
      place.subtitle = kind || 'Équipement culturel';
      break;
    }
    case 'parks':
      if (!/\b(parc|jardin|square|promenade|zone verte|base de loisirs)\b/i.test(place.name)) return null;
      place.subtitle = 'Espace vert'; break;
    case 'markets':
      place.subtitle = text(r.type || 'Marché');
      place.details = fields([['Jours de tenue', r.jours_de_tenue], ...['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'].map((d) => [d[0].toUpperCase() + d.slice(1), r[d]])]);
      break;
    case 'sports':
      place.subtitle = text(r.type_equipement || 'Équipement sportif');
      place.details = fields([['Équipement', r.nom_equipement], ['Accès libre publié', r.acces_libre == null ? null : yes(r.acces_libre) ? 'Oui' : 'Non']]); break;
    case 'libraries':
      place.subtitle = 'Bibliothèque / médiathèque';
      place.details = fields([['Wi-Fi', r.wifi], ['Accès PMR', r.accessibilite_pmr]]); break;
    case 'services':
      place.name = `Mairie · ${place.name}`;
      place.subtitle = text(r.type || 'Service public');
      place.details = fields([['Horaires', r.horaire_ouverture || r.horaire_ou]]); break;
    case 'water':
      place.name = `Fontaine · ${place.name || place.address}`;
      place.subtitle = 'Fontaine à boire';
      place.description = 'Point référencé par la Métropole. Son fonctionnement n’est pas vérifié en direct.';
      place.details = fields([['Statut publié', r.statut]]); break;
    case 'works': {
      const end = text(r.datefin).slice(0, 10);
      if (!end || end < today) return null;
      place.start_date = text(r.datedebut).slice(0, 10); place.end_date = end;
      place.subtitle = place.start_date > today ? 'Chantier à venir' : 'Chantier en cours';
      place.description = text(r.libelle);
      place.details = fields([['Circulation', r.circulation], ['Informations', r.commentaire]]);
      break;
    }
  }
  Object.assign(place, facts({ ...r, wheelchair: r.accessibilite_pmr }));
  if (category === 'events') place.tags = eventTags([place.name, place.subtitle, place.description, ...place.details.map((d) => d.value)].join(' '));
  return place.name ? place : null;
}

export function normalizeOsm(category, element) {
  const t = element.tags || {};
  const p = point({ lat: element.lat ?? element.center?.lat, lon: element.lon ?? element.center?.lon });
  if (!p) return null;
  const kinds = { restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Restauration rapide', bar: 'Bar', pub: 'Pub', toilets: 'Toilettes publiques', museum: 'Musée', attraction: 'Lieu à visiter', gallery: 'Galerie', artwork: 'Œuvre dans l’espace public' };
  return { ...p, ...facts(t), category, id: `${category}:osm:${element.type}:${element.id}`,
    name: text(t.name || t['name:fr'] || (category === 'toilets' ? 'Toilettes publiques' : '')),
    subtitle: kinds[t.amenity || t.tourism] || 'Patrimoine',
    address: text([t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ')), city: text(t['addr:city']),
    url: safeUrl(t.website || t['contact:website']), phone: text(t.phone || t['contact:phone']), description: text(t.description),
    source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    details: fields([['Cuisine', t.cuisine], ['Horaires déclarés', t.opening_hours], ['Accès PMR déclaré', t.wheelchair], ['Accès', t.access], ['Payant', t.fee]]) };
}

export function normalizeOdsOsm(category, r) {
  const p = point({ geo_point: r.meta_geo_point });
  const url = safeUrl(r.meta_osm_url);
  if (!p || !text(r.name) || !url?.startsWith('https://www.openstreetmap.org/')) return null;
  const types = { restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Restauration rapide', bar: 'Bar', pub: 'Pub', food_court: 'Restauration', ice_cream: 'Glacier', memorial: 'Mémorial', monument: 'Monument', castle: 'Château', ruins: 'Vestiges', archaeological_site: 'Site archéologique', building: 'Bâtiment historique' };
  return { ...p, ...facts(r), category, id: `${category}:osm:${url}`, name: text(r.name), subtitle: types[r.type] || (category === 'food' ? 'Restauration' : 'Patrimoine'),
    address: '', city: text(r.meta_name_com), description: text(r.description), source_url: url, url: safeUrl(r.website), phone: text(r.phone),
    details: fields([['Cuisine', Array.isArray(r.cuisine) ? r.cuisine.join(', ') : r.cuisine], ['Horaires déclarés', r.opening_hours], ['Accès PMR déclaré', r.wheelchair], ['Végétarien déclaré', r.vegetarian], ['Végan déclaré', r.vegan], ['Date de construction', r.build_date]]) };
}

export function normalizeAgenda(r, today = parisDay(), pointParser = point) {
  const p = pointParser({ geo_point: r.location_coordinates });
  let status = r.status;
  try { if (typeof status === 'string' && status.startsWith('{')) status = JSON.parse(status); } catch { status = null; }
  if (!p || !text(r.title_fr) || Number(status?.id ?? status) === 6 || /annul|cancel/i.test(status?.label?.fr || '')) return null;
  let sessions = [];
  try { sessions = (Array.isArray(r.timings) ? r.timings : JSON.parse(r.timings || '[]')).filter((s) => Number.isFinite(Date.parse(s.begin)) && Number.isFinite(Date.parse(s.end)) && parisDay(Date.parse(s.end)) >= today).map(({ begin, end }) => ({ begin, end })); } catch { /* créneaux non exploitables */ }
  if (!sessions.length) return null;
  sessions.sort((a, b) => Date.parse(a.begin) - Date.parse(b.begin));
  const end = sessions.reduce((a, b) => Date.parse(a.end) > Date.parse(b.end) ? a : b).end;
  return { ...p, category: 'events', id: `events:openagenda:${r.uid}`, name: text(r.title_fr), subtitle: text(r.originagenda_title || 'Événement OpenAgenda'),
    address: text(r.location_address), city: text(r.location_city), description: text(r.description_fr),
    start_date: parisDay(Date.parse(sessions[0].begin)), end_date: parisDay(Date.parse(end)), sessions,
    tags: eventTags([r.title_fr, r.description_fr, r.conditions_fr, ...(r.keywords_fr || [])].join(' '), r.age_min, r.age_max),
    wheelchair: /(^|,)mi(,|$)/.test(r.accessibility || '') ? 'yes' : 'unknown', opening_hours: '', free_access: null, vegetarian: false,
    url: safeUrl(r.canonicalurl), source_url: safeUrl(r.canonicalurl), source_label: 'OpenAgenda · agenda public', source_license: 'Licence Ouverte v1.0', updated_at: r.updatedat,
    details: fields([['Lieu', r.location_name], ['État publié', status?.label?.fr], ['Conditions', r.conditions_fr], ['Accessibilité publiée', r.accessibility_label_fr], ['Âge minimum', r.age_min], ['Âge maximum', r.age_max]]), phone: text(r.location_phone) };
}

export function normalizeBikes(info, status) {
  const byId = new Map((status?.data?.stations || []).map((s) => [String(s.station_id), s]));
  return (info?.data?.stations || []).flatMap((r) => {
    const p = point(r); if (!p || !text(r.name)) return [];
    const s = byId.get(String(r.station_id));
    return [{ ...p, category: 'bikes', id: `bikes:${r.station_id}`, name: text(r.name), address: text(r.address), city: 'Toulouse', subtitle: 'Station VélÔToulouse',
      bikes: s ? num(s.num_bikes_available) : null, docks: s ? num(s.num_docks_available) : null,
      reported_at: s && num(s.last_reported) > 0 ? num(s.last_reported) : null, renting: s?.is_renting ?? null, returning: s?.is_returning ?? null,
      details: fields([['Capacité', num(r.capacity)], ...((s?.vehicle_types_available || []).map((v) => [v.vehicle_type_id === 'electrical' ? 'Vélos électriques' : v.vehicle_type_id === 'mechanical' ? 'Vélos mécaniques' : text(v.vehicle_type_id), num(v.count)]))]),
      description: 'La disponibilité est publiée par Cyclocity. Vérifie l’âge du relevé avant de te déplacer.', url: 'https://www.velotoulouse.fr/', phone: '' }];
  });
}

function sourceInfo(id) {
  if (id === 'events') return { label: 'OpenAgenda / Toulouse Métropole', url: 'https://public.opendatasoft.com/explore/dataset/evenements-publics-openagenda/', license: 'Licence Ouverte (Etalab)' };
  if (id === 'bikes') return { label: 'Cyclocity / VélÔToulouse · GBFS', url: datasetUrl('velotoulouse-vls-gbfs'), license: 'ODbL' };
  if (['food', 'visits'].includes(id)) return { label: 'OpenStreetMap · export Huwise', url: `https://public.opendatasoft.com/explore/dataset/${id === 'food' ? 'osm-france-food-service' : 'osm-france-historic'}/`, license: 'ODbL' };
  if (id === 'toilets') return { label: 'OpenStreetMap · contributeurs', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL' };
  const s = SOURCES[id];
  return { label: 'Toulouse Métropole · Open Data', url: datasetUrl(s.dataset), license: 'Licence Ouverte v2.0 (Etalab)' };
}

export function cityCatalog() {
  return { city: 'Toulouse et ses alentours', categories: CITY_CATEGORIES.map((c) => ({ ...c, source: sourceInfo(c.id) })),
    notice: 'Les jeux de données ont des couvertures et des fréquences de mise à jour différentes. Cette carte ne constitue pas un annuaire exhaustif de la ville.' };
}

export function createCityService({ fetcher = fetch, now = Date.now, timeoutMs = 25_000 } = {}) {
  const cache = new Map(), pending = new Map();
  async function json(url) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json', 'User-Agent': 'ToulouseVille/1.0 (Tisseo Live city map; https://tisseo.plagnito.com/)' } });
    if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
    return response.json();
  }
  // Single-flight et délai de reprise même lors d'une panne : les clics ou
  // plusieurs clients ne doivent pas marteler la source publique.
  async function cached(key, ttl, loader) {
    const hit = cache.get(key);
    if (hit && now() < hit.retryAt) return hit.value;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      try {
        const value = { ...await loader(), fetched_at: new Date(now()).toISOString(), status: 'ok' };
        cache.set(key, { value, retryAt: now() + ttl });
        return value;
      } catch {
        const value = hit?.value?.fetched_at ? { ...hit.value, status: 'stale', message: 'Source momentanément indisponible. Dernières données conservées.' }
          : { places: [], fetched_at: null, status: 'unavailable', message: 'Source momentanément indisponible. Réessaie dans une minute.' };
        cache.set(key, { value, retryAt: now() + 60_000 });
        return value;
      } finally { pending.delete(key); }
    })();
    pending.set(key, task);
    return task;
  }
  async function ods(id, selected, where, root = ODS) {
    const query = new URLSearchParams({ select: selected, limit: '5000', timezone: 'Europe/Paris' });
    if (where) query.set('where', where);
    const [rows, meta] = await Promise.all([
      json(`${root}${id}/exports/json?${query}`),
      json(`${root}${id}`).catch(() => null),
    ]);
    if (!Array.isArray(rows)) throw new Error('Export incorrect');
    return { rows, source_updated_at: meta?.metas?.default?.data_processed ?? null };
  }
  async function osm() {
    return cached('osm', 6 * HOUR, async () => {
      const box = '(43.53,1.35,43.67,1.52)';
      const query = `[out:json][timeout:20];nwr[amenity="toilets"]${box};out center tags;`;
      const j = await json(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`);
      if (!Array.isArray(j.elements) || j.remark) throw new Error('Export OSM incomplet');
      return { places: j.elements, source_updated_at: j.osm3s?.timestamp_osm_base ?? null };
    });
  }
  return {
    async places(id) {
      if (!CITY_CATEGORIES.some((c) => c.id === id)) throw new RangeError('Catégorie inconnue');
      let result;
      const today = parisDay(now());
      if (['food', 'visits'].includes(id)) {
        result = await cached(id, 6 * HOUR, async () => {
          const dataset = id === 'food' ? 'osm-france-food-service' : 'osm-france-historic';
          const selected = 'name,type,website,meta_geo_point,meta_name_com,meta_osm_url,' + (id === 'food' ? 'phone,cuisine,opening_hours,wheelchair,vegetarian,vegan' : 'description,build_date');
          const { rows, source_updated_at } = await ods(dataset, selected, 'meta_code_com = "31555"', PUBLIC_ODS);
          return { places: rows.map((r) => normalizeOdsOsm(id, r)).filter(Boolean), source_updated_at };
        });
      } else if (id === 'events') {
        result = await cached(id, 20 * 60_000, async () => {
          const fields = 'uid,title_fr,description_fr,conditions_fr,keywords_fr,timings,accessibility,accessibility_label_fr,location_coordinates,location_name,location_address,location_city,location_phone,age_min,age_max,originagenda_title,canonicalurl,updatedat,status';
          const answers = await Promise.allSettled([
            ods('evenements-publics-openagenda', fields, `location_insee="31555" AND lastdate_end >= "${today}"`, PUBLIC_ODS),
            ods(SOURCES.events.dataset, SOURCES.events.fields, `date_fin >= "${today}"`),
          ]);
          if (answers.every((a) => a.status === 'rejected')) throw new Error('Agendas indisponibles');
          const places = answers.flatMap((a, i) => a.status === 'fulfilled' ? a.value.rows.map((r) => i === 0 ? normalizeAgenda(r, today) : normalizeRecord(id, r, 0, today)).filter(Boolean).map((p) => i === 0 ? p : { ...p, source_url: datasetUrl(SOURCES.events.dataset), source_label: 'Toulouse Métropole · agenda', source_license: 'Licence Ouverte v2.0' }) : []);
          return { places: deduplicateEvents(places), sources: answers.map((a, i) => ({ label: i === 0 ? 'OpenAgenda' : 'Toulouse Métropole', status: a.status === 'fulfilled' ? 'ok' : 'unavailable', updated_at: a.status === 'fulfilled' ? a.value.source_updated_at : null })),
            message: answers.some((a) => a.status === 'rejected') ? 'Un agenda est indisponible ; les autres sorties restent consultables.' : undefined };
        });
      } else if (id === 'toilets') {
        const raw = await osm();
        result = { ...raw, places: raw.places.filter((e) => {
          const t = e.tags || {};
          return t.amenity === 'toilets' && !['private', 'no', 'customers'].includes(t.access);
        }).map((e) => normalizeOsm(id, e)).filter((p) => p?.name) };
      } else {
        const s = SOURCES[id];
        result = await cached(id, id === 'bikes' ? 60_000 : s.ttl || 6 * HOUR, async () => {
          if (id === 'bikes') {
            // La localisation se conserve six heures ; seul le statut est relu à la minute.
            const info = await cached('bike-info', 6 * HOUR, async () => ({ places: [], info: await json(`${GBFS}station_information.json`) }));
            if (!info.info) throw new Error('Stations indisponibles');
            let status = null;
            try { status = await json(`${GBFS}station_status.json`); if (!Array.isArray(status?.data?.stations)) throw new Error('Statut incorrect'); }
            catch { /* On peut afficher les stations, avec disponibilités explicitement inconnues. */ }
            return { places: normalizeBikes(info.info, status), source_updated_at: status?.last_updated ? new Date(status.last_updated * 1000).toISOString() : null,
              availability_unavailable: !status, message: status ? undefined : 'Stations localisées ; disponibilités indisponibles.' };
          }
          let { rows, source_updated_at } = await ods(s.dataset, s.fields, id === 'events' ? `date_fin >= "${today}"` : id === 'works' ? `datefin >= "${today}"` : undefined);
          if (id === 'services') {
            const other = await ods('mairies', 'geo_point_2d,mairie,num,libelle,horaire_ou,telephone,type');
            rows = rows.concat(other.rows.map((r) => ({ ...r, __dataset: 'mairies' })));
          }
          const seen = new Set();
          const places = rows.map((r, i) => {
            const p = normalizeRecord(id, r, i, today);
            if (p) p.source_url = datasetUrl(r.__dataset || s.dataset);
            return p;
          }).filter((p) => {
            if (!p) return false;
            const key = id === 'parks' ? `${p.name}|${p.address}` : p.id;
            if (seen.has(key)) return false;
            seen.add(key); return true;
          });
          return { places, source_updated_at };
        });
      }
      // Même un cache conservé hors ligne ne doit jamais ressortir les événements terminés.
      const places = (['events', 'works'].includes(id) ? result.places.filter((p) => p.end_date >= today) : result.places).map((p) => ({ ...(id === 'events' ? slimEvent(p) : p), opening_state: openingState(p.opening_hours, now()) }));
      return { ...result, places, count: places.length, category: id, source: sourceInfo(id),
        message: result.message || (id === 'events' && !places.length ? 'Aucun événement à venir géolocalisé dans cet agenda public. Consulte aussi l’agenda municipal.' : undefined) };
    },
  };
}
