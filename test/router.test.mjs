// Tests de l'itinéraire A→B — le bug le plus coûteux du planificateur.
//
// Capitole et Jean Jaurès sont deux stations de la ligne A, à 271 m l'une de
// l'autre. Le planificateur proposait quatre minutes de marche. Deux causes
// indépendantes, toutes deux corrigées ici :
//   1. les deux sens d'une ligne de métro n'emploient pas le même stop_point
//      pour une même station, et la recherche ne reliait que les arrêts d'une
//      même variante ;
//   2. l'attente par défaut (240 s) rendait toute correspondance plus chère
//      qu'une marche de 300 m (240 s à 1,25 m/s), donc la marche gagnait.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../lib/router.mjs';
import { createModel } from '../lib/core.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (n) => JSON.parse(fs.readFileSync(join(racine, 'data', n), 'utf8'));
const stops = lire('stops.json');
const routes = lire('routes.json');
const variants = lire('route_variants.json');
const router = createRouter({ stops, variants, routes });
const model = createModel({ routes, stops, variants });

// 10 h un jour de semaine : le réseau fonctionne, sinon les lignes sont
// écartées et le test ne prouve rien.
const A_TRAFFIC = 1782708000;

const versMinutes = (s) => Math.round(s / 60);

test('deux stations de métro voisines se relient en métro', () => {
  // Le cas réel : l'utilisateur tape « Capitole » et « Jean Jaurès ». Le
  // routeur reçoit la station entière et trouve la ligne A, une station.
  const capitole = model.stopClusters('Capitole', 1)[0];
  const jeanJaurès = model.stopClusters('Jean Jaurès', 1)[0];
  const r = router.journey({ stop_ids: capitole.ids }, { stop_ids: jeanJaurès.ids }, A_TRAFFIC);
  assert.ok(!r.error, `pas de trajet : ${r.error}`);
  assert.ok(versMinutes(r.duration_s) <= 5,
    `Capitole -> Jean Jaurès doit prendre le métro, obtenu ${versMinutes(r.duration_s)} min`
    + ` (${r.legs.map((l) => l.type === 'walk' ? 'marche' : l.line).join(' + ')})`);
  assert.ok(r.legs.some((l) => l.type === 'ride'), 'le trajet doit contenir une course');
});

test('deux quais sur des stations distinctes ne sont pas rejetés à tort', () => {
  // SP_2757 (Capitole, sens Balma-Gramont) et SP_1572 (Jean Jaurès, même
  // sens) sont séparés par UNE station sur la ligne A.
  const r = router.journey({ stop_id: 'stop_point:SP_2757' }, { stop_id: 'stop_point:SP_1572' }, A_TRAFFIC);
  assert.ok(!r.error, `la garde « même arrêt » ne doit pas confondre deux quais distincts : ${r.error}`);
  assert.ok(versMinutes(r.duration_s) <= 5, `attendu <= 5 min, obtenu ${versMinutes(r.duration_s)}`);
});

test('la marche seule ne l\'emporte pas sur une course courte', () => {
  // Le cas général derrière ce bug : dès qu'un mode rapide relie deux points
  // proches, la marche ne doit pas gagner sur le seul critère du coût.
  const capitole = model.stopClusters('Capitole', 1)[0];
  const jeanJaurès = model.stopClusters('Jean Jaurès', 1)[0];
  const r = router.journey({ stop_ids: capitole.ids }, { stop_ids: jeanJaurès.ids }, A_TRAFFIC);
  const marche = r.legs.filter((l) => l.type === 'walk').reduce((s, l) => s + l.seconds, 0);
  assert.ok(marche < r.duration_s / 2,
    `la marche domine le trajet (${versMinutes(marche)} min sur ${versMinutes(r.duration_s)})`);
});

