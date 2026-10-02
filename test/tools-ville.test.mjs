// Outils « Ville » du connecteur : comment une ville est comprise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCityTools } from '../lib/tools-ville.mjs';

const TOULOUSE = { id: 'fr:31555', name: 'Toulouse', lat: 43.6047, lon: 1.4442, country: 'France', region: 'Haute-Garonne' };
const LYON = { id: 'fr:69123', name: 'Lyon', lat: 45.76, lon: 4.83, country: 'France', region: 'Rhône' };
const SAINT_DENIS = [
  { id: 'fr:93066', name: 'Saint-Denis', lat: 48.93, lon: 2.35, country: 'France', region: 'Seine-Saint-Denis' },
  { id: 'fr:97411', name: 'Saint-Denis', lat: -20.88, lon: 55.45, country: 'France', region: 'La Réunion' },
];

function banc({ panne = false } = {}) {
  const appels = { search: [], meteo: [] };
  const connus = new Map([TOULOUSE, LYON].map((p) => [p.id, p]));
  const cities = {
    get: async (id = TOULOUSE.id) => { if (connus.has(id)) return connus.get(id); throw new RangeError('Ville inconnue'); },
    search: async (q) => {
      appels.search.push(q);
      if (panne) throw new Error('Source HTTP 503');
      const k = q.toLowerCase();
      if (k === 'lyon') return [LYON, { id: 'fr:27377', name: 'Lyons-la-Forêt', lat: 49.4, lon: 1.47, country: 'France', region: 'Eure' }];
      if (k === 'saint-denis') return SAINT_DENIS;
      if (k === 'lyo') return [LYON];
      return [];
    },
  };
  const cityContext = { weather: async (p) => { appels.meteo.push(p.id); return { temperature_2m: 16, min: 9, max: 19, rain_probability: 20, fetched_at: '2026-10-02T06:00:00Z' }; } };
  const tools = createCityTools({ cities, cityService: {}, cityContext, profileCatalog: () => ({ categories: [] }), resoudreLieu: async () => { throw new Error('non utilisé'); }, now: () => 1_790_900_000 });
  return { meteo: tools.find((t) => t.name === 'ville_meteo'), appels };
}

test('ville : sans rien, par identifiant ou par nom, c’est la même ville', async () => {
  const { meteo, appels } = banc();
  for (const ville of [undefined, '', 'fr:31555', 'Toulouse', 'toulouse', ' TOULOUSE ']) {
    assert.equal((await meteo.handler({ ville })).ville, 'Toulouse', JSON.stringify(ville));
  }
  assert.equal(appels.search.length, 0, 'la ville par défaut se reconnaît sans consulter l’annuaire');
  assert.deepEqual([...new Set(appels.meteo)], ['fr:31555']);
});

test('ville : un nom qui désigne une seule ville est compris', async () => {
  const { meteo, appels } = banc();
  assert.equal((await meteo.handler({ ville: 'Lyon' })).ville, 'Lyon', 'le nom exact l’emporte sur « Lyons-la-Forêt »');
  assert.equal((await meteo.handler({ ville: 'lyo' })).ville, 'Lyon', 'un seul résultat : c’est lui');
  assert.equal(appels.meteo.at(-1), 'fr:69123');
});

test('ville : des homonymes sont nommés, jamais départagés au hasard', async () => {
  const { meteo, appels } = banc();
  await assert.rejects(meteo.handler({ ville: 'Saint-Denis' }), (e) => {
    assert.match(e.message, /Plusieurs villes pour « Saint-Denis »/);
    assert.match(e.message, /Saint-Denis \(Seine-Saint-Denis\) = "fr:93066"/);
    assert.match(e.message, /Saint-Denis \(La Réunion\) = "fr:97411"/);
    return true;
  });
  assert.equal(appels.meteo.length, 0, 'aucune météo n’est rendue pour une ville devinée');
});

test('ville : inconnue, identifiant mal formé, annuaire en panne — chaque cas dit ce qui se passe', async () => {
  const { meteo } = banc();
  await assert.rejects(meteo.handler({ ville: 'Xqzwvk' }), /Ville inconnue : « Xqzwvk »\. Utilise « ville_rechercher »/);
  await assert.rejects(meteo.handler({ ville: 'fr:00000' }), /Ville inconnue : « fr:00000 »/);
  await assert.rejects(banc({ panne: true }).meteo.handler({ ville: 'Lyon' }), /Annuaire des villes momentanément indisponible/);
});
