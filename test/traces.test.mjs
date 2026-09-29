// Contrôle qualité du tracé : chaque arrêt doit être proche du tracé de sa
// ligne.
//
// C'est le seul test qui dit si le « tracé » suit vraiment la route. Le GTFS
// statique contient des shapes qu'on n'a pas pu comparer à un fond de carte
// ici, mais les arrêts, eux, sont une vérité terrain : si un arrêt est à
// 200 m de la polyligne de sa ligne, la polyligne est fausse.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapToShape } from '../lib/core.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (nom) => JSON.parse(fs.readFileSync(join(racine, 'data', nom), 'utf8'));

// Au-delà, l'arrêt n'est plus « à côté du tracé », il est sur un autre.
const SEUIL_ARRÊT_M = 100;
// Une ligne peut avoir une poignée d'arrêts exotiques ; au-delà de 5 % on
// considère que le tracé de la ligne est faux, pas qu'un arrêt est mal placé.
const PART_MAX_HORS = 0.05;

const routes = lire('routes.json');
const stops = lire('stops.json');
const variants = lire('route_variants.json');

function controler() {
  const parLigne = [];
  let pire = { d: 0, ou: '' };
  let totalArrets = 0;
  let lignesTracees = 0;
  for (const r of routes) {
    const list = variants[r.route_id] || [];
    const ds = [];
    for (const v of list) {
      if (!Array.isArray(v.shape) || v.shape.length < 2) continue;
      lignesTracees++;
      for (const id of v.stops) {
        const s = stops[id];
        if (!s || s.lat == null || s.lon == null) continue;
        const hit = snapToShape(s.lat, s.lon, v.shape);
        if (!hit) continue;
        const d = Math.sqrt(hit.d2);
        ds.push({ d, nom: s.n, dir: v.dir });
        totalArrets++;
        if (d > pire.d) pire = { d, ou: `${r.short_name} « ${s.n} »` };
      }
    }
    if (!ds.length) continue;
    const hors = ds.filter((x) => x.d > SEUIL_ARRÊT_M).length;
    parLigne.push({ ligne: r.short_name, id: r.route_id, total: ds.length, hors, pire: Math.max(...ds.map((x) => x.d)) });
  }
  return { parLigne, pire, totalArrets, lignesTracees };
}

const { parLigne, pire, totalArrets, lignesTracees } = controler();

test('les données de tracé sont bien chargées', () => {
  assert.ok(routes.length > 100, `routes.json : ${routes.length} lignes`);
  assert.ok(lignesTracees > 200, `variantes avec tracé : ${lignesTracees}`);
  assert.ok(totalArrets > 5000, `arrêts vérifiés : ${totalArrets}`);
});

test('le pire arrêt du réseau reste proche de son tracé', () => {
  assert.ok(
    pire.d < SEUIL_ARRÊT_M,
    `pire écart : ${Math.round(pire.d)} m sur ${pire.ou} (seuil ${SEUIL_ARRÊT_M} m)`,
  );
});

test('la quasi-totalité des lignes suit ses propres arrêts', () => {
  const mauvaises = parLigne.filter((l) => l.hors / l.total > PART_MAX_HORS);
  assert.deepEqual(
    mauvaises.map((l) => `${l.ligne} ${l.hors}/${l.total}`),
    [],
    'lignes dont plus de 5 % des arrêts sont hors tracé',
  );
});

test('aucune ligne n\'est entièrement hors de son propre tracé', () => {
  // Erreur d\'appariement ligne/variant : ça se voit comme un taux de 100 %.
  const totaux = parLigne.filter((l) => l.hors === l.total);
  assert.deepEqual(totaux.map((l) => l.ligne), [], 'lignes intégralement hors tracé');
});

test('le rapport détaillé reste consultable', () => {
  // Garde-fou : si ce test passe, on veut pouvoir dire « 32 m au pire »
  // sans relancer un script.
  const pireLigne = [...parLigne].sort((a, b) => b.pire - a.pire)[0];
  console.log(`      pire global ${Math.round(pire.d)} m (${pire.ou}) ; `
    + `pire ligne ${pireLigne.ligne} ${Math.round(pireLigne.pire)} m ; `
    + `${totalArrets} arrêts sur ${lignesTracees} variantes`);
});
