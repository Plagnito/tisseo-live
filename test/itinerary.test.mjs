// Tests de lib/itinerary.mjs — le choix du sens d'une ligne.
//
// C'est la fonction la plus facile à faire silencieusement fausse de tout le
// projet : le flux temps réel ne dit jamais « ce bus va à Basso Cambo », juste
// « il est entre tel et tel arrêt ». Si on choisit la mauvaise variante, tout
// l'itinéraire du véhicule est inversé et rien ne semble anormal à l'écran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normPlace, pickVariantForVehicle } from '../lib/itinerary.mjs';

// Deux variantes d'une même ligne de métro, comme on les trouve dans le GTFS.
const LIGNE_A = [
  {
    headsign: 'Basso Cambo',
    stops: [
      { id: 'a1', name: 'Basso Cambo' },
      { id: 'a2', name: 'Bagatelle' },
      { id: 'a3', name: 'Fontaine Lestang' },
      { id: 'a4', name: 'Arènes' },
      { id: 'a5', name: 'Capitole' },
    ],
  },
  {
    headsign: 'Basso Cambo',
    stops: [
      { id: 'b1', name: 'Bellevue' },
      { id: 'b2', name: 'Jean Jaurès' },
      { id: 'b3', name: 'Jean Jaurès' },
      { id: 'b4', name: 'Capitole' },
    ],
  },
];

test('normPlace : accents, casse et ponctuation indifférentes', () => {
  assert.equal(normPlace('Hôpital Ranguei'), 'hopital ranguei');
  assert.equal(normPlace('BASSO CAMBO'), 'basso cambo');
  assert.equal(normPlace('Saint-Orens -Fréhel'), 'saint orens frehel');
  assert.equal(normPlace("L'Esquiron"), 'l esquiron');
  assert.equal(normPlace(''), '');
  assert.equal(normPlace(null), '');
  assert.equal(normPlace(undefined), '');
});

test('normPlace : tolère les espaces en trop', () => {
  assert.equal(normPlace('  Jean   Jaurès '), 'jean jaures');
  assert.equal(normPlace('Jean-Jaurès'), normPlace('Jean Jaurès'));
});

test('la destination du véhicule désigne la bonne variante', () => {
  // Un bus à Basso Cambo ne peut pas être celui de Bellevue.
  const v = { destination: 'Basso Cambo', from: 'Bagatelle', to: 'Capitole' };
  const r = pickVariantForVehicle(LIGNE_A, v);
  assert.equal(r.variant, LIGNE_A[0]);
  assert.equal(r.index, 0);
  assert.ok(!r.ambiguous);
  assert.ok(r.why.includes('destination'), `indices retenus : ${r.why}`);
});

test('même destination, autre position : le départ tranche', () => {
  // Les deux variantes s'appellent pareil (« Basso Cambo » est le terminus
  // des deux côtés sur le réseau tisséen) : c'est le départ qui départage.
  const v = { destination: 'Basso Cambo', from: 'Bellevue', to: 'Capitole' };
  const r = pickVariantForVehicle(LIGNE_A, v);
  assert.equal(r.variant, LIGNE_A[1]);
  assert.ok(r.why.includes('depart'), `indices retenus : ${r.why}`);
});

test('le terminus atteint l\'arrêt suivant : bon sens identifié', () => {
  // Véhicule dont le prochain arrêt est le dernier de la variante 2.
  const v = { destination: 'inconnu', from: 'inconnu', to: 'Capitole', next_stop_id: 'b4' };
  const r = pickVariantForVehicle(LIGNE_A, v);
  assert.equal(r.variant, LIGNE_A[1]);
});

test('aucune destination : le terminus tranche encore', () => {
  const v = { from: 'Capitole', to: 'Arènes' };
  const r = pickVariantForVehicle(LIGNE_A, v);
  assert.equal(r.variant, LIGNE_A[0]);
});

