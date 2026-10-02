// Un fichier servi au navigateur ne change pas sans changer d'adresse.
// Voir scripts/versions.mjs : le CDN garde les .js et .css par adresse, des
// heures durant, quoi que disent les en-têtes de cache de l'origine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifier, etat } from '../scripts/versions.mjs';

test('fichiers versionnés : une seule version, et aucun changement sans la relever', () => {
  assert.deepEqual(verifier(), []);
});

test('le service worker est enregistré sous la version des fichiers qu’il précache', () => {
  const e = etat();
  assert.ok(e.version, `versions : ${e.versions.join(', ')}`);
  assert.equal(e.enregistrement, e.version);
  assert.deepEqual(e.manquentAuSw, []);
  assert.ok('sw.js' in e.empreintes && 'app.js' in e.empreintes && 'compte.js' in e.empreintes);
});
