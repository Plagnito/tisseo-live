// Outils MCP du mode VILLE — lieux, agenda, météo, marche.
// ---------------------------------------------------------------
// Le connecteur ne savait que les transports. L'application, elle, montre aussi
// la ville : vélos, sorties, parcs, services, zones accessibles à pied, balades.
// Ces outils exposent les MÊMES services que la carte (lib/city.mjs,
// lib/cities.mjs, lib/city-context.mjs) : un assistant lit ce que l'écran lit,
// avec les mêmes caches et les mêmes limites.
//
// Trois règles tenues partout ici, parce que ce sont celles de la carte :
//   • une valeur inconnue reste inconnue — un lieu sans horaires n'est ni
//     « ouvert » ni « fermé », et il ne passe pas un filtre « ouvert » ;
//   • une source en panne est DITE (« etat ») au lieu de rendre une liste vide
//     qui se lirait « il n'y a rien » ;
//   • les listes sont bornées : une catégorie compte des centaines de lieux,
//     et un modèle ne lit pas 700 fiches. On dit combien il en reste.
// ---------------------------------------------------------------
import { ToolError } from './mcp.mjs';
import { haversineM } from './core.mjs';
import { openingState, eventOnDay, eventTonight, walkingBand, parisDay } from './city-explore.mjs';
import { worldPoint } from './city-context.mjs';

const LECTURE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const sansAccent = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const court = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

