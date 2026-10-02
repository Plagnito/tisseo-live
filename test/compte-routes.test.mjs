// Comptes : le parcours complet par HTTP — connexion Atlas, trajets, partages,
// OAuth des assistants, outils MCP du compte.
//
// Atlas est joué par scripts/banc-atlas.mjs (trois comptes en dur, mêmes refus
// que le vrai). Le calculateur d'itinéraires est remplacé par un témoin qui
// note ce qu'on lui demande : ces tests portent sur les comptes, pas sur le
// routage, qui a les siens.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { request as httpRequest } from 'node:http';
import { creerFauxAtlas } from '../scripts/banc-atlas.mjs';
import { createStore } from '../lib/store.mjs';
import { createAccounts, epochParis } from '../lib/account.mjs';
import { createAtlas, createAtlasSessions, pkce } from '../lib/atlas.mjs';
import { createOAuth } from '../lib/oauth.mjs';
import { monterCompte } from '../lib/compte-routes.mjs';
import { createMcpServer } from '../lib/mcp.mjs';
import { createAccountTools, INSTRUCTIONS_COMPTE, lireJours } from '../lib/tools-compte.mjs';

const ecouter = (s) => new Promise((ok) => { const l = s.listen(0, '127.0.0.1', () => ok(l.address().port)); });
const B = {}; // le banc, partagé par les tests de ce fichier
const horloge = { t: epochParis(2026, 10, 5, 7, 0) }; // lundi 5 octobre 2026, 07:00

before(async () => {
  B.fa = creerFauxAtlas();
  const portAtlas = await ecouter(B.fa.serveur);
  const store = createStore({ dir: null });
  const now = () => horloge.t;
  B.accounts = createAccounts({ store, now });
  const atlas = createAtlas({ base: `http://127.0.0.1:${portAtlas}` });
  const atlasSessions = createAtlasSessions({ atlas, accounts: B.accounts, now });
  B.oauth = createOAuth({ store, now });
  B.calculs = [];
  const app = express();
  B.compte = monterCompte(app, {
    accounts: B.accounts, atlas, atlasSessions, oauth: B.oauth, now,
    calculer: async (args) => {
      B.calculs.push(args);
      if (B.calculEchoue) throw new Error('Aucun itinéraire trouvé (témoin).');
      return { partir_a: '08:02', arriver_a: '08:21', duree_min: 19, etapes: [] };
    },
    resoudreLieu: async (q) => {
      if (/nulle part/i.test(q)) throw new Error(`Lieu introuvable : « ${q} ».`);
      const nom = q.trim().replace(/^./, (c) => c.toUpperCase());
      return { type: 'arret', nom, arret_id: `stop_point:SP_${nom.length}`, lat: 43.6, lon: 1.44 };
    },
    arretExiste: () => true,
    horairesJusquau: () => '20261028',
    publicUrl: 'https://tisseo.plagnito.com',
    // Ces tests ouvrent des dizaines de sessions depuis la même adresse ; le
    // garde-fou de débit a son propre test, plus bas, avec ses vraies valeurs.
    debits: { connexion: [10_000, 60_000], inscription: [10_000, 60_000], compte: [100_000, 60_000] },
  });
  const mcp = createMcpServer({
    name: 'banc', title: 'Banc', version: '0', instructions: 'public', instructionsCompte: INSTRUCTIONS_COMPTE,
    tools: [
      { name: 'lignes', description: 'outil public témoin', inputSchema: { type: 'object', properties: {} }, handler: async () => ({ ok: true }) },
      ...createAccountTools({ accounts: B.accounts, compte: B.compte, now }),
    ],
  });
  const corps = express.json();
  app.all('/mcp', corps, B.compte.identifierAssistant(), (req, res, next) => mcp.httpHandler(req, res).catch(next));
  app.all('/mcp/compte', corps, B.compte.identifierAssistant({ obligatoire: true }), (req, res, next) => mcp.httpHandler(req, res).catch(next));
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: String(err.message) }); });
  B.serveur = app.listen(0, '127.0.0.1');
  await new Promise((ok) => B.serveur.once('listening', ok));
  B.base = `http://127.0.0.1:${B.serveur.address().port}`;
});
after(() => { B.serveur?.close(); B.fa?.serveur.close(); });

