// F-44A3E8 — régression sur la capacité des inscriptions OAuth.
// Tests locaux, sans réseau, avec clients et horloge fictifs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.mjs';
import { createOAuth, ErreurOAuth } from '../lib/oauth.mjs';
import { pkce } from '../lib/atlas.mjs';

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const META = { client_name: 'Assistant de test', redirect_uris: [REDIRECT] };
const MINUTE = 60;
const JOUR = 86400;

function banc() {
  const horloge = { t: 1_800_000_000 };
  const store = createStore({ dir: null });
  const oauth = createOAuth({ store, now: () => horloge.t });
  const inscrire = () => oauth.enregistrerClient(META).client_id;
  return { horloge, store, oauth, inscrire };
}
function remplir(inscrire, n) {
  return Array.from({ length: n }, () => inscrire());
}
function autoriser(oauth, clientId) {
  const { verifier, challenge } = pkce();
  const demande = oauth.ouvrirDemande({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
  const code = new URL(oauth.conclure(demande, '42', { accord: true })).searchParams.get('code');
  return oauth.echanger({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier });
}

test('F-44A3E8 : un plafond rempli de clients jamais utilisés bloque seulement la fenêtre initiale', () => {
  const { oauth, horloge, inscrire } = banc();
  const ids = remplir(inscrire, 300);
  assert.equal(new Set(ids).size, 300, 'aucune déduplication de clients distincts');
  assert.throws(inscrire, (e) => e instanceof ErreurOAuth && e.error === 'temporarily_unavailable' && e.statut === 503);
  horloge.t += 11 * MINUTE;
  const suivant = inscrire();
  assert.ok(suivant && !ids.includes(suivant), 'un client légitime peut être créé après la fenêtre');
  assert.equal(oauth.client(ids[0]), null, 'le plus ancien client inactif est libéré');
  assert.ok(oauth.client(ids[1]), 'les autres clients ne sont pas effacés en bloc');
});

test('F-44A3E8 : un client ayant des jetons actifs ne peut être évincé', () => {
  const { oauth, horloge, inscrire } = banc();
  const autorise = inscrire();
  const jetons = autoriser(oauth, autorise);
  const inactifs = remplir(inscrire, 299);
  horloge.t += 11 * MINUTE;
  inscrire();
  assert.ok(oauth.client(autorise), 'client OAuth autorisé conservé');
  assert.equal(oauth.verifier(jetons.access_token)?.uid, '42', 'jeton valide après pression sur le plafond');
  assert.equal(oauth.client(inactifs[0]), null, 'un client inutilisé est choisi à la place');
});

test('F-44A3E8 : les demandes OAuth en cours restent associées à leur client', () => {
  const { oauth, horloge, inscrire } = banc();
  const enCours = inscrire();
  const inactifs = remplir(inscrire, 299);
  horloge.t += 10 * MINUTE;
  const { challenge } = pkce();
  const demande = oauth.ouvrirDemande({ client_id: enCours, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
  horloge.t += MINUTE;
  inscrire();
  assert.ok(oauth.client(enCours));
  assert.ok(oauth.demande(demande), 'demande toujours utilisable');
  assert.equal(oauth.client(inactifs[0]), null);
});

test('F-44A3E8 : ménage des clients jamais utilisés après 24 heures sans toucher aux autorisés', () => {
  const { oauth, horloge, inscrire } = banc();
  const autorise = inscrire();
  const jetons = autoriser(oauth, autorise);
  const inutilise = inscrire();
  horloge.t += 25 * 3600;
  inscrire(); // déclenche le ménage sans saturer le plafond
  assert.equal(oauth.client(inutilise), null);
  assert.ok(oauth.client(autorise));
  assert.equal(oauth.verifier(jetons.refresh_token), null, 'un refresh token ne devient jamais un jeton d’accès');
});

test('F-44A3E8 : un ancien client déjà autorisé garde son identifiant après expiration des jetons', () => {
  const { oauth, horloge, inscrire } = banc();
  const autorise = inscrire();
  autoriser(oauth, autorise);
  horloge.t += 91 * JOUR;
  remplir(inscrire, 299);
  horloge.t += 11 * MINUTE;
  inscrire();
  assert.ok(oauth.client(autorise), 'la rotation de clients inutilisés ne révoque pas un ancien client autorisé');
});