export function createCityTools({ cities, cityService, cityContext, profileCatalog, resoudreLieu = null, reseaux = null, now = () => Date.now() }) {
  const tools = [];
  const P = { type: 'string' };
  const o = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const VILLE = { ...P, description: 'Nom de la ville ("Lyon") ou identifiant rendu par « ville_rechercher » (ex. "fr:69123"), à préférer quand plusieurs villes portent le même nom. Défaut : Toulouse.' };

  // Un assistant écrit spontanément un NOM (« Toulouse », « Lyon ») là où
  // l'on attendait un identifiant. On le comprend quand il désigne une seule
  // ville ; sinon on nomme les candidates au lieu d'en choisir une au hasard.
  async function profil(id) {
    const brut = id == null ? '' : String(id).trim();
    try { return await cities.get(brut || undefined); } catch { /* ce n'est pas un identifiant connu */ }
    if (brut && !/^(fr|geo):/i.test(brut)) {
      const defaut = await cities.get();
      if (sansAccent(brut) === sansAccent(defaut.name)) return defaut;
      let liste = [];
      try { liste = await cities.search(brut); } catch { throw new ToolError('Annuaire des villes momentanément indisponible. Réessaie dans une minute.'); }
      const exactes = liste.filter((p) => sansAccent(p.name) === sansAccent(brut));
      const choix = exactes.length ? exactes : liste;
      if (choix.length === 1) return choix[0];
      if (choix.length > 1) {
        const noms = choix.slice(0, 5).map((p) => `${p.name}${p.region ? ` (${p.region})` : ''}${p.country && p.country !== 'France' ? `, ${p.country}` : ''} = "${p.id}"`).join(' ; ');
        throw new ToolError(`Plusieurs villes pour « ${brut} » : ${noms}. Reprends avec l'identifiant voulu.`);
      }
    }
    throw new ToolError(`Ville inconnue : « ${brut} ». Utilise « ville_rechercher » pour obtenir son identifiant.`);
  }

  /** "lat,lon", ou — à Toulouse seulement — un arrêt, une adresse, un lieu. */
  async function point(q, profile, quoi) {
    const raw = String(q ?? '').trim();
    if (!raw) throw new ToolError(`${quoi} : indique un lieu.`);
    const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const p = worldPoint(m[1], m[2]);
      if (!p) throw new ToolError(`${quoi} : coordonnées invalides « ${raw} » (attendu "lat,lon").`);
      return { ...p, nom: `${r5(p.lat)},${r5(p.lon)}` };
    }
    if (profile.transport !== 'tisseo' || !resoudreLieu) {
      throw new ToolError(`${quoi} : hors de Toulouse, donne des coordonnées "lat,lon" (celles d'un lieu rendu par « ville_lieux », par exemple).`);
    }
    const d = await resoudreLieu(raw);
    return { lat: d.lat, lon: d.lon, nom: d.nom };
  }

  const placesDe = (profile, categorie) => (profile.transport === 'tisseo' ? cityService.places(categorie) : cities.places(profile, categorie));

  function fiche(p, t, extra = {}) {
    const out = {
      nom: p.name,
      ...(p.subtitle ? { type: p.subtitle } : {}),
      ...(p.address || p.city ? { adresse: [p.address, p.city].filter(Boolean).join(', ') } : {}),
      lat: r5(p.lat), lon: r5(p.lon),
      ...extra,
    };
    if (p.category === 'bikes') {
      out.velos_disponibles = p.bikes;
      out.places_libres = p.docks;
      out.releve = p.reported_at ? `il y a ${Math.max(0, Math.round((t / 1000 - p.reported_at) / 60))} min` : 'âge du relevé inconnu';
    }
    if (p.start_date) out.dates = p.start_date === p.end_date ? p.start_date : `du ${p.start_date} au ${p.end_date}`;
    if (p.sessions?.length) {
      const prochaines = p.sessions.filter((s) => Date.parse(s.end) > t).slice(0, 3);
      if (prochaines.length) out.creneaux = prochaines.map((s) => `${s.begin} → ${s.end}`);
    }
    if (p.opening_hours) {
      out.horaires_declares = p.opening_hours;
      const etat = openingState(p.opening_hours, t);
      out.ouvert_maintenant = etat === 'open' ? 'oui' : etat === 'closed' ? 'non' : 'inconnu (horaires non interprétables)';
    }
    if (p.wheelchair && p.wheelchair !== 'unknown') out.acces_pmr_declare = { yes: 'oui', no: 'non', limited: 'partiel' }[p.wheelchair];
    if (p.free_access === true) out.acces_libre_ou_gratuit = true;
    if (p.vegetarian) out.option_vegetarienne_declaree = true;
    if (p.tags?.length) out.themes = p.tags.map((x) => ({ free: 'gratuit', family: 'famille', concert: 'concert', exhibition: 'exposition' }[x] ?? x));
    if (p.description) out.description = court(p.description, 260);
    const details = (p.details ?? []).slice(0, 8);
    if (details.length) out.details = Object.fromEntries(details.map((d) => [d.label, court(d.value, 160)]));
    if (p.phone) out.telephone = p.phone;
    if (p.url) out.site = p.url;
    if (p.source_url) out.source = p.source_url;
    return out;
  }

  // --------------------------------------------------------------------------
  tools.push({
    name: 'ville_rechercher', annotations: LECTURE,
    title: 'Chercher une ville',
    description: 'Trouve une ville par son nom et rend son identifiant, à passer aux autres outils « ville_… ». Toulouse est la ville par défaut et la seule dotée des transports Tisséo en direct ; ailleurs, les lieux viennent d\'OpenStreetMap dans un rayon de 6 km du centre.',
    inputSchema: o({ nom: { ...P, description: 'Nom de la ville (« Lyon », « Bordeaux », « Berlin »…).' } }, ['nom']),
    async handler({ nom }) {
      let liste;
      try { liste = await cities.search(nom); } catch { throw new ToolError('Recherche de ville momentanément indisponible.'); }
      if (!liste.length) throw new ToolError(`Aucune ville trouvée pour « ${nom} ».`);
      return { villes: liste.map((p) => ({ ville: p.id, nom: p.name, ...(p.region ? { region: p.region } : {}), pays: p.country, transports: p.transport === 'tisseo' ? 'Tisséo, en direct' : /^fr:/.test(p.id) ? 'arrêts OpenStreetMap ; véhicules et passages en direct par « ville_transports » si le réseau local publie du temps réel' : 'arrêts OpenStreetMap seulement, sans horaires' })) };
    },
  });

  tools.push({
    name: 'ville_categories', annotations: LECTURE,
    title: 'Ce que la carte de la ville sait montrer',
    description: 'Les catégories de lieux disponibles pour une ville (vélos en libre-service, parkings, événements, culture, lieux à visiter, restaurants, parcs, marchés, sport, bibliothèques, services, fontaines, toilettes, travaux), avec la source de chacune et les limites de couverture.',
    inputSchema: o({ ville: VILLE }),
    async handler({ ville }) {
      const c = profileCatalog(await profil(ville));
      return {
        ville: c.profile?.name ?? c.city,
        categories: c.categories.map((x) => ({ categorie: x.id, nom: x.label, famille: { mobility: 'bouger', discover: 'sortir', daily: 'quotidien' }[x.group] ?? x.group, source: x.source?.label ?? null, ...(x.live ? { temps_reel: true } : {}) })),
        limites: c.notice,
      };
    },
  });

  tools.push({
    name: 'ville_lieux', annotations: LECTURE,
    title: 'Lieux d\'une catégorie',
    description: 'Les lieux d\'une catégorie dans une ville : stations de vélos avec leur dernier relevé, événements à venir, restaurants, parcs, bibliothèques, toilettes, chantiers… Filtrable par mot-clé, par proximité d\'un point (triés par distance), par période pour l\'agenda, et par critères pratiques. Un critère inconnu ne valide jamais un filtre : un lieu sans horaires publiés n\'est pas rendu par « ouvert_maintenant ». Les listes sont bornées ; « total » dit combien correspondent.',
    inputSchema: o({
      categorie: { ...P, description: 'Identifiant de catégorie (voir « ville_categories ») : bikes, parking, events, culture, visits, food, parks, markets, sports, libraries, services, water, toilets, works — et, hors de Toulouse, stops (arrêts de transport).' },
      ville: VILLE,
      recherche: { ...P, description: 'Mot-clé cherché dans le nom, le type, l\'adresse et la description.' },
      pres_de: { ...P, description: 'Point de référence : "lat,lon", ou à Toulouse un arrêt, une adresse, un lieu. Les résultats sont alors triés par distance.' },
      rayon_m: { type: 'integer', minimum: 100, maximum: 10000, description: 'Rayon autour de « pres_de », en mètres (défaut 1500).' },
      periode: { ...P, enum: ['aujourdhui', 'ce_soir', 'semaine'], description: 'Agenda seulement : événements d\'aujourd\'hui, de ce soir (après 18 h), ou des sept prochains jours.' },
      theme: { ...P, enum: ['gratuit', 'famille', 'concert', 'exposition'], description: 'Agenda seulement : thème déduit des descriptions publiées.' },
      ouvert_maintenant: { type: 'boolean', description: 'Ne garder que les lieux dont les horaires publiés disent « ouvert » à cet instant.' },
      acces_pmr: { type: 'boolean', description: 'Ne garder que les lieux qui déclarent un accès en fauteuil.' },
      limite: { type: 'integer', minimum: 1, maximum: 40, description: 'Nombre de lieux rendus (défaut 12).' },
    }, ['categorie']),
    async handler({ categorie, ville, recherche, pres_de: pres, rayon_m: rayon = 1500, periode, theme, ouvert_maintenant: ouvert, acces_pmr: pmr, limite = 12 }) {
      const profile = await profil(ville);
      const cat = profileCatalog(profile).categories.find((c) => c.id === categorie);
      if (!cat) throw new ToolError(`Catégorie inconnue : « ${categorie} ». Utilise « ville_categories ».`);
      const centre = pres ? await point(pres, profile, 'pres_de') : null;
      let data;
      try { data = await placesDe(profile, categorie); } catch { throw new ToolError('Source momentanément indisponible. Réessaie dans une minute.'); }
      const t = now();
      const jour = parisDay(t);
      let liste = data.places ?? [];
      const brut = liste.length;
      if (recherche) {
        const mots = sansAccent(recherche).split(/\s+/).filter(Boolean);
        liste = liste.filter((p) => {
          const foin = sansAccent([p.name, p.subtitle, p.address, p.city, p.description, ...(p.details ?? []).map((d) => d.value)].join(' '));
          return mots.every((m) => foin.includes(m));
        });
      }
      if (categorie === 'events') {
        if (periode === 'aujourdhui') liste = liste.filter((p) => eventOnDay(p, jour));
        else if (periode === 'ce_soir') liste = liste.filter((p) => eventTonight(p, jour, t));
        else if (periode === 'semaine') {
          const fin = parisDay(t + 7 * 86400_000);
          liste = liste.filter((p) => p.start_date <= fin && p.end_date >= jour);
        }
        if (theme) {
          const cle = { gratuit: 'free', famille: 'family', concert: 'concert', exposition: 'exhibition' }[theme];
          liste = liste.filter((p) => p.tags?.includes(cle));
        }
      }
      if (ouvert) liste = liste.filter((p) => openingState(p.opening_hours, t) === 'open');
      if (pmr) liste = liste.filter((p) => p.wheelchair === 'yes');
      let avecDistance = liste.map((p) => ({ p, d: centre ? Math.round(haversineM(centre.lat, centre.lon, p.lat, p.lon)) : null }));
      if (centre) avecDistance = avecDistance.filter((x) => x.d <= rayon).sort((a, b) => a.d - b.d);
      else if (categorie === 'events') avecDistance.sort((a, b) => String(a.p.start_date).localeCompare(String(b.p.start_date)));
      const total = avecDistance.length;
      const rendus = avecDistance.slice(0, limite).map(({ p, d }) => fiche(p, t, d != null ? { distance_m: d, a_pied_min_estime: Math.max(1, Math.round(d / 75)) } : {}));
      return {
        ville: profile.name,
        categorie: cat.label,
        ...(centre ? { autour_de: centre.nom, rayon_m: rayon } : {}),
        etat: data.status === 'ok' ? 'à jour' : data.status === 'stale' ? 'source en panne : dernières données connues' : 'source indisponible : liste vide ne veut pas dire « aucun lieu »',
        ...(data.message ? { message_source: data.message } : {}),
        ...(data.fetched_at ? { donnees_lues_a: data.fetched_at } : {}),
        total,
        ...(total > rendus.length ? { non_listes: total - rendus.length, astuce: 'Précise « recherche », « pres_de » ou augmente « limite ».' } : {}),
        ...(brut && !total ? { note: `${brut} lieu(x) dans la catégorie, aucun ne passe les filtres demandés.` } : {}),
        lieux: rendus,
        source: cat.source?.label ?? null,
        ...(centre ? { note_distance: 'Distances à vol d\'oiseau ; « ville_a_pied » calcule un vrai parcours.' } : {}),
      };
    },
  });

  tools.push({
    name: 'ville_meteo', annotations: LECTURE,
    title: 'Météo de la ville',
    description: 'Météo actuelle d\'une ville (température, ressenti, vent, minimum et maximum du jour, probabilité de pluie). Source Open-Meteo, relue au plus toutes les quinze minutes.',
    inputSchema: o({ ville: VILLE }),
    async handler({ ville }) {
      const profile = await profil(ville);
      let w;
      try { w = await cityContext.weather(profile); } catch { throw new ToolError('Météo momentanément indisponible.'); }
      return {
        ville: profile.name,
        temperature_c: w.temperature_2m, ressenti_c: w.apparent_temperature ?? null, vent_kmh: w.wind_speed_10m ?? null,
        minimum_c: w.min, maximum_c: w.max, probabilite_pluie_pct: w.rain_probability,
        code_meteo_wmo: w.weather_code ?? null,
        releve: w.fetched_at, source: 'Open-Meteo (CC BY 4.0)',
      };
    },
  });

  tools.push({
    name: 'ville_a_pied', annotations: LECTURE,
    title: 'Parcours à pied',
    description: 'Parcours piéton entre deux points d\'une ville (distants de moins de 20 km à vol d\'oiseau ; le parcours réel peut être un peu plus long) : durée, distance et instructions, calculés sur le réseau de chemins d\'OpenStreetMap. La durée est une estimation et l\'accessibilité du parcours n\'est pas garantie. Pour un trajet en transports à Toulouse, utiliser « itineraire ».',
    inputSchema: o({
      depart: { ...P, description: '"lat,lon", ou à Toulouse un arrêt, une adresse, un lieu.' },
      arrivee: { ...P, description: 'Même format.' },
      ville: VILLE,
    }, ['depart', 'arrivee']),
    async handler({ depart, arrivee, ville }) {
      const profile = await profil(ville);
      const [a, b] = await Promise.all([point(depart, profile, 'Départ'), point(arrivee, profile, 'Arrivée')]);
      let w;
      try { w = await cityContext.walk({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }); } catch (e) {
        throw new ToolError(e instanceof RangeError ? e.message : 'Parcours à pied momentanément indisponible : aucune durée n\'est inventée.');
      }
      // Même endroit : rien à parcourir (le calculateur rendait « 0 m, 1 min,
      // marchez vers le nord »).
      if (w.distance_m < 15) return { depart: a.nom, arrivee: b.nom, duree_min: 0, distance_m: 0, instructions: [], note: 'Départ et arrivée au même endroit : vous y êtes déjà.', source: w.source };
      return {
        depart: a.nom, arrivee: b.nom,
        duree_min: Math.max(1, Math.round(w.duration_s / 60)), distance_m: w.distance_m,
        instructions: w.instructions.slice(0, 30).map((i) => `${i.text}${i.distance_m ? ` (${i.distance_m} m)` : ''}`),
        ...(w.instructions.length > 30 ? { instructions_non_listees: w.instructions.length - 30 } : {}),
        source: w.source, avertissement: w.notice,
      };
    },
  });

  tools.push({
    name: 'ville_a_distance_de_marche', annotations: LECTURE,
    title: 'Ce qu\'on atteint à pied',
    description: 'Les lieux d\'une catégorie atteignables à pied en 5, 10 ou 15 minutes depuis un point, d\'après des zones calculées sur le réseau de chemins (et non un rayon à vol d\'oiseau). Chaque lieu dit dans quelle tranche il tombe.',
    inputSchema: o({
      centre: { ...P, description: 'Point de départ : "lat,lon", ou à Toulouse un arrêt, une adresse, un lieu.' },
      categorie: { ...P, description: 'Identifiant de catégorie (voir « ville_categories »).' },
      minutes: { type: 'integer', enum: [5, 10, 15], description: 'Temps de marche maximal (défaut 10).' },
      ville: VILLE,
      limite: { type: 'integer', minimum: 1, maximum: 40, description: 'Nombre de lieux rendus (défaut 12).' },
    }, ['centre', 'categorie']),
    async handler({ centre, categorie, minutes = 10, ville, limite = 12 }) {
      const profile = await profil(ville);
      const cat = profileCatalog(profile).categories.find((c) => c.id === categorie);
      if (!cat) throw new ToolError(`Catégorie inconnue : « ${categorie} ». Utilise « ville_categories ».`);
      const c = await point(centre, profile, 'Centre');
      let zone;
      try { zone = await cityContext.isochrone({ lat: c.lat, lon: c.lon }); } catch { throw new ToolError('Calcul des zones à pied momentanément indisponible : aucune zone n\'est inventée.'); }
      const data = await placesDe(profile, categorie);
      const t = now();
      const dedans = (data.places ?? [])
        .map((p) => ({ p, tranche: walkingBand(p, zone.features) }))
        .filter((x) => x.tranche != null && x.tranche <= minutes)
        .map((x) => ({ ...x, d: Math.round(haversineM(c.lat, c.lon, x.p.lat, x.p.lon)) }))
        .sort((x, y) => (x.tranche - y.tranche) || (x.d - y.d));
      return {
        ville: profile.name, depuis: c.nom, categorie: cat.label, a_pied_max_min: minutes,
        etat: data.status === 'ok' ? 'à jour' : data.status === 'stale' ? 'source en panne : dernières données connues' : 'source indisponible',
        total: dedans.length,
        ...(dedans.length > limite ? { non_listes: dedans.length - limite } : {}),
        lieux: dedans.slice(0, limite).map(({ p, tranche, d }) => fiche(p, t, { a_pied: `moins de ${tranche} min`, distance_vol_oiseau_m: d })),
        avertissement: zone.notice,
      };
    },
  });

  tools.push({
    name: 'ville_balade', annotations: LECTURE,
    title: 'Balade à étapes',
    description: 'Calcule une balade à pied passant par 2 à 6 étapes, dans l\'ordre donné : durée et distance de chaque tronçon et du total, hors visites et pauses. Moins de 20 km entre les étapes.',
    inputSchema: o({
      etapes: { type: 'array', items: { type: 'string' }, description: 'De 2 à 6 étapes : "lat,lon", ou à Toulouse un arrêt, une adresse, un lieu.' },
      ville: VILLE,
    }, ['etapes']),
    async handler({ etapes, ville }) {
      if (!Array.isArray(etapes) || etapes.length < 2 || etapes.length > 6) throw new ToolError('Donne de 2 à 6 étapes.');
      const profile = await profil(ville);
      const pts = [];
      for (const [i, e] of etapes.entries()) pts.push(await point(e, profile, `Étape ${i + 1}`));
      let tour;
      try { tour = await cityContext.tour(pts.map((p) => ({ lat: p.lat, lon: p.lon }))); } catch (e) {
        throw new ToolError(e instanceof RangeError ? e.message : 'Balade à étapes momentanément indisponible : aucune durée n\'est inventée.');
      }
      return {
        etapes: pts.map((p) => p.nom),
        duree_marche_min: Math.max(1, Math.round(tour.duration_s / 60)), distance_m: tour.distance_m,
        troncons: tour.legs.map((l) => ({ de: pts[l.from].nom, a: pts[l.to].nom, duree_min: Math.max(1, Math.round(l.duration_s / 60)), distance_m: l.distance_m })),
        source: tour.source, avertissement: tour.notice,
      };
    },
  });

  // --------------------------------------------------------------------------
  // Temps réel des réseaux des AUTRES villes (catalogue national). Toulouse a
  // ses propres outils, bien plus riches (itinéraires, horaires, tarifs).
  if (reseaux) tools.push({
    name: 'ville_transports', annotations: LECTURE,
    title: 'Transports en direct d\'une autre ville',
    description: 'Transports en commun EN DIRECT d\'une ville française autre que Toulouse, quand son réseau publie du temps réel au point d\'accès national (Bordeaux, Rennes, Montpellier, Nice, Rouen, Toulon, Dijon, Brest, Angers, Lille, Nantes… ; Paris, Lyon et Strasbourg n\'en publient pas). Sans autre argument : le réseau et le nombre de véhicules en circulation par ligne. Avec « ligne » : les véhicules de cette ligne (destination, arrêt, position). Avec « arret » : les prochains passages à cet arrêt. « positions » dit si elles sont publiées par le réseau (GPS) ou estimées d\'après ses horaires temps réel. Pas d\'itinéraire ni d\'horaires théoriques hors de Toulouse.',
    inputSchema: o({
      ville: VILLE,
      ligne: { ...P, description: 'Nom court d\'une ligne (« B », « 23 », « T1 ») : ne rendre que ses véhicules.' },
      arret: { ...P, description: 'Nom d\'un arrêt : rendre ses prochains passages.' },
    }, ['ville']),
    async handler({ ville, ligne, arret }) {
      const profile = await profil(ville);
      if (profile.transport === 'tisseo') throw new ToolError('À Toulouse, utilise les outils Tisséo : « prochains_passages », « vehicules », « ligne », « itineraire ».');
      if (!/^fr:/.test(profile.id)) throw new ToolError(`Le temps réel des transports n'est proposé que pour les villes françaises ; ${profile.name} n'en fait pas partie.`);
      let liste;
      try { liste = await reseaux.forCity(profile.id); } catch { throw new ToolError('Le catalogue national des transports ne répond pas pour l\'instant.'); }
      if (!liste.length) throw new ToolError(`Aucun réseau de ${profile.name} ne publie de temps réel au point d'accès national (transport.data.gouv.fr). Rien n'est inventé : pas de véhicules ni de passages pour cette ville.`);
      const net = liste[0];
      const entete = { ville: profile.name, reseau: net.name, source: net.page, ...(liste.length > 1 ? { autres_reseaux: liste.slice(1).map((n) => n.name) } : {}) };
      const hhmm = (t) => new Date(t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: profile.timezone || 'Europe/Paris' });

      if (arret) {
        if (!(await reseaux.ready(net.id))) throw new ToolError(`Les arrêts du réseau ${net.name} sont en cours de préparation (première consultation). Réessaie dans une minute.`);
        const trouves = await reseaux.findStops(net.id, arret, 5);
        if (!trouves.length) throw new ToolError(`Aucun arrêt « ${arret} » sur le réseau ${net.name}.`);
        const d = await reseaux.stop(net.id, trouves[0].id);
        return {
          ...entete,
          arret: { nom: d.stop.name, lat: d.stop.lat, lon: d.stop.lon, quais: d.stop.quais },
          heure: hhmm(d.at),
          passages: d.departures.slice(0, 12).map((x) => ({ ligne: x.line, mode: x.mode, destination: x.headsign, heure: hhmm(x.time), dans_min: Math.max(0, Math.round((x.time - d.at) / 60)), ...(x.delay_s != null && Math.abs(x.delay_s) >= 60 ? { retard_min: Math.round(x.delay_s / 60) } : {}) })),
          ...(d.departures.length ? {} : { note: d.realtime ? 'Aucun passage annoncé dans les deux heures.' : 'Ce réseau ne publie pas ses passages en temps réel : aucun horaire n\'est inventé.' }),
          ...(trouves.length > 1 ? { autres_arrets_du_meme_nom: trouves.slice(1).map((s) => s.name) } : {}),
          nature: 'horaires temps réel publiés par le réseau',
        };
      }

      if (ligne) await reseaux.ready(net.id, 12_000);
      const r = await reseaux.vehicles(net.id);
      if (!r) throw new ToolError('Réseau momentanément indisponible.');
      const positions = r.nature === 'gps' ? 'publiées par le réseau (GPS)' : 'estimées d\'après les horaires temps réel (le réseau ne publie pas la position de ses véhicules)';
      if (r.error && !r.vehicles.length) return { ...entete, positions, vehicules: 0, note: r.error };
      if (ligne) {
        const voulu = sansAccent(String(ligne)).replace(/^(ligne|tram|bus|metro)\s+/, '');
        const de = r.vehicles.filter((v) => sansAccent(String(v.line)) === voulu);
        if (!de.length) {
          const lignes = [...new Set(r.vehicles.map((v) => v.line))].sort((a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true }));
          return { ...entete, positions, ligne, vehicules: [], note: `Aucun véhicule de la ligne « ${ligne} » en circulation annoncé. Lignes qui roulent : ${lignes.slice(0, 60).join(', ') || 'aucune'}.` };
        }
        return {
          ...entete, positions, heure: hhmm(r.at), ligne: de[0].line, mode: de[0].mode,
          vehicules: de.slice(0, 25).map((v) => ({
            destination: v.headsign,
            ...(v.stop ? { [v.status === 'à l\'arrêt' ? 'a_l_arret' : 'prochain_arret']: v.stop } : {}),
            ...(v.status ? { etat: v.status } : {}),
            lat: v.lat, lon: v.lon,
            ...(v.speed_kmh != null ? { vitesse_kmh: v.speed_kmh } : {}),
            ...(v.estimated ? {} : v.age_s != null ? { position_relevee_il_y_a_s: v.age_s } : {}),
          })),
          ...(de.length > 25 ? { non_listes: de.length - 25 } : {}),
        };
      }
      const par = new Map();
      for (const v of r.vehicles) { const k = v.line; const e = par.get(k) ?? { ligne: k, mode: v.mode, vehicules: 0 }; e.vehicules++; par.set(k, e); }
      const lignes = [...par.values()].sort((a, b) => b.vehicules - a.vehicules || String(a.ligne).localeCompare(String(b.ligne), 'fr', { numeric: true }));
      return {
        ...entete, positions, heure: hhmm(r.at), vehicules: r.vehicles.length,
        par_ligne: lignes.slice(0, 60),
        ...(lignes.length > 60 ? { lignes_non_listees: lignes.length - 60 } : {}),
        ...(r.network.static !== 'ok' ? { note: 'Les noms de lignes et les destinations sont en cours de préparation (première consultation de ce réseau) : repose la question dans une minute pour les avoir.' } : {}),
        conseil: 'Précise « ligne » pour la position de ses véhicules, ou « arret » pour ses prochains passages.',
      };
    },
  });

  return tools;
}

export const INSTRUCTIONS_VILLE = 'Mode Ville (au-delà des transports) : « ville_lieux » donne les lieux d\'une catégorie (vélos en libre-service, événements, restaurants, parcs, services…), filtrables et triables par distance ; « ville_a_distance_de_marche » ce qu\'on atteint à pied en 5, 10 ou 15 minutes ; « ville_a_pied » et « ville_balade » des parcours piétons ; « ville_meteo » la météo ; « ville_transports » les véhicules et passages EN DIRECT d\'une autre ville française dont le réseau publie du temps réel (dire si les positions sont publiées ou estimées). Toulouse par défaut ; « ville_rechercher » donne l\'identifiant d\'une autre ville. Ces annuaires sont partiels : ne présente jamais une liste comme exhaustive, et répète « etat » quand une source est en panne. Un horaire, un tarif ou un accès « déclaré » vient d\'une publication, pas d\'une vérification sur place.';
