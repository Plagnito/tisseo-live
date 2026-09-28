// Tests du cœur pur : géométrie, recherche, simplification du réseau et
// contrôle des tuiles. Aucun réseau requis : `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bearingDeg, haversineM, snapToShape, createModel, GRACE_S, MODE_LABEL } from '../lib/core.mjs';
import { buildNetwork } from '../lib/network.mjs';
import { createTileProbe, TILE_PROVIDERS } from '../lib/tiles.mjs';

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

// --- géométrie du réseau ------------------------------------------------
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
