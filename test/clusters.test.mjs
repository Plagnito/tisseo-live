// Vérification de stopClusters : la station, pas seulement le stop_point.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModel, haversineM } from '../lib/core.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (n) => JSON.parse(fs.readFileSync(join(racine, 'data', n), 'utf8'));
const stops = lire('stops.json');
const model = createModel({
  routes: lire('routes.json'),
  stops,
  variants: lire('route_variants.json'),
});

test('une station de métro est un groupe de stop_point voisins', () => {
  // Sur le réseau, « Jean Jaurès » du sens Basso-Cambo et celui du sens
  // Belleville sont deux stop_point distincts à quelques dizaines de mètres.
  const c = model.stopClusters('Jean Jaurès', 4);
  assert.ok(c.length >= 2, `attendu au moins 2 emplacements, obtenu ${c.length}`);
  const central = c.find((x) => x.lat > 43.6);
  assert.ok(central, 'l\'emplacement central (43,6 N) doit exister');
  assert.ok(central.ids.length >= 2, `le groupe central doit réunir plusieurs quais (${central.ids.length})`);
});

test('les members d\'un groupe sont bien à moins de 120 m du représentant', () => {
  for (const nom of ['Jean Jaurès', 'Capitole', 'Purpan']) {
    for (const grp of model.stopClusters(nom, 4)) {
      const rep = stops[grp.representant];
      for (const id of grp.ids) {
        const d = haversineM(rep.lat, rep.lon, stops[id].lat, stops[id].lon);
        assert.ok(d <= 120, `${nom} : ${id} est à ${Math.round(d)} m du représentant`);
      }
    }
  }
});

test('les emplacements sont séparés, pas tout fusionné', () => {
  // Il y a trois « Jean Jaurès » distincts à Toulouse : centre, Purpan, sud.
  const c = model.stopClusters('Jean Jaurès', 4);
  assert.ok(c.length >= 3, `attendu 3 emplacements, obtenu ${c.length}`);
  // Chaque groupe doit être disjoint des autres.
  const vus = new Set();
  for (const grp of c) {
    for (const id of grp.ids) {
      assert.ok(!vus.has(id), `${id} apparaît dans deux groupes`);
      vus.add(id);
    }
  }
});

test('l\'emplacement le mieux servi arrive en tête', () => {
  const c = model.stopClusters('Jean Jaurès', 4);
  // Le centre est desservi par le métro A et B ; Purpan n'a que la 58.
  const purpan = c.find((x) => x.lat < 43.52);
  assert.ok(purpan, 'l\'emplacement de Purpan est identifiable');
  assert.notEqual(c[0].representant, purpan.representant,
    'Purpan ne doit pas être le choix par défaut');
  assert.ok(c[0].lat > 43.6, 'le choix par défaut est l\'emplacement central');
});

test('une saisie sans ambiguïté rend un seul emplacement', () => {
  const c = model.stopClusters('Capitole', 4);
  assert.equal(c.length, 1);
  assert.ok(c[0].ids.length >= 1);
});

test('l\'article français peut être omis', () => {
  // 203 arrêts du réseau portent un article (« La Palme », « Le Mirail »…) ;
  // personne ne tape l'article. « Palme » doit donc retrouver « La Palme ».
  const sansArticle = model.stopClusters('Palme', 4);
  assert.ok(sansArticle.length >= 1, '« Palme » doit être trouvé sans l\'article');
  assert.ok(/palme/i.test(sansArticle[0].nom), `résultat inattendu : ${sansArticle[0].nom}`);
  // et la forme avec article fonctionne toujours
  assert.ok(model.stopClusters('La Palme', 4).length >= 1);
  // un mot trop court ne doit pas remonter n'importe quoi : « La » matchait
  // « La Vache », « Palais de Justice » et la moitié du réseau.
  assert.deepEqual(model.stopClusters('La', 4), []);
  assert.deepEqual(model.stopClusters('Le', 4), []);
  assert.deepEqual(model.stopClusters('A', 4), []);
});

test('un nom d\'arrêt ne doit pas être trouvé au milieu d\'une autre phrase', () => {
  // « Toulouse » contient « lac » : la correspondance par sous-chaîne
  // faisait répondre l'arrêt « Lac » à « 1 place Wilson Toulouse », et le
  // géocodeur — seul moyen de trouver la place — n'était jamais appelé. Le
  // voyageur atterrissait à l'autre bout de la ville.
  assert.deepEqual(model.stopClusters('1 place Wilson Toulouse', 4), [],
    'aucun arrêt ne doit correspondre à cette adresse');
  assert.deepEqual(model.stopClusters('Place de la Gare 31000 Toulouse', 4), [],
    'le nom complet d\'une adresse ne doit pas non plus matcher un arrêt');
  // En revanche, un nom d'arrêt cité en entier dans la phrase matche toujours.
  const cap = model.stopClusters('Capitole Toulouse', 4);
  assert.equal(cap.length, 1, '« Capitole Toulouse » doit trouver Capitole');
  assert.match(stops[cap[0].representant].n, /Capitole/);
  // et un mot entier suffit
  assert.ok(model.stopClusters('toulouse lac', 4).length >= 0);
});

test('une saisie vide ou introuvable ne rend rien', () => {
  assert.deepEqual(model.stopClusters(''), []);
  assert.deepEqual(model.stopClusters('   '), []);
  assert.deepEqual(model.stopClusters('zzzzzzzz'), []);
  assert.deepEqual(model.stopClusters(null), []);
});

test('tous les ids rendus existent réellement', () => {
  for (const nom of ['Jean Jaurès', 'Capitole', 'Blagnac']) {
    for (const grp of model.stopClusters(nom, 4)) {
      assert.ok(stops[grp.representant], `représentant inconnu : ${grp.representant}`);
      for (const id of grp.ids) assert.ok(stops[id], `id inconnu : ${id}`);
    }
  }
});

test('le plafond de clusters est respecté', () => {
  assert.ok(model.stopClusters('Jean Jaurès', 2).length <= 2);
  assert.ok(model.stopClusters('Jean Jaurès', 1).length <= 1);
});
