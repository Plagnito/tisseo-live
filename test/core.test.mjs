// Tests du cœur pur : géométrie, recherche, simplification du réseau et
// contrôle des tuiles. Aucun réseau requis : `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bearingDeg, haversineM, snapToShape, createModel, GRACE_S, MODE_LABEL,
  buildShapeIndex, projectOnShapeIndex, pointAtDistance, positionAlongShape } from '../lib/core.mjs';
import { buildNetwork } from '../lib/network.mjs';
import { createTileProbe, TILE_PROVIDERS } from '../lib/tiles.mjs';
import { loadSchedules } from '../lib/schedules.mjs';
import { activeRuns, runToVehicle, theoreticalVehicles } from '../lib/theoretical.mjs';

const approx = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} attendu ${b} ± ${tol}, obtenu ${a}`);

test('haversineM : distance connue Capitole → Matabiau', () => {
  const d = haversineM(43.6045, 1.4442, 43.6110, 1.4540);
  assert.ok(d > 800 && d < 1100, `distance inattendue : ${d} m`);
});

test('haversineM : deux points identiques', () => {
  approx(haversineM(43.6, 1.44, 43.6, 1.44), 0, 1e-6);
});

test('bearingDeg : les quatre caps', () => {
  approx(bearingDeg(43.60, 1.44, 43.61, 1.44), 0, 1, 'nord');     // vers le nord
  approx(bearingDeg(43.60, 1.44, 43.59, 1.44), 180, 1, 'sud');    // vers le sud
  approx(bearingDeg(43.60, 1.44, 43.60, 1.45), 90, 1, 'est');     // vers l'est
  approx(bearingDeg(43.60, 1.44, 43.60, 1.43), 270, 1, 'ouest');   // vers l'ouest
});

test('snapToShape : un point sur le segment est renvoyé à lui-même', () => {
  const shape = [[43.60, 1.44], [43.60, 1.46]];
  const s = snapToShape(43.60, 1.45, shape);
  assert.ok(s, 'aucun résultat');
  approx(s.lon, 1.45, 1e-6, 'lon');
  approx(s.lat, 43.60, 1e-6, 'lat');
  approx(s.frac, 0.5, 1e-6, 'frac');
});

test('snapToShape : un point décalé est ramené sur le tracé', () => {
  const shape = [[43.60, 1.44], [43.60, 1.46]];
  const s = snapToShape(43.6005, 1.45, shape); // 55 m au nord
  assert.ok(s);
  approx(s.d2 ** 0.5, haversineM(43.6005, 1.45, 43.60, 1.45), 3, 'distance au tracé');
});

test('snapToShape : extrémités hors segment sont ramenées au bout', () => {
  const shape = [[43.60, 1.44], [43.60, 1.46]];
  const s = snapToShape(43.60, 1.50, shape);
  approx(s.lon, 1.46, 1e-6);
  approx(s.frac, 1, 1e-6);
});

test('snapToShape : tracé trop court ou absent', () => {
  assert.equal(snapToShape(43.6, 1.44, []), null);
  assert.equal(snapToShape(43.6, 1.44, [[43.6, 1.44]]), null);
  assert.equal(snapToShape(43.6, 1.44, null), null);
});

test('createModel : recherche d\'arrêt insensible aux accents et au pluriel', () => {
  const model = createModel({
    routes: [{ route_id: 'line:1', short_name: 'L1', long_name: 'Test', color: '000000', text_color: 'ffffff', type: 3 }],
    stops: { 'stop_point:SP_1': { n: 'Jean Jaurès', lat: 43.6, lon: 1.44 } },
    variants: { 'line:1': [{ dir: 0, stops: ['stop_point:SP_1'], shape: [[43.6, 1.44], [43.61, 1.45]] }] },
  });
  assert.equal(model.modeOf({ type: 3 }), MODE_LABEL[3]);
  assert.equal(GRACE_S, 120);
  const hits = model.searchStops('jean jaures', 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'stop_point:SP_1');
  // préfixe toléré à partir de 3 caractères
  assert.equal(model.searchStops('jaur', 5).length, 1, '« jaur » doit trouver Jean Jaurès');
  assert.equal(model.searchStops('jean', 5).length, 1, '« jean » doit trouver Jean Jaurès');
  assert.equal(model.searchStops('capitole', 5).length, 0, 'arrêt absent du jeu de test');
  assert.equal(model.searchStops('   ', 5).length, 0, 'requête vide');
});

// --- position le long du tracé -------------------------------------------
// Un tracé en équerre : aller de A à B en ligne droite traverse le pâté de
// maisons, alors que le véhicule suit la rue.
const ESC = [[43.60, 1.44], [43.60, 1.45], [43.61, 1.45]];
const idxESC = buildShapeIndex(ESC);

test('buildShapeIndex : distances cumulées croissantes', () => {
  assert.equal(idxESC.pts.length, 3);
  assert.equal(idxESC.cum[0], 0);
  assert.ok(idxESC.cum[1] > 0 && idxESC.cum[2] > idxESC.cum[1], 'cumul croissant');
  approx(idxESC.total, haversineM(43.60, 1.44, 43.60, 1.45) + haversineM(43.60, 1.45, 43.61, 1.45), 15, 'longueur totale');
});

test('buildShapeIndex : tracé trop court ou invalide', () => {
  assert.equal(buildShapeIndex([]), null);
  assert.equal(buildShapeIndex([[43.6, 1.44]]), null);
  assert.equal(buildShapeIndex(null), null);
});

test('projectOnShapeIndex : l\'abscisse du virage est celle du cumul', () => {
  // Les deux branches n'ont pas la même longueur (≈806 m puis ≈1113 m) :
  // le virage est donc au 2e point, pas à la moitié du tracé.
  const p = projectOnShapeIndex(idxESC, 43.60, 1.45);
  approx(p.s, idxESC.cum[1], 2, 'abscisse du virage');
  assert.ok(p.d2 < 1, 'le virage est sur le tracé');
});

test('pointAtDistance : début, virage, fin', () => {
  approx(pointAtDistance(idxESC, 0)[1], 1.44, 1e-9);
  const coin = pointAtDistance(idxESC, idxESC.cum[1]);
  approx(coin[0], 43.60, 1e-9, 'latitude au virage');
  approx(coin[1], 1.45, 1e-9, 'longitude au virage');
  // Un quart du trajet total tombe encore sur la branche horizontale.
  const q = pointAtDistance(idxESC, idxESC.total / 4);
  approx(q[0], 43.60, 1e-3, 'latitude au quart');
  const end = pointAtDistance(idxESC, idxESC.total * 2); // au-delà : on s'arrête au bout
  approx(end[0], 43.61, 1e-9);
  approx(end[1], 1.45, 1e-9);
});

test('positionAlongShape : à mi-parcours on est SUR le tracé, pas sur la corde', () => {
  const fromS = projectOnShapeIndex(idxESC, 43.60, 1.44).s;
  const toS = projectOnShapeIndex(idxESC, 43.61, 1.45).s;
  const p = positionAlongShape(idxESC, fromS, toS, 0.5);
  assert.ok(p, 'position calculée');
  // La corde A→B traverse le pâté de maisons : la position doit être
  // nettement plus proche du virage que de la ligne droite.
  const surChord = snapToShape(43.605, 1.445, [[43.60, 1.44], [43.61, 1.45]]);
  const dChord = haversineM(43.605, 1.445, surChord.lat, surChord.lon);
  const dTrace = haversineM(p.lat, p.lon, 43.60, 1.45);
  assert.ok(dTrace < 200, `le point doit être sur la rue (à ${Math.round(dTrace)} m du virage), pas à ${Math.round(dChord)} m de la corde`);
});

test('positionAlongShape : le fractionnement suit le temps, pas la distance', () => {
  const fromS = projectOnShapeIndex(idxESC, 43.60, 1.44).s;
  const toS = projectOnShapeIndex(idxESC, 43.61, 1.45).s;
  // À 25 % du temps on est à 25 % de l'abscisse, donc encore sur le
  // segment horizontal.
  const p = positionAlongShape(idxESC, fromS, toS, 0.25);
  approx(p.lat, 43.60, 0.002, 'latitude à 25 %');
  // Inverse : 75 % du temps, on a franchi le virage.
  const q = positionAlongShape(idxESC, fromS, toS, 0.75);
  assert.ok(q.lat > 43.603, 'à 75 % on a franchi le virage');
});

test('positionAlongShape : refus quand les arrêts ne sont pas exploitables', () => {

  const same = projectOnShapeIndex(idxESC, 43.60, 1.44).s;
  assert.equal(positionAlongShape(idxESC, same, same + 10, 0.5), null, 'abscisses trop proches');
  assert.equal(positionAlongShape(idxESC, NaN, 100, 0.5), null, 'abscisse non finie');
  assert.equal(positionAlongShape(null, 0, 100, 0.5), null, 'pas d’index');
});

test('computeSnapshot : un véhicule en circulation est posé SUR le tracé', () => {
  const shape = [[43.60, 1.44], [43.60, 1.45], [43.61, 1.45]];
  const model = createModel({
    routes: [{ route_id: 'L', short_name: 'L1', long_name: 'X', color: 'ff0000', text_color: 'ffffff', type: 3 }],
    stops: {
      A: { n: 'A', lat: 43.60, lon: 1.44 },
      B: { n: 'B', lat: 43.60, lon: 1.45 },
      C: { n: 'C', lat: 43.61, lon: 1.45 },
    },
    variants: { L: [{ dir: 0, stops: ['A', 'B', 'C'], shape }] },
  });
  const t0 = 1_700_000_000;
  const rt = {
    header: { timestamp: t0 + 60 },
    entity: [{
      id: 'e1',
      trip_update: {
        trip: { route_id: 'L' },
        vehicle: { id: 'V1' },
        stop_time_update: [
          { stop_sequence: 1, stop_id: 'A', arrival: { time: t0 }, departure: { time: t0 } },
          { stop_sequence: 2, stop_id: 'B', arrival: { time: t0 + 100 }, departure: { time: t0 + 110 } },
          { stop_sequence: 3, stop_id: 'C', arrival: { time: t0 + 200 }, departure: { time: t0 + 200 } },
        ],
      },
    }],
  };
  const snap = model.computeSnapshot(rt);
  assert.equal(snap.vehicles.length, 1);
  const v = snap.vehicles[0];
  assert.equal(v.status, 'en_route');
  assert.equal(v.on_route, true, 'la position doit venir du tracé, pas d’un rapprochement');
  assert.equal(v.snapped, undefined, 'pas besoin de snap si on est déjà sur la route');
  // À t0+105 on est entre B et C : donc sur le tracé, et pas au milieu du
  // pâté de maisons (ni sur la ligne droite B→C… qui ici est le tracé).
  const dTrace = snapToShape(v.lat, v.lon, shape);
  assert.ok(Math.sqrt(dTrace.d2) < 60, `à ${Math.round(Math.sqrt(dTrace.d2))} m du tracé`);
  // Le segment A→B est horizontal : le véhicule ne doit jamais monter en
  // latitude pendant qu'il est entre A et B.
  const rt2 = { ...rt, header: { timestamp: t0 + 55 } };
  const v2 = model.computeSnapshot(rt2).vehicles[0];
  approx(v2.lat, 43.60, 1e-3, 'latitude pendant A→B');
});

// --- véhicules théoriques (métro) -----------------------------------------
const DAY = '20260928'; // un lundi
const midnight = Math.floor(new Date(2026, 8, 28, 0, 0, 0).getTime() / 1000);
const rawSched = {
  patterns: [[DAY]],
  lines: {
    M: {
      // 3 courses : 10h00, 10h05, 10h10, chacune passant A→B→C.
      0: { headsign: 'Terminus', stops: { A: { 0: [36000, 36300, 36600] }, B: { 0: [36080, 36380, 36680] }, C: { 0: [36160, 36460, 36760] } } },
      1: { headsign: 'Départ', stops: { C: { 0: [36000, 36300] }, A: { 0: [36120, 36420] } } },
    },
  },
};
const sched = loadSchedules(rawSched, {
  routeById: new Map([['M', { short_name: 'A', color: 'db001b', text_color: 'ffffff', type: 1 }]]),
  modeOf: (r) => MODE_LABEL[r?.type] ?? 'Bus',
});
const stopsM = {
  A: { n: 'Alpha', lat: 43.60, lon: 1.44 },
  B: { n: 'Beta', lat: 43.60, lon: 1.45 },
  C: { n: 'Gamma', lat: 43.61, lon: 1.45 },
};
const shapeM = [[43.60, 1.44], [43.60, 1.45], [43.61, 1.45]];
const trackM = createModel({
  routes: [{ route_id: 'M', short_name: 'A', long_name: 'L', color: 'db001b', text_color: 'ffffff', type: 1 }],
  stops: stopsM,
  variants: { M: [{ dir: 0, stops: ['A', 'B', 'C'], shape: shapeM }] },
}).variantTrack('M', '0');

test('loadSchedules : expose les horaires par (ligne, sens)', () => {
  assert.ok(sched.byRoute.get('M|0'), 'entrée ligne|sens présente');
  assert.equal(sched.byRoute.get('M|0').headsign, 'Terminus');
  assert.equal(sched.byRoute.get('M|1').headsign, 'Départ');
  assert.equal(sched.byRoute.get('M|2'), undefined);
});

test('activeRuns : ne renvoie que les courses en cours', () => {
  // 10h02 → la course de 10h00 est en cours (A 36000 → C 36160).
  const runs = activeRuns(sched, 'M', '0', midnight + 36120, ['A', 'B', 'C']);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].times[0], midnight + 36000);
  assert.equal(runs[0].times[2], midnight + 36160);
  assert.deepEqual(runs[0].stops, ['A', 'B', 'C']);
});

test('activeRuns : une course terminée ou pas encore partie est ignorée', () => {
  assert.equal(activeRuns(sched, 'M', '0', midnight + 34000, ['A', 'B', 'C']).length, 0, 'trop tôt');
  assert.equal(activeRuns(sched, 'M', '0', midnight + 39000, ['A', 'B', 'C']).length, 0, 'trop tard');
  // 1 min avant le départ, la course est déjà annoncée (tolérance).
  assert.equal(activeRuns(sched, 'M', '0', midnight + 36000 - 60, ['A', 'B', 'C']).length, 1);
});

test('activeRuns : un motif de dates sans ces arrêts ne produit rien', () => {
  // Un arrêt sans horaires pour ce motif : la course n'est pas reconstructible.
  assert.equal(activeRuns(sched, 'M', '0', midnight + 36040, ['A', 'B', 'Z']).length, 0, 'parcours incomplet');
  assert.equal(activeRuns(sched, 'M', '0', midnight + 36040, ['A', 'B', 'Inconnu']).length, 0, 'arrêt hors GTFS');
  assert.equal(activeRuns(sched, 'M', '0', midnight + 36040, []).length, 0, 'parcours vide');
  assert.equal(activeRuns(sched, 'M', '0', midnight + 36040, null).length, 0);
  assert.equal(activeRuns(null, 'M', '0', midnight + 36040, ['A', 'B', 'C']).length, 0);
  assert.equal(activeRuns(sched, 'M', '9', midnight + 36040, ['A', 'B', 'C']).length, 0, 'sens inconnu');
});

test('runToVehicle : position le long du tracé, marquée théorique', () => {
  // Course 10h00 : A 10h00, B 10h00:40, C 10h01:20. On l'interroge à 10h00:40,
  // soit pile à B — et 20 s avant, soit encore sur le segment horizontal.
  const [run] = activeRuns(sched, 'M', '0', midnight + 36040, ['A', 'B', 'C']);
  const ctx = {
    stops: stopsM,
    route: { short_name: 'A', color: 'db001b', text_color: 'ffffff' },
    shapeIndex: trackM.idx,
    stopS: trackM.stopS,
    routeId: 'M',
    dir: '0',
    modeLabel: 'Métro',
    headsign: 'Terminus',
  };
  const v = runToVehicle(run, midnight + 36040, ctx);
  assert.ok(v, 'véhicule construit');
  assert.equal(v.theoretical, true);
  assert.equal(v.on_route, true, 'posé sur le tracé');
  assert.equal(v.line, 'A');
  assert.equal(v.destination, 'Terminus');
  approx(v.lat, 43.60, 0.002, 'latitude pendant A→B');
  approx(v.lon, 1.444, 0.006, 'longitude à mi-parcours de A→B');
  assert.equal(v.next_stop, 'Beta');
  assert.equal(v.remaining.length, 2, 'arrêts restants : B puis C');
  assert.equal(v.remaining.at(-1).last, true);
  // Le virage est à B, atteint à 10h00:40. À 10h01:00 on est sur le
  // segment vertical B→C : la longitude est figée et la latitude monte —
  // ce qui distingue une marche le long du tracé d'un aller-retour en
  // ligne droite entre les arrêts.
  const w = runToVehicle(run, midnight + 36100, ctx);
  approx(w.lon, 1.45, 0.001, 'longitude figée après le virage');
  assert.ok(w.lat > 43.601, `la latitude monte après le virage (${w.lat})`);
  approx(w.lat, 43.6025, 0.001, 'latitude à 25 % de B→C');
});

test('runToVehicle : sans tracé, on retombe sur la ligne droite', () => {
  const [run] = activeRuns(sched, 'M', '0', midnight + 36040, ['A', 'B', 'C']);
  const v = runToVehicle(run, midnight + 36040, {
    stops: stopsM, route: { short_name: 'A' }, routeId: 'M', dir: '0',
  });
  assert.ok(v, 'véhicule construit malgré l\'absence de tracé');
  assert.equal(v.on_route, undefined);
  approx(v.lon, 1.445, 0.01, 'longitude à mi-parcours entre A et B');
  approx(v.lat, 43.60, 1e-6, 'latitude constante entre A et B');
});

test('runToVehicle : une course hors service ne donne rien', () => {
  const [run] = activeRuns(sched, 'M', '0', midnight + 36120, ['A', 'B', 'C']);
  const ctx = { stops: stopsM, route: { short_name: 'A' }, routeId: 'M', dir: '0' };
  assert.equal(runToVehicle(run, midnight + 100, ctx), null, 'trop tôt');
  assert.equal(runToVehicle(run, midnight + 99999, ctx), null, 'trop tard');
  assert.equal(runToVehicle(null, midnight + 36120, ctx), null);
  assert.equal(runToVehicle(run, midnight + 36120, { ...ctx, stops: null }), null);
});

test('theoreticalVehicles : une rame par course en cours, id stable', () => {
  const vs = theoreticalVehicles(sched, 'M', '0', midnight + 36120, {
    stops: stopsM,
    route: { short_name: 'A', color: 'db001b' },
    orderStops: ['A', 'B', 'C'],
    shapeIndex: trackM.idx,
    stopS: trackM.stopS,
    modeLabel: 'Métro',
  });
  assert.equal(vs.length, 1);
  // L'id doit être stable d'un rafraîchissement à l'autre, sinon le front
  // verrait apparaître une nouvelle pastille à chaque tick.
  const vs2 = theoreticalVehicles(sched, 'M', '0', midnight + 36125, {
    stops: stopsM, route: { short_name: 'A' }, orderStops: ['A', 'B', 'C'],
  });
  assert.equal(vs2[0].id, vs[0].id);
});

const routes = [
  { route_id: 'line:1', short_name: 'L1', long_name: 'A', color: 'ff0000', text_color: 'ffffff', type: 3 },
  { route_id: 'line:2', short_name: 'L2', long_name: 'B', color: '00ff00', text_color: 'ffffff', type: 0 },
];
const variants = {
  'line:1': [{ dir: 0, stops: ['a'], shape: [[43.60, 1.44], [43.61, 1.45], [43.62, 1.46]] }],
  'line:2': [{ dir: 0, stops: ['a'], shape: [[43.60, 1.44], [43.60, 1.45]] }],
};
const routeById = new Map(routes.map((r) => [r.route_id, r]));
const modeOf = (r) => MODE_LABEL[r?.type] ?? 'Bus';

test('buildNetwork : une ligne par route, et Douglas-Peucker dégonfle les tracés', () => {
  const net = buildNetwork({ routes, variants, routeById, modeOf });
  assert.equal(net.points, 2);
  assert.equal(net.lines.length, 2);
  const l1 = net.lines.find((l) => l.route_id === 'line:1');
  assert.equal(l1.color, '#ff0000');
  assert.equal(l1.mode, 'Bus');
  // Les 3 points du tracé sont alignés : le point du milieu tombe, on garde
  // les deux extrémités — c'est exactement le but de la simplification.
  assert.equal(l1.shapes[0].length, 2);
  assert.deepEqual(l1.shapes[0][0], [43.6, 1.44]);
  assert.deepEqual(l1.shapes[0][1], [43.62, 1.46]);
});

test('buildNetwork : un virage est conservé', () => {
  const net = buildNetwork({
    routes,
    variants: { 'line:1': [{ dir: 0, stops: [], shape: [[43.60, 1.44], [43.61, 1.44], [43.61, 1.45]] }] },
    routeById,
    modeOf,
  });
  assert.equal(net.lines[0].shapes[0].length, 3, 'le sommet du virage ne doit pas disparaître');
});

test('buildNetwork : les coordonnées sont arrondies à 5 décimales', () => {
  const net = buildNetwork({ routes, variants, routeById, modeOf });
  for (const line of net.lines) {
    for (const shape of line.shapes) {
      for (const [lat, lon] of shape) {
        assert.equal(lat, Math.round(lat * 1e5) / 1e5, 'lat trop précis');
        assert.equal(lon, Math.round(lon * 1e5) / 1e5, 'lon trop précis');
      }
    }
  }
});

test('buildNetwork : une route inconnue est ignorée, pas de crash', () => {
  const net = buildNetwork({ routes, variants: { 'line:9': variants['line:1'] }, routeById, modeOf });
  assert.equal(net.points, 0);
  assert.equal(net.lines.length, 0);
});

test('buildNetwork : un tracé dégénéré est ignoré', () => {
  const net = buildNetwork({
    routes,
    variants: { 'line:1': [{ dir: 0, stops: [], shape: [[43.6, 1.44]] }] },
    routeById,
    modeOf,
  });
  assert.equal(net.points, 0);
});

test('buildNetwork : une tolérance à 0 ne perd aucun point', () => {
  const net = buildNetwork({ routes, variants, routeById, modeOf }, { tolM: 0, cellM: 0 });
  assert.equal(net.lines[0].shapes[0].length, 3);
});

test('buildNetwork : la déduplication par grille ne casse pas les tracés', () => {
  // Deux tracés quasi identiques, à moins d'un mètre : la grille doit garder
  // au moins les deux extrémités de chacun.
  const net = buildNetwork({ routes, variants, routeById, modeOf }, { tolM: 0, cellM: 50 });
  for (const line of net.lines) {
    for (const shape of line.shapes) assert.ok(shape.length >= 2, 'tracé réduit à moins de 2 points');
  }
});

// --- contrôle des fonds de carte -----------------------------------------
test('TILE_PROVIDERS : URLs sans clé, et une seule entrée par mode au plus', () => {
  assert.ok(TILE_PROVIDERS.length >= 3);
  for (const p of TILE_PROVIDERS) {
    for (const url of [p.dark, p.light, p.labels].filter(Boolean)) {
      assert.ok(url.startsWith('https://'), `${p.id} : URL non https`);
      assert.ok(url.includes('{z}') && url.includes('{x}') && url.includes('{y}'), `${p.id} : gabarits manquants`);
    }
    assert.ok(p.label, `${p.id} : libellé manquant`);
    assert.ok((p.dark ? 1 : 0) + (p.light ? 1 : 0) === 1, `${p.id} : doit servir un seul mode`);
  }
});

test('sonde des tuiles : un fournisseur qui ment (200 + placeholder) est rejeté', async (t) => {
  // On rejoue le cas réel du 28/09/2026 : CARTO répond 200 avec une image de
  // remplacement « API KEY REQUIRED » au lieu de la carte.
  const faux = [{
    id: 'faux',
    label: 'Faux fournisseur',
    dark: 'https://example.test/{z}/{x}/{y}.png',
    min_bytes: 1,
  }];
  const probe = createTileProbe(faux);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from('placeholder'), {
    status: 200, headers: { 'content-type': 'image/png' },
  });
  t.after(() => { globalThis.fetch = origFetch; });
  const cat = await probe(true);
  assert.equal(cat.dark.length, 0, 'un placeholder ne doit jamais devenir un fond');
  assert.equal(cat.rejected.length, 1);
  assert.match(cat.rejected[0].why, /placeholder|tuile/);
});

test('sonde des tuiles : une vraie tuile 256×256 est acceptée', async (t) => {
  // PNG 256×256 minimal, bien au-dessus du plancher de taille.
  const ihdr = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
  ihdr.writeUInt32BE(13, 8);
  ihdr.write('IHDR', 12, 'latin1');
  ihdr.writeUInt32BE(256, 16);
  ihdr.writeUInt32BE(256, 20);
  ihdr[24] = 8; ihdr[25] = 2;
  const png = Buffer.concat([ihdr, Buffer.alloc(8000, 7)]);
  const probe = createTileProbe([{ id: 'ok', label: 'OK', dark: 'https://example.test/{z}/{x}/{y}.png', min_bytes: 1000 }]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  t.after(() => { globalThis.fetch = origFetch; });
  const cat = await probe(true);
  assert.equal(cat.dark.length, 1);
  assert.equal(cat.rejected.length, 0);
});

test('sonde des tuiles : une tuile qui n\'est pas 256×256 est rejetée', async (t) => {
  const ihdr = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
  ihdr.writeUInt32BE(13, 8);
  ihdr.write('IHDR', 12, 'latin1');
  ihdr.writeUInt32BE(512, 16);
  ihdr.writeUInt32BE(512, 20);
  const png = Buffer.concat([ihdr, Buffer.alloc(8000, 7)]);
  const probe = createTileProbe([{ id: 'ok', label: 'OK', dark: 'https://example.test/{z}/{x}/{y}.png', min_bytes: 1000 }]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  t.after(() => { globalThis.fetch = origFetch; });
  const cat = await probe(true);
  assert.equal(cat.dark.length, 0);
  assert.match(cat.rejected[0].why, /256/);
});

test('sonde des tuiles : le résultat est mis en cache (une seule passe réseau)', async (t) => {
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('réseau coupé'); };
  t.after(() => { globalThis.fetch = origFetch; });
  const probe = createTileProbe(TILE_PROVIDERS);
  await probe();
  await probe();
  assert.equal(calls, TILE_PROVIDERS.length, 'la sonde ne doit pas relancer un provider déjà testé');
});
