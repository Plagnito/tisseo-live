import test from 'node:test';
import assert from 'node:assert/strict';
import { cityCatalog, createCityService, normalizeRecord, normalizeBikes, normalizeOsm, normalizeOdsOsm, parisDay, safeUrl } from '../lib/city.mjs';

const point = { geo_point_2d: { lat: 43.604, lon: 1.444 } };
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });

test('Ville : les trois usages ont des catégories et des sources publiques', () => {
  const cats = cityCatalog().categories;
  assert.equal(new Set(cats.map((c) => c.id)).size, cats.length);
  assert.deepEqual([...new Set(cats.map((c) => c.group))].sort(), ['daily', 'discover', 'mobility']);
  for (const c of cats) assert.ok(c.source.url.startsWith('https://'));
});

test('Ville : coordonnées invalides et points extérieurs rejetés', () => {
  for (const p of [{ lat: null, lon: null }, { lat: 0, lon: 0 }, { lat: 48.85, lon: 2.35 }]) {
    assert.equal(normalizeRecord('parks', { geo_point_2d: p, nom: 'JARDIN' }), null);
  }
});

test('Ville : aucun événement terminé, même au changement de jour parisien', () => {
  assert.equal(parisDay(Date.parse('2026-09-30T22:30:00Z')), '2026-10-01');
  const event = { ...point, nom_de_la_manifestation: 'Expo', date_debut: '2026-09-01', date_fin: '2026-09-30' };
  assert.equal(normalizeRecord('events', event, 0, '2026-10-01'), null);
  assert.ok(normalizeRecord('events', { ...event, date_fin: '2026-10-01' }, 0, '2026-10-01'));
  assert.equal(normalizeRecord('events', { ...event, date_debut: null, date_fin: null }, 0, '2026-10-01'), null);
});

test('Ville : zéro vélos est une disponibilité connue, une absence de statut est inconnue', () => {
  const info = { data: { stations: [{ station_id: 1, name: 'Capitole', lat: 43.604, lon: 1.444, capacity: 19 }] } };
  const status = { data: { stations: [{ station_id: '1', num_bikes_available: 0, num_docks_available: 19, is_renting: false, last_reported: 100 }] } };
  const known = normalizeBikes(info, status)[0];
  assert.equal(known.bikes, 0); assert.equal(known.renting, false);
  const unknown = normalizeBikes(info, null)[0];
  assert.equal(unknown.bikes, null); assert.equal(unknown.docks, null);
});

test('Ville : capacités et tarifs de parking restent des données publiées', () => {
  const p = normalizeRecord('parking', { ...point, nom: 'Parking', nb_places: 0, tarif_1h: null });
  assert.equal(p.details[0].value, '0');
  assert.equal(p.details.some((d) => d.label.includes('Tarif')), false);
  assert.ok(p.description.includes('ne sont pas vérifiés en direct'));
});

test('Ville : les lieux culturels ne disparaissent pas avec les indicateurs erronés de la source', () => {
  const p = normalizeRecord('culture', { ...point, eq_nom_equipement: 'Théâtre des Mazades', eq_salle_de_spectacle: 'F', numero: 8, lib_off: 'AVENUE DES MAZADES' });
  assert.equal(p.name, 'Théâtre des Mazades');
  assert.equal(p.address, '8 AVENUE DES MAZADES');
  assert.equal(p.subtitle, 'Équipement culturel');
});

test('Ville : les liens externes restent HTTP(S), les balises deviennent du texte', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,bonjour'), null);
  assert.equal(safeUrl('file:///c:/secret'), null);
  assert.equal(safeUrl('https://user:password@example.org'), null);
  assert.equal(safeUrl('www.example.org'), 'https://www.example.org/');
  const p = normalizeOsm('food', { type: 'way', id: 2, center: { lat: 43.604, lon: 1.444 }, tags: { name: '<b>Café</b>', amenity: 'cafe', website: 'javascript:alert(1)' } });
  assert.equal(p.name, 'Café'); assert.equal(p.url, null);
  assert.equal(p.source_url, 'https://www.openstreetmap.org/way/2');
});

