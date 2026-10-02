// Annuaire des réseaux qui publient du temps réel — tiré du point d'accès
// national (transport.data.gouv.fr), jamais d'une liste d'adresses recopiée :
// les adresses des fichiers changent à chaque publication, le catalogue les suit.
//
// Une fiche du catalogue = un réseau : ses archives GTFS, ses flux GTFS-RT, et
// la zone couverte (communes, intercommunalités). C'est la zone qui relie une
// VILLE choisie dans le mode Ville à SON réseau.

const hier = (now) => new Date(now - 86_400_000).toISOString().slice(0, 10);

// Nom court : « Réseau urbain et scolaire TBM » → « TBM ».
export function shortName(title) {
  const t = String(title ?? '').replace(/^Réseaux? (?:de transport )?(?:urbains?|interurbains?|périurbains?|scolaires?|et|de|du|des|d'|\s)+/i, '').trim();
  return t || String(title ?? '').trim();
}

// Fiches utiles du catalogue brut. `now` : pour écarter les archives pas encore
// en vigueur (« version à venir ») ou périmées.
export function entriesFromDatasets(datasets, now = Date.now()) {
  const jour = new Date(now).toISOString().slice(0, 10);
  const out = [];
  for (const d of datasets ?? []) {
    if (d.type !== 'public-transit') continue;
    const res = (d.resources ?? []).filter((r) => r.is_available !== false && r.url);
    const rt = res.filter((r) => /^gtfs-?rt$/i.test(r.format || ''));
    if (!rt.length) continue;
    let gtfs = res.filter((r) => /^gtfs$/i.test(r.format || ''));
    if (!gtfs.length) continue;
    // En vigueur aujourd'hui, si le catalogue le dit ; sinon on garde tout.
    const enVigueur = gtfs.filter((r) => {
      const a = r.metadata?.start_date, b = r.metadata?.end_date;
      return (!a || a <= jour) && (!b || b >= hier(now));
    });
    if (enVigueur.length) gtfs = enVigueur;
    const features = new Set(rt.flatMap((r) => r.features ?? []));
    // Un réseau qui ne publie que des alertes n'a ni véhicules ni passages à
    // montrer (Marseille). Un flux de nature inconnue est gardé : on regardera.
    if (rt.every((r) => r.features?.length) && !features.has('vehicle_positions') && !features.has('trip_updates')) continue;
    out.push({
      id: d.slug,
      title: d.title,
      name: shortName(d.title),
      page: d.page_url,
      licence: d.licence ?? null,
      urbain: (d.sub_types ?? []).includes('urban') || /urbain/i.test(d.title),
      zones: (d.covered_area ?? []).map((z) => ({ type: z.type, insee: String(z.insee ?? ''), nom: z.nom })),
      gtfs: gtfs.slice(0, 6).map((r) => ({ url: r.url, title: r.title, end: r.metadata?.end_date ?? null })),
      rt: rt.slice(0, 10).map((r) => ({ url: r.url, title: r.title, features: r.features ?? [] })),
      positions: features.has('vehicle_positions'),
      horaires: features.has('trip_updates'),
    });
  }
  return out;
}

// Réseaux d'une commune, le meilleur d'abord. `lieu` : { insee, epci }.
export function networksFor(entries, lieu) {
  const hits = [];
  for (const e of entries) {
    let force = 0;
    for (const z of e.zones) {
      if (z.type === 'commune' && z.insee === lieu.insee) force = Math.max(force, 2);
      if (z.type === 'epci' && lieu.epci && z.insee === lieu.epci) force = Math.max(force, 3);
    }
    if (!force) continue;
    // Positions réelles d'abord, réseau urbain avant navette ou scolaire, puis
    // le plus de flux (un réseau complet en publie plusieurs).
    // … et, à égalité, le réseau le plus LOCAL : celui de la métropole avant
    // le réseau suburbain qui couvre six intercommunalités (Nancy).
    hits.push({ e, score: (e.positions ? 8 : 0) + (e.urbain ? 4 : 0) + force + Math.min(e.rt.length, 3) / 4 - Math.min(e.zones.length, 8) / 16 });
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.e);
}

// Relevé quand les règles de tri des fiches changent : une copie gardée sur
// disque par une version précédente n'est alors plus relue.
const FORMAT = 2;

export function createCatalogue({ fetcher = fetch, now = Date.now, ttlMs = 12 * 3600_000, load = null, save = null, url = 'https://transport.data.gouv.fr/api/datasets' } = {}) {
  let entries = null, at = 0, pending = null;
  const communes = new Map();
  async function refresh() {
    const res = await fetcher(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'TisseoLive/1.4 (https://tisseo.plagnito.com)', Accept: 'application/json' } });
    if (!res.ok) throw new Error(`catalogue HTTP ${res.status}`);
    const list = entriesFromDatasets(await res.json(), now());
    if (!list.length) throw new Error('catalogue vide');
    entries = list; at = now();
    try { await save?.({ v: FORMAT, at, entries }); } catch { /* disque plein : on garde la mémoire */ }
    return entries;
  }
  async function all() {
    if (entries && now() - at < ttlMs) return entries;
    if (!entries && load) {
      // Copie gardée sur disque : sert tout de suite, et de secours si le
      // catalogue national est en panne.
      try { const kept = await load(); if (kept?.v === FORMAT && kept.entries?.length) { entries = kept.entries; at = kept.at || 0; } } catch { /* pas de copie */ }
      if (entries && now() - at < ttlMs) return entries;
    }
    pending ??= refresh().finally(() => { pending = null; });
    if (entries) { pending.catch(() => {}); return entries; } // périmé : on sert, on rafraîchit derrière
    return pending;
  }
  // Intercommunalité d'une commune (c'est elle que le catalogue cite le plus).
  async function commune(insee) {
    if (communes.has(insee)) return communes.get(insee);
    let epci = null;
    try {
      const r = await fetcher(`https://geo.api.gouv.fr/communes/${encodeURIComponent(insee)}?fields=codeEpci`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
      if (r.ok) epci = (await r.json()).codeEpci ?? null;
    } catch { /* annuaire injoignable : on cherchera par commune seule */ }
    const lieu = { insee, epci };
    if (epci !== null || communes.size < 500) communes.set(insee, lieu);
    return lieu;
  }
  // Paris, Lyon et Marseille sont découpés en arrondissements dans certains jeux.
  async function forCity(cityId) {
    const m = /^fr:([\dAB]{5})$/.exec(String(cityId ?? ''));
    if (!m) return [];
    return networksFor(await all(), await commune(m[1]));
  }
  async function get(id) { return (await all()).find((e) => e.id === id) ?? null; }
  return { all, forCity, get };
}