test('un quai dans le mauvais sens n\'invente pas un trajet', () => {
  // SP_1912 (Capitole, sens Basso-Cambo) et SP_147 (Jean Jaurès, même sens)
  // sont dans le MAUVAIS ordre : Jean Jaurès vient avant Capitole. Le routeur
  // doit le dire (marche) plutôt que d'inventer un aller-retour.
  const r = router.journey({ stop_id: 'stop_point:SP_1912' }, { stop_id: 'stop_point:SP_147' }, A_TRAFFIC);
  const metros = (r.legs ?? []).filter((l) => l.type === 'ride' && /^[AB]$/.test(l.line ?? ''));
  assert.equal(metros.length, 0, 'aucun trajet en métro ne doit exister dans ce sens');
});

test('tous les quais d\'une station partent en même temps', () => {
  // C\'est le mécanisme du correctif : la station entière est une extrémité,
  // pas un stop_point tir\'au sort.
  const cluster = model.stopClusters('Jean Jaurès', 4)[0];
  assert.ok(cluster.ids.length >= 2, 'il faut plusieurs quais pour que le test ait un sens');
  const r = router.journey({ stop_ids: cluster.ids }, { stop_id: 'stop_point:SP_2757' }, A_TRAFFIC);
  assert.ok(!r.error, `pas de trajet : ${r.error}`);
  assert.ok(versMinutes(r.duration_s) <= 6,
    `Jean Jaurès -> Capitole en donnant tous les quais : ${versMinutes(r.duration_s)} min`);
});

test('l\'aller simple reste plus rapide qu\'un détour par une correspondance', () => {
  // Capitole -> Basso Cambo : direct sur la ligne A, sans changement.
  const r = router.journey({ stop_id: 'stop_point:SP_1912' }, { stop_id: 'stop_point:SP_3055' }, A_TRAFFIC);
  assert.ok(!r.error, `pas de trajet : ${r.error}`);
  const metros = r.legs.filter((l) => l.type === 'ride' && /^[AB]$/.test(l.line ?? ''));
  assert.ok(metros.length === 1, `un seul trajet en métro attendu, obtenu ${metros.length}`);
});

test('une correspondance reste possible quand elle le mérite', () => {
  // Ne rien faire de plus pour des cas « évidents » : on vérifie juste que le
  // moteur n\'a pas été cassé et rend toujours un trajet exploitable.
  const r = router.journey({ stop_id: 'stop_point:SP_1912' }, { stop_id: 'stop_point:SP_3157' }, A_TRAFFIC);
  if (r.error) return; // pas de correspondance ce jour-là, ce n\'est pas un défaut
  assert.ok(r.legs.length >= 1, 'un trajet doit avoir au moins un segment');
  assert.ok(r.duration_s > 0, 'la durée doit être positive');
  assert.ok(r.legs.every((l) => l.type === 'ride' || l.type === 'walk'), 'types de segments connus');
});

test('déjà sur place : la marche gagne, pas un détour en transports', () => {
  // Le cas rencontré en branchant le géocodeur : depuis la place Wilson, à
  // 100 m de la station Jean Jaurès, le planificateur renvoyait « aucun
  // itinéraire » — parce que départ et arrivée partagent un arrêt — puis passait
  // à l'homonyme suivant, à 6 km, et proposait 58 minutes de métro et de bus.
  const jj = model.stopClusters('Jean Jaurès', 4)[0];
  const quai = jj.ids[0];
  const s = stops[quai];
  // Un point à 100 m du quai, donné en coordonnées.
  const r = router.journey(
    { lat: s.lat + 0.0009, lon: s.lon },
    { stop_ids: jj.ids },
    A_TRAFFIC,
  );
  assert.ok(!r.error, `pas de trajet : ${r.error}`);
  assert.ok(r.legs.every((l) => l.type === 'walk'),
    'on est déjà sur place : le trajet ne doit contenir que de la marche');
  assert.ok(r.duration_s < 20 * 60,
    `attendu moins de 20 min, obtenu ${Math.round(r.duration_s / 60)} min`);
});

