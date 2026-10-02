// Tracé d'un itinéraire : chaque étape porte le chemin réellement parcouru.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ridePath, variantFor, decorateJourney } from '../lib/journey-geometry.mjs';

// Une ligne en « L » : quatre arrêts, un virage entre B et C.
const stops = {
  A: { n: 'Alpha', lat: 43.600, lon: 1.440 },
  B: { n: 'Beta', lat: 43.600, lon: 1.450 },
  C: { n: 'Gamma', lat: 43.610, lon: 1.460 },
  D: { n: 'Delta', lat: 43.620, lon: 1.460 },
  X: { n: 'Hors tracé', lat: 43.70, lon: 1.60 },
};
const shape = [[43.600, 1.440], [43.600, 1.450], [43.600, 1.460], [43.610, 1.460], [43.620, 1.460]];
const variants = { L: [{ dir: '0', headsign: 'Delta', stops: ['A', 'B', 'C', 'D'], shape }, { dir: '1', headsign: 'Alpha', stops: ['D', 'C', 'B', 'A'], shape: [...shape].reverse() }] };

test('trajet en véhicule : le tronçon du tracé entre la montée et la descente, pas la ligne entière', () => {
  const g = ridePath(variants.L[0], 'B', 'C', stops);
  assert.equal(g.on_shape, true);
  assert.deepEqual(g.path[0], [43.6, 1.45], 'commence à l\'arrêt de montée');
  assert.deepEqual(g.path[g.path.length - 1], [43.61, 1.46], 'finit à l\'arrêt de descente');
  assert.ok(g.path.some(([la, lo]) => la === 43.6 && lo === 1.46), 'passe par le virage : le tracé, pas la corde');
  assert.ok(!g.path.some(([, lo]) => lo < 1.45), 'rien avant la montée');
  assert.ok(!g.path.some(([la]) => la > 43.61), 'rien après la descente');
  assert.deepEqual(g.stops.map((s) => s.name), ['Beta', 'Gamma']);
  assert.ok(Math.abs(g.distance_m - (806 + 1105)) < 40, `longueur par le tracé : ${g.distance_m} m`);
});

test('trajet en véhicule : la variante est celle du sens emprunté', () => {
  assert.equal(variantFor(variants, 'L', 'B', 'D').headsign, 'Delta');
  assert.equal(variantFor(variants, 'L', 'D', 'B').headsign, 'Alpha');
  assert.equal(variantFor(variants, 'L', 'B', 'B'), null);
  assert.equal(variantFor(variants, 'inconnue', 'A', 'B'), null);
  const retour = ridePath(variants.L[1], 'D', 'A', stops);
  assert.deepEqual(retour.path[0], [43.62, 1.46]);
  assert.deepEqual(retour.stops.map((s) => s.name), ['Delta', 'Gamma', 'Beta', 'Alpha']);
});

test('sans tracé exploitable, le chemin passe par les arrêts — et le dit', () => {
  const sans = ridePath({ stops: ['A', 'B', 'C'], shape: [] }, 'A', 'C', stops);
  assert.equal(sans.on_shape, false);
  assert.deepEqual(sans.path, [[43.6, 1.44], [43.6, 1.45], [43.61, 1.46]]);
  // Un arrêt à des kilomètres du tracé : on ne l'y projette pas.
  const loin = ridePath({ stops: ['A', 'X'], shape }, 'A', 'X', stops);
  assert.equal(loin.on_shape, false);
  assert.equal(ridePath(variants.L[0], 'C', 'B', stops), null, 'la descente doit suivre la montée');
});

const trajet = () => ({
  legs: [
    { type: 'walk', seconds: 300, from: 'Chez moi', to: 'Alpha', from_pos: [43.598, 1.438], to_pos: [43.6, 1.44] },
    { type: 'ride', route_id: 'L', line: 'L', from: 'Alpha', to: 'Gamma', from_id: 'A', to_id: 'C' },
    { type: 'walk', seconds: 20, from: 'Gamma', to: 'Gamma', from_pos: [43.61, 1.46], to_pos: [43.6101, 1.4601] },
  ],
});

test('tout le trajet reçoit un tracé, une distance et une emprise', async () => {
  const appels = [];
  const walk = async (a, b) => { appels.push([a, b]); return { geometry: { coordinates: [[a.lon, a.lat], [1.439, 43.599], [b.lon, b.lat]] }, distance_m: 320, duration_s: 250 }; };
  const j = await decorateJourney(trajet(), { variants, stops, walk });
  const [marche, bus, quai] = j.legs;
  assert.deepEqual(marche.path, [[43.598, 1.438], [43.599, 1.439], [43.6, 1.44]], 'le chemin par les rues, en [lat, lon]');
  assert.equal(marche.distance_m, 320);
  assert.equal(marche.walk_real_s, 250);
  assert.equal(marche.path_estimated, undefined);
  assert.equal(marche.seconds, 300, 'la durée du calcul n\'est pas modifiée : les horaires du trajet en dépendent');
  assert.equal(bus.headsign, 'Delta');
  assert.deepEqual(bus.stops.map((s) => s.name), ['Alpha', 'Beta', 'Gamma']);
  assert.ok(bus.path.length >= 4);
  assert.equal(quai.path_estimated, true, 'changer de quai (15 m) : la ligne droite, sans appel au calculateur');
  assert.equal(appels.length, 1);
  assert.deepEqual(j.bounds, [[43.598, 1.438], [43.6101, 1.4601]]);
  assert.equal(j.walk_m, marche.distance_m + quai.distance_m);
  assert.equal(j.distance_m, j.legs.reduce((d, l) => d + l.distance_m, 0));
});

test('calculateur piéton en panne ou trop lent : la ligne droite, jamais d\'attente sans fin', async () => {
  const panne = await decorateJourney(trajet(), { variants, stops, walk: async () => { throw new Error('502'); } });
  assert.deepEqual(panne.legs[0].path, [[43.598, 1.438], [43.6, 1.44]]);
  assert.equal(panne.legs[0].path_estimated, true);
  assert.ok(panne.legs[0].distance_m > 300 && panne.legs[0].distance_m < 400, 'distance à vol d\'oiseau × 1,3');
  const t0 = Date.now();
  const lent = await decorateJourney(trajet(), { variants, stops, walk: () => new Promise(() => {}), walkBudgetMs: 120 });
  assert.ok(Date.now() - t0 < 1000, 'le délai accordé est respecté');
  assert.equal(lent.legs[0].path_estimated, true);
  const sans = await decorateJourney(trajet(), { variants, stops });
  assert.ok(sans.legs.every((l) => l.path?.length >= 2), 'sans calculateur piéton du tout');
  assert.deepEqual(await decorateJourney({ error: 'x' }, { variants, stops }), { error: 'x' });
});