test('le prochain arrêt de la variante départage à lui seul', () => {
  const v = { next_stop_id: 'a2' };
  const r = pickVariantForVehicle(LIGNE_A, v);
  assert.equal(r.variant, LIGNE_A[0]);
  assert.ok(r.why.includes('prochain arret'));
});

test('sans le moindre signal, on le signale plutôt que d\'inventer', () => {
  // Ni destination, ni arrêt, ni correspondance : choisir au hasard
  // produirait un itinéraire plausible mais faux, ce qui est pire qu'un
  // aveu d'ignorance.
  const r = pickVariantForVehicle(LIGNE_A, { destination: '', from: '', to: '' });
  assert.ok(r.ambiguous, 'devrait être marqué ambigu');
  assert.equal(r.score, 0);
});

test('une correspondance exacte l\'emporte sur une approximation', () => {
  const variantes = [
    { headsign: 'Rangueil Centre Commercial', stops: [{ id: 'r1', name: 'Rangueil Centre Commercial' }] },
    { headsign: 'Rangueil', stops: [{ id: 'r2', name: 'Rangueil' }] },
  ];
  const r = pickVariantForVehicle(variantes, { destination: 'Rangueil' });
  assert.equal(r.variant, variantes[1], 'il ne faut pas confondre Rangueil et son centre commercial');
});

test('l\'approximation ne mord que sur un nom assez long', () => {
  // « Jean » seul ne doit pas être confondu avec « Jean Jaurès ».
  const variantes = [
    { headsign: 'Jean Jaurès', stops: [{ id: 'j1', name: 'Jean Jaurès' }] },
    { headsign: 'Jean', stops: [{ id: 'j2', name: 'Jean' }] },
  ];
  const r = pickVariantForVehicle(variantes, { destination: 'Jean' });
  assert.equal(r.variant, variantes[1]);
});

test('accents et casse ne font pas perdre la correspondance', () => {
  const variantes = [
    { headsign: 'Aéroconstellation', stops: [{ id: 'x1', name: 'Aéroconstellation' }] },
    { headsign: 'Blagnac', stops: [{ id: 'x2', name: 'Blagnac' }] },
  ];
  const r = pickVariantForVehicle(variantes, { destination: 'AEROCONSTELLATION' });
  assert.equal(r.variant, variantes[0]);
});

test('le score est justifié et l\'ordre des indices est respecté', () => {
  const r = pickVariantForVehicle(LIGNE_A, { destination: 'Basso Cambo', from: 'Bagatelle', to: 'Capitole' });
  assert.equal(typeof r.score, 'number');
  assert.ok(r.score > 0);
  assert.ok(Array.isArray(r.why) && r.why.length > 0);
});

test('cas limites : pas de variante, pas de véhicule, entrées sales', () => {
  assert.equal(pickVariantForVehicle([], { destination: 'x' }), null);
  assert.equal(pickVariantForVehicle(null, { destination: 'x' }), null);
  assert.equal(pickVariantForVehicle(LIGNE_A, null), null);
  assert.equal(pickVariantForVehicle(LIGNE_A, undefined), null);
  // Une variante dégénérée (pas de tableau d'arrêts) ne doit pas exploser.
  const r = pickVariantForVehicle([{ headsign: 'X' }], { destination: 'X' });
  assert.equal(r.variant.headsign, 'X');
});

test('le résultat désigne bien la variante choisie, par son index', () => {
  const v = { destination: 'Basso Cambo', from: 'Bellevue', to: 'Capitole' };
  const r = pickVariantForVehicle(LIGNE_A, v);
  assert.equal(LIGNE_A[r.index], r.variant);
});

test('le choix est stable : deux appels donnent le même résultat', () => {
  const v = { destination: 'Basso Cambo', from: 'Bagatelle', to: 'Capitole' };
  assert.deepEqual(
    pickVariantForVehicle(LIGNE_A, v).variant,
    pickVariantForVehicle(LIGNE_A, v).variant,
  );
});