test('Ville : requêtes partagées, cache, panne avec données conservées et reprise', async () => {
  let time = Date.parse('2026-10-01T12:00:00Z'), calls = 0, fail = false;
  const service = createCityService({ now: () => time, fetcher: async (url) => {
    calls++; if (fail) throw new Error('offline');
    return response(String(url).includes('/exports/') ? [{ ...point, nom: 'Parking', id: 'p1' }] : { metas: { default: { data_processed: '2026-10-01' } } });
  } });
  const [a, b] = await Promise.all([service.places('parking'), service.places('parking')]);
  assert.equal(calls, 2); assert.deepEqual(a, b); assert.equal(a.count, 1);
  await service.places('parking'); assert.equal(calls, 2);
  time += 7 * 3600_000; fail = true;
  const stale = await service.places('parking');
  assert.equal(stale.status, 'stale'); assert.equal(stale.count, 1); assert.equal(stale.fetched_at, a.fetched_at);
  const afterFailure = calls;
  await service.places('parking'); assert.equal(calls, afterFailure);
  time += 61_000; fail = false;
  assert.equal((await service.places('parking')).status, 'ok');
});

test('Ville : source absente, aucune donnée inventée et pas de répétition immédiate', async () => {
  let time = Date.parse('2026-10-01T12:00:00Z'), calls = 0;
  const service = createCityService({ now: () => time, fetcher: async () => { calls++; throw new Error('offline'); } });
  assert.equal((await service.places('parking')).status, 'unavailable');
  const initial = calls;
  await service.places('parking'); assert.equal(calls, initial);
  time += 61_000;
  assert.equal((await service.places('parking')).status, 'unavailable');
  assert.deepEqual((await service.places('parking')).places, []);
  await assert.rejects(service.places('unknown'), RangeError);
});

test('Ville : stations disponibles sans statut vélo, disponibilités inconnues', async () => {
  const service = createCityService({ fetcher: async (url) => {
    if (String(url).includes('station_status')) throw new Error('offline');
    return response({ data: { stations: [{ station_id: '1', name: 'Capitole', lat: 43.604, lon: 1.444 }] } });
  } });
  const result = await service.places('bikes');
  assert.equal(result.count, 1); assert.equal(result.availability_unavailable, true); assert.equal(result.places[0].bikes, null);
});

test('Ville : les événements en cache sont éliminés après la fin de leur journée', async () => {
  let time = Date.parse('2026-10-01T21:55:00Z');
  const service = createCityService({ now: () => time, fetcher: async (url) => response(String(url).includes('/exports/') ? [{ ...point, nom_de_la_manifestation: 'Expo', date_debut: '2026-10-01', date_fin: '2026-10-01' }] : {}) });
  assert.equal((await service.places('events')).count, 1);
  time += 10 * 60_000;
  assert.equal((await service.places('events')).count, 0);
});

test('Ville : les sanitaires privés sont écartés et la lecture OSM est partagée', async () => {
  let calls = 0;
  const base = { type: 'node', lat: 43.604, lon: 1.444 };
  const service = createCityService({ fetcher: async () => { calls++; return response({ elements: [
    { ...base, id: 1, tags: { amenity: 'toilets', access: 'private' } },
    { ...base, id: 2, tags: { amenity: 'toilets', access: 'yes' } },
    { ...base, id: 3, tags: { amenity: 'restaurant', name: 'Café' } },
    { ...base, id: 4, tags: { tourism: 'museum', name: 'Musée' } },
  ] }); } });
  const results = await Promise.all(['toilets', 'toilets'].map((id) => service.places(id)));
  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.count), [1, 1]);
});

test('Ville : les exports OSM conservent la provenance et les valeurs inconnues', () => {
  const p = normalizeOdsOsm('food', { name: 'Café', type: 'cafe', meta_geo_point: { lat: 43.604, lon: 1.444 }, meta_osm_url: 'https://www.openstreetmap.org/node/1', cuisine: ['thai', 'asian'], website: 'www.example.org' });
  assert.equal(p.source_url, 'https://www.openstreetmap.org/node/1');
  assert.equal(p.details[0].value, 'thai, asian');
  assert.equal(p.address, '');
  assert.equal(normalizeOdsOsm('food', { ...p, meta_osm_url: 'https://example.org' }), null);
});