// --- outils -------------------------------------------------------------------
/** Une requête GET avec l'en-tête Host de son choix (ce que `fetch` interdit). */
function brut(chemin, hote) {
  return new Promise((ok, ko) => {
    const u = new URL(B.base);
    httpRequest({ host: u.hostname, port: u.port, path: chemin, headers: { Host: hote } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { ok(JSON.parse(s)); } catch (e) { ko(e); } });
    }).on('error', ko).end();
  });
}
const cookieDe =(res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

/** Fait le tour complet par le faux Atlas. Rend la dernière réponse et le cookie. */
async function connexion(compteId, chemin = '/api/auth/connexion', { navigateur = '', revenir = true } = {}) {
  const r1 = await fetch(B.base + chemin, { redirect: 'manual', headers: navigateur ? { Cookie: navigateur } : {} });
  assert.equal(r1.status, 302, 'la connexion renvoie vers Atlas');
  // Le témoin posé au départ : c'est ce qui fait de nous « le même navigateur » au retour.
  const temoin = cookieDe(r1);
  const versAtlas = new URL(r1.headers.get('location'));
  versAtlas.searchParams.set('compte', String(compteId));
  const r2 = await fetch(versAtlas, { redirect: 'manual' });
  assert.equal(r2.status, 302, 'Atlas renvoie le code');
  const retour = r2.headers.get('location');
  if (!revenir) return { temoin, versAtlas, retour, depart: r1 };
  const r3 = await fetch(retour, { redirect: 'manual', headers: { Cookie: temoin } });
  return { res: r3, cookie: cookieDe(r3), versAtlas, retour, temoin, depart: r1 };
}
async function session(compteId) {
  const { res, cookie } = await connexion(compteId);
  assert.equal(res.status, 302);
  assert.match(cookie, /^tisseo_session=/);
  return cookie;
}
async function api(cookie, methode, chemin, corps, entetes = {}) {
  const res = await fetch(B.base + chemin, {
    method: methode,
    headers: { ...(cookie ? (cookie.startsWith('Bearer ') ? { Authorization: cookie } : { Cookie: cookie }) : {}), ...(corps ? { 'Content-Type': 'application/json' } : {}), ...entetes },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { statut: res.status, json, res };
}
async function mcpAppel(chemin, jeton, methode, params) {
  const res = await fetch(B.base + chemin, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: methode, params }),
  });
  return { statut: res.status, json: await res.json(), res };
}
const outil = async (jeton, name, args = {}) => {
  const r = await mcpAppel('/mcp/compte', jeton, 'tools/call', { name, arguments: args });
  return { erreur: Boolean(r.json.result?.isError), texte: r.json.result?.content?.[0]?.text, donnees: r.json.result?.structuredContent };
};
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
/** Le parcours d'un assistant : inscription, demande, accord de l'humain, jetons. */
async function autoriserAssistant(cookie, { amis = false } = {}) {
  const reg = await api(null, 'POST', '/oauth/register', { client_name: 'ChatGPT', redirect_uris: [CHATGPT] });
  assert.equal(reg.statut, 201);
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({ client_id: reg.json.client_id, redirect_uri: CHATGPT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'tisseo amis', state: 'etat-chatgpt' });
  const annonce = (await (await fetch(`${B.base}/.well-known/oauth-authorization-server`)).json()).authorization_endpoint;
  const r1 = await fetch(`${annonce}?${q}`, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  const accord = r1.headers.get('location');
  assert.match(accord, /^\/api\/oauth\/accord\?demande=[0-9a-f]+$/);
  const demande = accord.split('=')[1];
  const r2 = await fetch(`${B.base}/api/oauth/accord`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ demande, choix: 'oui', ...(amis ? { amis: '1' } : {}) }),
  });
  assert.equal(r2.status, 303);
  const retour = new URL(r2.headers.get('location'));
  assert.equal(retour.origin + retour.pathname, CHATGPT);
  assert.equal(retour.searchParams.get('state'), 'etat-chatgpt');
  // Le point des jetons reçoit un FORMULAIRE, comme l'impose la RFC 6749.
  const r3 = await fetch(`${B.base}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: reg.json.client_id, code: retour.searchParams.get('code'), redirect_uri: CHATGPT, code_verifier: verifier }),
  });
  assert.equal(r3.status, 200);
  return { clientId: reg.json.client_id, jetons: await r3.json(), accord };
}

// --- connexion -----------------------------------------------------------------
test('sans session : la page le sait sans erreur, les écritures sont refusées', async () => {
  const r = await api(null, 'GET', '/api/compte');
  assert.equal(r.statut, 200, 'un visiteur anonyme ne doit pas provoquer de 401 à chaque ouverture');
  assert.deepEqual(r.json, { connecte: false, connexion: '/api/auth/connexion' });
  for (const [m, c] of [['POST', '/api/compte/trajets'], ['GET', '/api/compte/trajets'], ['GET', '/api/compte/amis'], ['DELETE', '/api/compte'], ['GET', '/api/compte/assistants']]) {
    const x = await api(null, m, c, m === 'POST' ? { de: 'A', a: 'B' } : undefined);
    assert.equal(x.statut, 401, `${m} ${c}`);
    assert.equal(x.json.code, 'CONNEXION');
  }
});

test('connexion par Atlas : PKCE, cookie fermé au script, retour sur la page', async () => {
  const { res, versAtlas } = await connexion(1, '/api/auth/connexion?retour=/%3Fcompte%3D1');
  assert.equal(versAtlas.searchParams.get('client_id'), 'tisseo-live');
  assert.equal(versAtlas.searchParams.get('code_challenge_method'), 'S256');
  assert.match(versAtlas.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(versAtlas.searchParams.get('redirect_uri'), `${B.base}/api/auth/retour`);
  assert.equal(res.headers.get('location'), '/?compte=1');
  const pose = res.headers.getSetCookie()[0];
  assert.match(pose, /HttpOnly/);
  assert.match(pose, /SameSite=Lax/);
  assert.doesNotMatch(pose, /Secure/, 'en local (http), un cookie Secure ne reviendrait jamais');
  const moi = await api(cookieDe(res), 'GET', '/api/compte');
  assert.equal(moi.json.connecte, true);
  assert.deepEqual(moi.json.compte, { id: '1', pseudo: 'Plagnito' });
  assert.equal(moi.json.horaires_jusquau, '20261028');
});

test('le retour de connexion ne sert qu’une fois, et ne redirige jamais ailleurs', async () => {
  const c = await connexion(1);
  const rejoue = await fetch(c.retour, { redirect: 'manual' });
  assert.equal(rejoue.status, 400, 'le même retour, rejoué, est refusé');
  assert.equal(cookieDe(rejoue), '');
  const invente = await fetch(`${B.base}/api/auth/retour?code=abc&state=inconnu`, { redirect: 'manual' });
  assert.equal(invente.status, 400);
  for (const mauvais of ['//pirate.example/x', 'https://pirate.example', '/\\pirate.example']) {
    const { res } = await connexion(1, `/api/auth/connexion?retour=${encodeURIComponent(mauvais)}`);
    assert.equal(res.headers.get('location'), '/', mauvais);
  }
});

test('une connexion se termine dans le navigateur qui l’a commencée', async () => {
  // Quelqu'un commence une connexion avec SON compte et fait ouvrir l'adresse
  // de retour à une autre personne : elle ne doit pas se retrouver dans ce compte.
  const piege = await connexion(2, '/api/auth/connexion', { revenir: false });
  assert.match(piege.depart.headers.getSetCookie()[0], /^tisseo_demande=[0-9a-f]{36}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
  const victime = await fetch(piege.retour, { redirect: 'manual' });
  assert.equal(victime.status, 400, 'sans le témoin du navigateur de départ : refusé');
  assert.equal(cookieDe(victime), '', 'et aucune session n’est ouverte');
  assert.match(await victime.text(), /pas été commencée dans ce navigateur/);

  const autre = await connexion(2, '/api/auth/connexion', { revenir: false });
  const ailleurs = await fetch(autre.retour, { redirect: 'manual', headers: { Cookie: 'tisseo_demande=' + 'ab'.repeat(18) } });
  assert.equal(ailleurs.status, 400, 'avec le témoin d’un AUTRE navigateur : refusé');
  const tard = await fetch(autre.retour, { redirect: 'manual', headers: { Cookie: autre.temoin } });
  assert.equal(tard.status, 400, 'une tentative refusée est consommée : elle ne se rejoue pas, même avec le bon témoin');

  // Deux onglets du même navigateur ne se gênent pas : le témoin est réutilisé.
  const un = await connexion(1, '/api/auth/connexion', { revenir: false });
  const deux = await connexion(1, '/api/auth/connexion', { revenir: false, navigateur: un.temoin });
  assert.equal(deux.temoin, un.temoin, 'le second onglet garde le même témoin');
  for (const onglet of [un, deux]) {
    const r = await fetch(onglet.retour, { redirect: 'manual', headers: { Cookie: un.temoin } });
    assert.equal(r.status, 302);
    assert.match(cookieDe(r), /^tisseo_session=/);
  }
  // Un témoin fantaisiste envoyé au départ n'est pas adopté tel quel.
  const forge = await connexion(1, '/api/auth/connexion', { revenir: false, navigateur: 'tisseo_demande=<script>' });
  assert.match(forge.temoin, /^tisseo_demande=[0-9a-f]{36}$/);
});

test('adresses visitées par le navigateur : sous /api/, et les anciennes restent servies', async () => {
  // Un service worker ancien intercepte toute navigation hors /api/ et sert la
  // page d'accueil à la place d'une redirection (panne du 02/10/2026).
  const neuve = await fetch(`${B.base}/api/auth/connexion`, { redirect: 'manual' });
  assert.equal(neuve.status, 302);
  assert.equal(new URL(neuve.headers.get('location')).searchParams.get('redirect_uri'), `${B.base}/api/auth/retour`, 'le retour est sous /api/ lui aussi');
  // Les anciennes adresses répondent par une PAGE (200) qui renvoie, jamais par
  // une redirection : c'est la seule forme qu'un ancien service worker laisse passer.
  for (const [ancienne, nouvelle] of [
    ['/auth/connexion?retour=%2F%3Fcompte%3D1&app=android', '/api/auth/connexion?retour=%2F%3Fcompte%3D1&app=android'],
    ['/auth/retour?code=x&state=y', '/api/auth/retour?code=x&state=y'],
    ['/oauth/authorize?client_id=tl_x&state=a%20b', '/api/oauth/authorize?client_id=tl_x&state=a%20b'],
    ['/oauth/accord?demande=abc', '/api/oauth/accord?demande=abc'],
    ['/auth/connexion', '/api/auth/connexion'],
  ]) {
    const r = await fetch(B.base + ancienne, { redirect: 'manual' });
    assert.equal(r.status, 200, ancienne);
    assert.equal(r.headers.get('refresh'), `0; url=${nouvelle}`, ancienne);
    assert.equal(r.headers.get('location'), null);
    assert.ok((await r.text()).includes(`href="${nouvelle.replace(/&/g, '&amp;')}"`), 'et un lien pour qui a désactivé le renvoi automatique');
  }
  // La requête d'origine ne peut pas emmener ailleurs : la cible commence toujours par notre chemin.
  const tordu = await fetch(`${B.base}/auth/connexion?retour=https://pirate.example&x=%0d%0aSet-Cookie:a`, { redirect: 'manual' });
  assert.match(tordu.headers.get('refresh'), /^0; url=\/api\/auth\/connexion\?/);
  assert.equal(tordu.headers.getSetCookie().length, 0);
});