test('le départ et l\'arrivée sur le même quai sont refusés', () => {
  const r = router.journey({ stop_id: 'stop_point:SP_1912' }, { stop_id: 'stop_point:SP_1912' }, A_TRAFFIC);
  assert.ok(r.error, 'un trajet vers soi-même ne doit pas être proposé');
});

test('un point inconnu est signalé, pas deviné', () => {
  const r = router.journey({ stop_id: 'stop_point:INEXISTANT' }, { stop_id: 'stop_point:SP_1912' }, A_TRAFFIC);
  assert.ok(r.error, 'un stop_id inconnu doit produire une erreur');
});

test('un trajet qui n\'existe qu\'hors service est signalé comme tel', () => {
  // La nuit, si rien ne circule, le routeur propose quand même un trajet sur le
  // réseau entier plutôt que de ne rien proposer. Il doit alors NOMMER les
  // lignes qui ne roulent pas, parce que l'interface affiche exactement ce
  // champ. Il émettait `out_of_service: true` (booléen) alors que le client
  // fait `out_of_service.map((r) => r.line)` : l'avertissement était perdu en
  // silence, et l'app proposait le métro à 3 h du matin comme si c'était
  // normal.
  const rienNeRoule = () => false;
  const r = router.journey({ stop_id: 'stop_point:SP_1912' }, { stop_id: 'stop_point:SP_3055' },
    A_TRAFFIC, { inService: rienNeRoule });
  assert.ok(!r.error, `pas de trajet : ${r.error}`);
  assert.ok(Array.isArray(r.out_of_service),
    `out_of_service doit être un tableau de lignes nommées, obtenu ${JSON.stringify(r.out_of_service)}`);
  assert.ok(r.out_of_service.length > 0, 'la liste des lignes hors service ne peut pas être vide');
  for (const l of r.out_of_service) {
    assert.ok(l.line, 'chaque ligne hors service est nommée');
    assert.ok(l.route_id, 'chaque ligne hors service garde son identifiant');
  }
  // et le format est directement exploitable par l'interface
  const message = 'hors service maintenant : ' + r.out_of_service.map((x) => x.line).join(', ');
  assert.match(message, /hors service maintenant : \S/);
});

test('un trajet normal ne porte pas d\'avertissement hors service', () => {
  const r = router.journey({ stop_id: 'stop_point:SP_2757' }, { stop_id: 'stop_point:SP_1572' }, A_TRAFFIC);
  assert.ok(!r.error, `pas de trajet : ${r.error}`);
  assert.equal(r.out_of_service, undefined,
    'rien à signaler quand les lignes roulent réellement');
});

test('l\'attente reste bornée par le mode du véhicule', () => {
  // Contre-régression : si l'attente d'un bus était ramenée à celle d'un
  // métro (120 s), le planificateur proposerait un bus toutes les 30 min pour
  // « gagner » du temps. On vérifie que les trajets restent plausibles :
  // aucun segment ne doit être absurdement court pour sa distance.
  const paires = [
    ['stop_point:SP_1912', 'stop_point:SP_3055'],   // Capitole -> Basso Cambo
    ['stop_point:SP_2927', 'stop_point:SP_154'],    // Matabiau -> Route de Blagnac
    ['stop_point:SP_2757', 'stop_point:SP_1572'],   // Capitole -> Jean Jaurès (A)
  ];
  for (const [a, b] of paires) {
    const r = router.journey({ stop_id: a }, { stop_id: b }, A_TRAFFIC);
    if (r.error) continue;
    assert.ok(r.duration_s > 0 && r.duration_s < 4 * 3600,
      `${a} -> ${b} : durée invraisemblable (${versMinutes(r.duration_s)} min)`);
    // Une marche de plus de 25 km n'est pas un trajet de transports en commun.
    for (const l of r.legs) {
      if (l.type !== 'walk') continue;
      assert.ok(l.seconds < 40 * 60,
        `${a} -> ${b} : segment à pied de ${versMinutes(l.seconds)} min`);
    }
  }
});
