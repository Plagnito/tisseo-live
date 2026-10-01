import test from 'node:test';
import assert from 'node:assert/strict';
import { createCityContext, cityTourPoints } from '../lib/city-context.mjs';

test('Balade : coordonnées mondiales, nombre de points et étapes successives distinctes', () => {
  assert.equal(cityTourPoints('43.6,1.44;95.8,2.3'), null);
  assert.equal(cityTourPoints('48.85,2.35;48.86,2.36').length, 2);
  assert.equal(cityTourPoints('43.6,1.44;43.6,1.44'), null);
  assert.equal(cityTourPoints('43.6,1.44'), null);
  assert.equal(cityTourPoints('43.6,1.44,2;43.61,1.45'), null);
  assert.equal(cityTourPoints(Array(7).fill('43.6,1.44').join(';')), null);
  assert.equal(cityTourPoints('43.6,1.44;43.61,1.45;43.6,1.44').length, 3);
});
test('Balade : ordre des étapes, durées de chaque tronçon et requête partagée', async () => {
  let calls = 0;
  const points = cityTourPoints('43.6,1.44;43.61,1.45;43.62,1.46');
  const service = createCityContext({fetcher: async (url, options) => {
    calls++; const body = JSON.parse(options.body); assert.deepEqual(body.locations.map(({lat, lon}) => ({lat, lon})), points); assert.equal(body.costing, 'pedestrian');
    return {ok: true, json: async () => ({trip: {status: 0, summary: {time: 900, length: 1.2}, legs: [300,600].map(time => ({summary: {time, length: .6}, shape: '??AA', maneuvers: [{instruction: 'Continue'}]}))}})};
  }});
  const [a, b] = await Promise.all([service.tour(points), service.tour(points)]);
  assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal(a.legs[1].duration_s, 600); assert.equal(a.duration_s, 900); assert.equal(a.legs[1].to, 2);
});
test('Balade : une réponse partielle ne fabrique pas les étapes manquantes', async () => {
  const service = createCityContext({fetcher: async () => ({ok: true, json: async () => ({trip: {status: 0, summary: {time: 10, length: 1}, legs: []}})})});
  await assert.rejects(service.tour(cityTourPoints('43.6,1.44;43.61,1.45')), /indisponible/);
  assert.throws(() => service.tour([{lat: 43.4, lon: 1.1}, {lat: 43.8, lon: 1.8}]), RangeError);
});