test('écran d’accord : l’envoi du formulaire tel qu’un navigateur le fait', async () => {
  const cookie = await session(1);
  const ouvrir = async () => {
    const reg = await api(null, 'POST', '/oauth/register', { client_name: 'ChatGPT', redirect_uris: [CHATGPT] });
    const q = new URLSearchParams({ client_id: reg.json.client_id, redirect_uri: CHATGPT, response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256', scope: 'tisseo', state: 'e' });
    const r = await fetch(`${B.base}/api/oauth/authorize?${q}`, { redirect: 'manual' });
    return r.headers.get('location').split('=')[1];
  };
  const envoyer = async (demande, entetes) => fetch(`${B.base}/api/oauth/accord`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', ...entetes },
    body: new URLSearchParams({ demande, choix: 'oui' }),
  });
  const page = await fetch(`${B.base}/api/oauth/accord?demande=${await ouvrir()}`, { headers: { Cookie: cookie } });
  assert.equal(page.headers.get('referrer-policy'), 'same-origin', '« no-referrer » ferait envoyer « Origin: null » par Chrome, et l’accord serait refusé');
  assert.match(await page.text(), /<form method="post" action="\/api\/oauth\/accord">/);

  assert.equal((await envoyer(await ouvrir(), { Origin: B.base })).status, 303, 'origine de nos pages : accepté');
  assert.equal((await envoyer(await ouvrir(), { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' })).status, 303, 'origine masquée mais envoi venu de nos pages : accepté');
  assert.equal((await envoyer(await ouvrir(), { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })).status, 401, 'origine masquée, envoi venu d’ailleurs : refusé');
  assert.equal((await envoyer(await ouvrir(), { Origin: 'null' })).status, 401, 'origine masquée, sans autre indice : refusé');
  assert.equal((await envoyer(await ouvrir(), { Origin: 'https://pirate.example' })).status, 401, 'autre site : refusé');
});

test('déconnexion : le jeton ne sert plus', async () => {
  const cookie = await session(2);
  assert.equal((await api(cookie, 'GET', '/api/compte')).json.connecte, true);
  const d = await api(cookie, 'POST', '/api/auth/deconnexion', {});
  assert.match(d.res.headers.getSetCookie()[0], /Max-Age=0/);
  assert.equal((await api(cookie, 'GET', '/api/compte')).json.connecte, false);
});

test('une écriture portée par le cookie doit venir de nos pages', async () => {
  const cookie = await session(1);
  const r = await api(cookie, 'POST', '/api/compte/trajets', { de: 'Capitole', a: 'Arènes' }, { Origin: 'https://pirate.example' });
  assert.equal(r.statut, 403);
  assert.equal(r.json.code, 'ORIGINE');
  const ok = await api(cookie, 'POST', '/api/compte/trajets', { de: 'Capitole', a: 'Arènes' }, { Origin: B.base });
  assert.equal(ok.statut, 201);
});

test('application Android : un billet à usage unique, jamais le jeton dans l’adresse', async () => {
  const { res } = await connexion(3, '/api/auth/connexion?app=android');
  assert.equal(res.status, 200);
  assert.equal(cookieDe(res), '', 'aucun cookie pour l’application');
  const html = await res.text();
  const billet = /tisseo-ville:\/\/auth\?billet=([0-9a-f]+)/.exec(html)?.[1];
  assert.ok(billet, 'la page renvoie vers l’application');
  assert.match(res.headers.get('x-frame-options'), /DENY/);
  const e = await api(null, 'POST', '/api/auth/echange', { billet });
  assert.equal(e.statut, 200);
  assert.deepEqual(e.json.compte, { id: '3', pseudo: 'Kiri' });
  assert.ok(!html.includes(e.json.jeton), 'le jeton de session n’est pas dans la page');
  assert.equal((await api(`Bearer ${e.json.jeton}`, 'GET', '/api/compte')).json.compte.pseudo, 'Kiri');
  assert.equal((await api(null, 'POST', '/api/auth/echange', { billet })).statut, 400, 'le billet ne sert qu’une fois');
});

// --- trajets ---------------------------------------------------------------------
test('trajets enregistrés : les lieux sont résolus à l’enregistrement', async () => {
  const cookie = await session(1);
  const cree = await api(cookie, 'POST', '/api/compte/trajets', { nom: 'Travail', de: 'capitole', a: 'jean jaurès' });
  assert.equal(cree.statut, 201);
  assert.equal(cree.json.trajet.de.texte, 'Capitole', 'le nom gardé est celui que le calculateur a compris');
  assert.equal(cree.json.trajet.de.stop_id, 'stop_point:SP_8');
  const faute = await api(cookie, 'POST', '/api/compte/trajets', { de: 'Capitole', a: 'nulle part' });
  assert.equal(faute.statut, 422);
  assert.equal(faute.json.code, 'LIEU');
  assert.match(faute.json.error, /Arrivée — Lieu introuvable/);
  // Un lieu déjà précis (position, arrêt choisi sur la carte) n'est pas re-résolu.
  const precis = await api(cookie, 'POST', '/api/compte/trajets', { de: { texte: 'Ma position', lat: 43.61, lon: 1.45 }, a: 'Arènes' });
  assert.equal(precis.json.trajet.de.texte, 'Ma position');

  B.calculs.length = 0;
  const id = cree.json.trajet.id;
  const calc = await api(cookie, 'GET', `/api/compte/trajets/${id}/calcul`);
  assert.equal(calc.statut, 200);
  assert.deepEqual(B.calculs[0], { depart: 'stop_point:SP_8', arrivee: 'stop_point:SP_11' });
  assert.equal(calc.json.trajet.utilisations, 1);
  assert.equal(calc.json.itineraire.arriver_a, '08:21');
  await api(cookie, 'GET', `/api/compte/trajets/${id}/calcul?arriver=09:00`);
  assert.equal(B.calculs[1].arriver_avant, '09:00');
  await api(cookie, 'GET', `/api/compte/trajets/${id}/calcul?heure=17:30`);
  assert.equal(B.calculs[2].heure_depart, '17:30');
  assert.equal((await api(cookie, 'GET', '/api/compte/trajets')).json.trajets[0].nom, 'Travail', 'le plus utilisé passe devant');
  assert.equal((await api(cookie, 'GET', '/api/compte/trajets/t_inconnu/calcul')).statut, 404);
  const illisible = await fetch(`${B.base}/api/compte/trajets`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{pas du json' });
  assert.equal(illisible.status, 400, 'un corps illisible est une erreur de l’appelant, pas une panne');
});

test('trajets planifiés : calculés à leur prochaine occurrence', async () => {
  const cookie = await session(1);
  const p = await api(cookie, 'POST', '/api/compte/planifies', { de: 'Capitole', a: 'Arènes', heure: '08:15', jours: [1, 2, 3, 4, 5], mode: 'arriver', nom: 'Boulot' });
  assert.equal(p.statut, 201);
  assert.equal(p.json.planifie.prochaine, epochParis(2026, 10, 5, 8, 15));
  B.calculs.length = 0;
  const c = await api(cookie, 'GET', `/api/compte/planifies/${p.json.planifie.id}/calcul`);
  assert.equal(c.statut, 200);
  assert.equal(B.calculs[0].arriver_avant, '2026-10-05T08:15');
  assert.equal(c.json.avertissement, undefined);

  const loin = await api(cookie, 'POST', '/api/compte/planifies', { de: 'Capitole', a: 'Arènes', heure: '10:00', date: '2026-12-24' });
  const cl = await api(cookie, 'GET', `/api/compte/planifies/${loin.json.planifie.id}/calcul`);
  assert.equal(B.calculs[1].heure_depart, '2026-12-24T10:00');
  assert.match(cl.json.avertissement, /s’arrêtent le 28\/10\/2026/, 'au-delà des horaires publiés, on le dit');

  const hier = await api(cookie, 'POST', '/api/compte/planifies', { de: 'Capitole', a: 'Arènes', heure: '10:00', date: '2026-10-04' });
  assert.equal(hier.json.planifie.passe, true);
  const ch = await api(cookie, 'GET', `/api/compte/planifies/${hier.json.planifie.id}/calcul`);
  assert.equal(ch.statut, 409);
  assert.equal(ch.json.code, 'PASSE');

  B.calculEchoue = true;
  try {
    const ce = await api(cookie, 'GET', `/api/compte/planifies/${loin.json.planifie.id}/calcul`);
    assert.equal(ce.statut, 422);
    assert.equal(ce.json.code, 'CALCUL');
    assert.match(ce.json.error, /Aucun itinéraire/, 'le message du calculateur est transmis tel quel');
  } finally { B.calculEchoue = false; }
  assert.equal((await api(cookie, 'PUT', `/api/compte/planifies/${p.json.planifie.id}`, { heure: '9h00' })).json.planifie.heure, '09:00');
  assert.equal((await api(cookie, 'DELETE', `/api/compte/planifies/${p.json.planifie.id}`)).statut, 200);
});

// --- amis et partages ----------------------------------------------------------------
test('amis : le carnet vient d’Atlas, et survit à l’expiration du jeton', async () => {
  const cookie = await session(1);
  const a = await api(cookie, 'GET', '/api/compte/amis');
  assert.deepEqual(a.json.amis.map((x) => x.pseudo).sort(), ['Bruno', 'Kiri']);
  // Le jeton d'accès Atlas vit dix minutes : passé ce délai, on rafraîchit —
  // et deux demandes simultanées ne doivent pas se voler le jeton tournant.
  horloge.t += 700; B.fa.expirerAcces();
  const [x, y] = await Promise.all([api(cookie, 'GET', '/api/compte/amis?frais=1'), api(cookie, 'GET', '/api/compte/amis?frais=1')]);
  assert.equal(x.statut, 200);
  assert.equal(y.statut, 200);
  horloge.t += 700; B.fa.expirerAcces();
  assert.equal((await api(cookie, 'GET', '/api/compte/amis?frais=1')).json.amis.length, 2, 'le jeton tourné a bien été gardé');
});

test('partager un trajet : seulement avec ses contacts, et l’ami est prévenu', async () => {
  const plagnito = await session(1), bruno = await session(2), kiri = await session(3);
  B.fa.invitations.length = 0;
  const p = await api(plagnito, 'POST', '/api/compte/partages', { type: 'trajet', amis: ['2'], trajet: { nom: 'Concert', de: 'capitole', a: 'zénith' }, message: 'On y va ?' });
  assert.equal(p.statut, 201);
  assert.equal(p.json.prevenus, 1);
  assert.equal(p.json.partage.trajet.a.texte, 'Zénith');
  assert.equal(B.fa.invitations.length, 1);
  assert.equal(B.fa.invitations[0].type, 'itineraire');
  assert.equal(B.fa.invitations[0].donnees.partage.id, p.json.partage.id);
  assert.equal(B.fa.invitations[0].donnees.partage.a, 'Zénith');

  const recus = (await api(bruno, 'GET', '/api/compte/partages')).json.recus;
  assert.equal(recus.length, 1);
  assert.equal(recus[0].de.pseudo, 'Plagnito');
  assert.equal((await api(kiri, 'GET', '/api/compte/partages')).json.recus.length, 0);
  assert.equal((await api(kiri, 'GET', `/api/compte/partages/${p.json.partage.id}`)).statut, 404, 'un tiers ne sait même pas qu’il existe');

  // Bruno et Kiri ne sont pas contacts : le partage est refusé EN ENTIER.
  const refus = await api(bruno, 'POST', '/api/compte/partages', { type: 'trajet', amis: ['1', '3'], trajet: { de: 'A', a: 'B' } });
  assert.equal(refus.statut, 403);
  assert.equal(refus.json.code, 'PAS_CONTACT');
  assert.equal((await api(plagnito, 'GET', '/api/compte/partages')).json.recus.length, 0, 'rien n’est parti vers le contact valide non plus');

  const garde = await api(bruno, 'POST', `/api/compte/partages/${p.json.partage.id}/enregistrer`);
  assert.equal(garde.statut, 201);
  assert.equal(garde.json.trajet.nom, 'Concert');
  assert.equal((await api(bruno, 'GET', '/api/compte/trajets')).json.trajets.length, 1);
});

test('le partage tient même si Atlas ne sait pas (encore) afficher la carte', async () => {
  const plagnito = await session(1), bruno = await session(2);
  B.fa.etat.typesInvitation = [];
  try {
    const p = await api(plagnito, 'POST', '/api/compte/partages', { type: 'trajet', amis: ['2'], trajet: { de: 'Capitole', a: 'Arènes' } });
    assert.equal(p.statut, 201);
    assert.equal(p.json.prevenus, 0);
    assert.match(p.json.annonce, /inconnu/i, 'la raison est dite');
    assert.ok((await api(bruno, 'GET', '/api/compte/partages')).json.recus.some((x) => x.id === p.json.partage.id));
  } finally { B.fa.etat.typesInvitation = ['itineraire', 'position']; }
});

test('position en direct : l’ami la voit, puis plus rien quand on arrête', async () => {
  const plagnito = await session(1), bruno = await session(2), kiri = await session(3);
  const p = await api(plagnito, 'POST', '/api/compte/partages', { type: 'position', amis: ['2'], duree_s: 900, trajet: { a: 'Arènes' } });
  assert.equal(p.statut, 201);
  const id = p.json.partage.id;
  assert.equal(p.json.partage.trajet.a.texte, 'Arènes');
  assert.equal(p.json.partage.trajet.de, null);
  assert.equal((await api(bruno, 'GET', `/api/compte/partages/${id}`)).json.partage.position, null);
  assert.equal((await api(bruno, 'POST', `/api/compte/partages/${id}/position`, { lat: 43.6, lon: 1.44 })).statut, 410, 'seul l’auteur envoie sa position');
  const maj = await api(plagnito, 'POST', `/api/compte/partages/${id}/position`, { lat: 43.6045, lon: 1.4442, precision_m: 8 });
  assert.equal(maj.json.reste_s, 900);
  assert.deepEqual((await api(bruno, 'GET', `/api/compte/partages/${id}`)).json.partage.position, { lat: 43.6045, lon: 1.4442, precision_m: 8, age_s: 0, fraiche: true });
  assert.equal((await api(kiri, 'GET', `/api/compte/partages/${id}`)).statut, 404);
  assert.deepEqual((await api(plagnito, 'DELETE', `/api/compte/partages/${id}`)).json, { arrete: true });
  assert.equal((await api(bruno, 'GET', `/api/compte/partages/${id}`)).statut, 404);
  assert.equal((await api(plagnito, 'POST', `/api/compte/partages/${id}/position`, { lat: 43.6, lon: 1.44 })).statut, 410);
});

test('Atlas en panne : les trajets marchent, les amis disent pourquoi ils ne marchent pas', async () => {
  const cookie = await session(1);
  horloge.t += 700; // force un rafraîchissement du jeton Atlas
  B.fa.etat.panne = true;
  try {
    const a = await api(cookie, 'GET', '/api/compte/amis?frais=1');
    assert.equal(a.statut, 401, 'le rafraîchissement refusé demande de se reconnecter');
    assert.equal(a.json.code, 'ATLAS_SESSION');
    assert.equal((await api(cookie, 'GET', '/api/compte/trajets')).statut, 200);
    assert.equal((await api(cookie, 'POST', '/api/compte/trajets', { de: 'Capitole', a: 'Balma' })).statut, 201);
    const c = await fetch(`${B.base}/api/auth/connexion`, { redirect: 'manual' });
    const versAtlas = new URL(c.headers.get('location')); versAtlas.searchParams.set('compte', '1');
    assert.equal((await fetch(versAtlas, { redirect: 'manual' })).status, 503);
  } finally { B.fa.etat.panne = false; }
});

// --- OAuth et MCP ---------------------------------------------------------------------
test('découverte : chaque adresse MCP se décrit, sur l’hôte par lequel on la voit', async () => {
  const r = await (await fetch(`${B.base}/.well-known/oauth-protected-resource/mcp/compte`)).json();
  assert.equal(r.resource, `${B.base}/mcp/compte`);
  assert.deepEqual(r.authorization_servers, [B.base]);
  assert.equal((await (await fetch(`${B.base}/.well-known/oauth-protected-resource/mcp`)).json()).resource, `${B.base}/mcp`);
  const s = await (await fetch(`${B.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(s.authorization_endpoint, `${B.base}/api/oauth/authorize`);
  assert.deepEqual(s.token_endpoint_auth_methods_supported, ['none']);
  // Un en-tête Host fantaisiste ne fabrique pas d'adresses vers ailleurs : hors
  // de la machine locale, tout est rapporté à l'adresse publique. `fetch`
  // réécrit l'en-tête Host, d'où la requête brute.
  for (const hote of ['pirate.example', 'tisseo.plagnito.com', 'localhost.pirate.example', '127.0.0.1.pirate.example:80']) {
    const d = await brut('/.well-known/oauth-authorization-server', hote);
    assert.equal(d.issuer, 'https://tisseo.plagnito.com', hote);
    assert.equal(d.authorization_endpoint, 'https://tisseo.plagnito.com/api/oauth/authorize', hote);
  }
});

test('le débit des connexions est borné', async () => {
  // Une application à part, avec le réglage par défaut : 30 par 10 minutes.
  const app = express();
  monterCompte(app, {
    accounts: B.accounts, atlas: createAtlas({ base: 'http://127.0.0.1:9' }), atlasSessions: null, oauth: B.oauth,
    calculer: async () => ({}), publicUrl: 'https://tisseo.plagnito.com',
  });
  const s = app.listen(0, '127.0.0.1');
  await new Promise((ok) => s.once('listening', ok));
  try {
    const statuts = [];
    for (let i = 0; i < 32; i++) statuts.push((await fetch(`http://127.0.0.1:${s.address().port}/api/auth/connexion`, { redirect: 'manual' })).status);
    assert.deepEqual([...new Set(statuts.slice(0, 30))], [302]);
    assert.deepEqual(statuts.slice(30), [429, 429]);
  } finally { s.close(); }
});

test('/mcp/compte exige une autorisation ; /mcp reste public', async () => {
  const sans = await mcpAppel('/mcp/compte', null, 'tools/list');
  assert.equal(sans.statut, 401);
  assert.match(sans.res.headers.get('www-authenticate'), new RegExp(`^Bearer resource_metadata="${B.base}/\\.well-known/oauth-protected-resource/mcp/compte", scope="tisseo"$`));
  const faux = await mcpAppel('/mcp', 'jeton-invente', 'tools/list');
  assert.equal(faux.statut, 401, 'un jeton invalide n’est pas servi comme anonyme');
  const pub = await mcpAppel('/mcp', null, 'tools/list');
  assert.equal(pub.statut, 200);
  assert.deepEqual(pub.json.result.tools.map((t) => t.name), ['lignes']);
  assert.deepEqual(pub.json.result.tools[0].securitySchemes, [{ type: 'noauth' }]);
  const appel = await mcpAppel('/mcp', null, 'tools/call', { name: 'mes_trajets', arguments: {} });
  assert.equal(appel.json.result.isError, true);
  assert.match(appel.json.result.content[0].text, /\/mcp\/compte/);
});

test('l’accord : sans session on passe par Atlas, et l’écran nomme où partent les réponses', async () => {
  const reg = await api(null, 'POST', '/oauth/register', { client_name: 'ChatGPT <b>', redirect_uris: [CHATGPT] });
  const q = new URLSearchParams({ client_id: reg.json.client_id, redirect_uri: CHATGPT, response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  const r1 = await fetch(`${B.base}/api/oauth/authorize?${q}`, { redirect: 'manual' });
  const accord = r1.headers.get('location');
  const anonyme = await fetch(B.base + accord, { redirect: 'manual' });
  assert.equal(anonyme.status, 302);
  assert.equal(anonyme.headers.get('location'), `/api/auth/connexion?retour=${encodeURIComponent(accord)}`);
  // Après la connexion, on revient exactement sur l'écran d'accord.
  const { res, cookie } = await connexion(1, anonyme.headers.get('location'));
  assert.equal(res.headers.get('location'), accord);
  const page = await fetch(B.base + accord, { headers: { Cookie: cookie } });
  const html = await page.text();
  assert.match(html, /chatgpt\.com/);
  assert.match(html, /Plagnito/);
  assert.ok(html.includes('ChatGPT &lt;b&gt;') && !html.includes('ChatGPT <b>'), 'le nom déclaré par le client est échappé');
  assert.doesNotMatch(html, /name="amis" value="1" checked/, 'la case « amis » est décochée par défaut');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /form-action/, 'sinon Chrome bloque le retour chez l’assistant');

  // Sans le cookie (envoi depuis un autre site), l'accord n'est pas donné.
  const demande = accord.split('=')[1];
  const pirate = await fetch(`${B.base}/oauth/accord`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ demande, choix: 'oui' }) });
  assert.equal(pirate.status, 401);
  const refus = await fetch(`${B.base}/oauth/accord`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ demande, choix: 'non' }) });
  assert.equal(refus.status, 303);
  assert.equal(new URL(refus.headers.get('location')).searchParams.get('error'), 'access_denied');

  // Client inconnu ou adresse de retour non déclarée : l'erreur s'affiche ICI.
  const inconnu = await fetch(`${B.base}/api/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), client_id: 'tl_inconnu' })}`, { redirect: 'manual' });
  assert.equal(inconnu.status, 400);
  const ailleurs = await fetch(`${B.base}/api/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: 'https://pirate.example/cb' })}`, { redirect: 'manual' });
  assert.equal(ailleurs.status, 400, 'jamais de redirection vers une adresse non déclarée');
  assert.equal(ailleurs.headers.get('location'), null);
});

test('un assistant autorisé : ses outils, ses limites, et le retrait', async () => {
  const cookie = await session(1);
  const { clientId, jetons } = await autoriserAssistant(cookie);
  assert.equal(jetons.scope, 'tisseo');
  const init = await mcpAppel('/mcp/compte', jetons.access_token, 'initialize', { protocolVersion: '2025-06-18' });
  assert.match(init.json.result.instructions, /Compte connecté/);
  const noms = (await mcpAppel('/mcp/compte', jetons.access_token, 'tools/list')).json.result.tools.map((t) => t.name);
  assert.ok(noms.includes('lignes') && noms.includes('mes_trajets') && noms.includes('planifier_trajet'));
  assert.ok(!noms.includes('mes_amis') && !noms.includes('partager_trajet'), 'sans la case « amis », ces outils n’existent pas pour lui');
  const interdit = await outil(jetons.access_token, 'mes_amis');
  assert.equal(interdit.erreur, true);
  assert.match(interdit.texte, /« amis »/);

  const e = await outil(jetons.access_token, 'enregistrer_trajet', { depart: 'esquirol', arrivee: 'compans', nom: 'Fac' });
  assert.equal(e.erreur, false, e.texte);
  assert.equal(e.donnees.trajet.depart.nom, 'Esquirol');
  assert.ok((await api(cookie, 'GET', '/api/compte/trajets')).json.trajets.some((t) => t.nom === 'Fac'), 'ce que l’assistant écrit se voit dans la page');
  const faute = await outil(jetons.access_token, 'enregistrer_trajet', { depart: 'esquirol', arrivee: 'nulle part' });
  assert.equal(faute.erreur, true);
  assert.match(faute.texte, /Lieu introuvable/);

  B.calculs.length = 0;
  const c = await outil(jetons.access_token, 'calculer_mon_trajet', { trajet: 'fac', arriver_avant: '09:00' });
  assert.equal(c.donnees.arriver_a, '08:21');
  assert.equal(B.calculs[0].arriver_avant, '09:00');
  const flou = await outil(jetons.access_token, 'calculer_mon_trajet', { trajet: 'inexistant' });
  assert.match(flou.texte, /Aucun trajet ne correspond/);

  const p = await outil(jetons.access_token, 'planifier_trajet', { depart: 'Esquirol', arrivee: 'Compans', heure: '08:15', jours: 'semaine', mode: 'arriver' });
  assert.equal(p.erreur, false, p.texte);
  assert.deepEqual(p.donnees.trajet_planifie.jours, ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi']);
  assert.match(p.donnees.trajet_planifie.quand, /arriver avant 08:15, chaque lundi/);
  const m = await outil(jetons.access_token, 'modifier_trajet_planifie', { trajet: p.donnees.trajet_planifie.id, heure: '08:30' });
  assert.equal(m.donnees.trajet_planifie.heure, '08:30');
  const deux = await outil(jetons.access_token, 'planifier_trajet', { depart: 'Esquirol', arrivee: 'Compans', heure: '08:15', jours: 'lundi', date: '2026-10-07' });
  assert.match(deux.texte, /soit « date », soit « jours »/);
  assert.equal((await outil(jetons.access_token, 'supprimer_trajet_planifie', { trajet: p.donnees.trajet_planifie.id })).donnees.supprime, true);

  // Un jeton d'assistant n'ouvre PAS les routes du compte, et inversement.
  assert.equal((await api(`Bearer ${jetons.access_token}`, 'GET', '/api/compte/assistants')).statut, 401);
  assert.equal((await mcpAppel('/mcp/compte', cookie.split('=')[1], 'tools/list')).statut, 401, 'le jeton de session n’est pas un jeton d’assistant');

  const liste = await api(cookie, 'GET', '/api/compte/assistants');
  assert.equal(liste.json.assistants.filter((a) => a.id === clientId).length, 1);
  assert.deepEqual(liste.json.assistants.find((a) => a.id === clientId).hotes, ['chatgpt.com']);
  assert.equal((await api(cookie, 'DELETE', `/api/compte/assistants/${clientId}`)).statut, 200);
  assert.equal((await mcpAppel('/mcp/compte', jetons.access_token, 'tools/list')).statut, 401, 'retiré : l’assistant est coupé aussitôt');
  const r = await fetch(`${B.base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId, refresh_token: jetons.refresh_token }) });
  assert.equal(r.status, 400, 'et il ne peut pas se rafraîchir');
});

test('un assistant avec « amis » : partages reçus, et la position seulement si l’ami l’a permise', async () => {
  const plagnito = await session(1), bruno = await session(2);
  const { jetons } = await autoriserAssistant(bruno, { amis: true });
  assert.equal(jetons.scope, 'tisseo amis');
  assert.deepEqual((await outil(jetons.access_token, 'mes_amis')).donnees.amis.map((a) => a.pseudo), ['Plagnito']);

  const ferme = await api(plagnito, 'POST', '/api/compte/partages', { type: 'position', amis: ['2'], duree_s: 900 });
  await api(plagnito, 'POST', `/api/compte/partages/${ferme.json.partage.id}/position`, { lat: 43.6045, lon: 1.4442 });
  assert.ok((await api(bruno, 'GET', `/api/compte/partages/${ferme.json.partage.id}`)).json.partage.position, 'Bruno, lui, la voit');
  let vu = (await outil(jetons.access_token, 'partages_recus')).donnees.partages.find((p) => p.id === ferme.json.partage.id);
  assert.equal(vu.position, null);
  assert.match(vu.position_non_transmise, /n’a pas autorisé les assistants/);
  assert.ok(!JSON.stringify(vu).includes('43.6045'), 'aucune coordonnée ne fuit par un autre champ');

  const ouvert = await api(plagnito, 'POST', '/api/compte/partages', { type: 'position', amis: ['2'], duree_s: 900, assistants: true });
  await api(plagnito, 'POST', `/api/compte/partages/${ouvert.json.partage.id}/position`, { lat: 43.6045, lon: 1.4442 });
  vu = (await outil(jetons.access_token, 'partages_recus')).donnees.partages.find((p) => p.id === ouvert.json.partage.id);
  assert.equal(vu.position.lat, 43.6045);
  assert.equal(vu.position.etat, 'récente');

  B.fa.invitations.length = 0;
  const envoi = await outil(jetons.access_token, 'partager_trajet', { amis: ['plagnito'], depart: 'Capitole', arrivee: 'Arènes', message: 'Rendez-vous' });
  assert.equal(envoi.erreur, false, envoi.texte);
  assert.equal(envoi.donnees.prevenus_dans_atlas_contacts, 1);
  assert.equal(B.fa.invitations[0].vers.pseudo, 'Plagnito');
  const inconnu = await outil(jetons.access_token, 'partager_trajet', { amis: ['Kiri'], depart: 'Capitole', arrivee: 'Arènes' });
  assert.equal(inconnu.erreur, true);
  assert.match(inconnu.texte, /n'est pas dans les contacts/);
});

test('supprimer son compte coupe aussi ses assistants', async () => {
  const kiri = await session(3);
  const { jetons } = await autoriserAssistant(kiri);
  await api(kiri, 'POST', '/api/compte/trajets', { de: 'Capitole', a: 'Arènes' });
  assert.equal((await api(kiri, 'DELETE', '/api/compte')).statut, 200);
  assert.equal((await api(kiri, 'GET', '/api/compte')).json.connecte, false);
  assert.equal((await mcpAppel('/mcp/compte', jetons.access_token, 'tools/list')).statut, 401);
  const revenu = await session(3);
  assert.deepEqual((await api(revenu, 'GET', '/api/compte/trajets')).json.trajets, [], 'se reconnecter repart de zéro');
});

test('les jours dits en français', () => {
  assert.deepEqual(lireJours('lundi, mercredi et vendredi'), [1, 3, 5]);
  assert.deepEqual(lireJours('semaine'), [1, 2, 3, 4, 5]);
  assert.deepEqual(lireJours('week-end'), [6, 7]);
  assert.deepEqual(lireJours('tous les jours'), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(lireJours(['mar', 'Jeudis', 7]), [2, 4, 7]);
  assert.equal(lireJours(''), null);
  assert.throws(() => lireJours('lundredi'), /Jour non compris/);
});
