// Comptes : la logique pure (lib/account.mjs, lib/store.mjs, lib/oauth.mjs).
// Tout se joue en mémoire, avec une horloge qu'on avance à la main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import {
  createAccounts, nettoyerLieu, requeteLieu, nettoyerPlan, prochaineOccurrence,
  epochParis, partiesParis, dateParis, heureParis, empreinte, Refus, LIMITES,
} from '../lib/account.mjs';
import { createOAuth, ErreurOAuth, documentsDecouverte } from '../lib/oauth.mjs';
import { pkce } from '../lib/atlas.mjs';

function banc(t0 = epochParis(2026, 10, 5, 7, 0)) { // lundi 5 octobre 2026, 07:00
  const horloge = { t: t0 };
  const store = createStore({ dir: null });
  const accounts = createAccounts({ store, now: () => horloge.t });
  return { horloge, store, accounts };
}
const refuse = (fn, motif) => assert.throws(fn, (e) => e instanceof Refus && (!motif || motif.test(e.message)));

// --- heure de Paris ---------------------------------------------------------
test('heure de Paris : aller-retour, été comme hiver', () => {
  for (const [y, mo, d, h, mi] of [[2026, 1, 15, 8, 15], [2026, 7, 14, 23, 59], [2026, 10, 25, 12, 0], [2026, 3, 29, 12, 0], [2027, 12, 31, 0, 0]]) {
    const p = partiesParis(epochParis(y, mo, d, h, mi));
    assert.deepEqual([p.y, p.mo, p.d, p.h, p.mi], [y, mo, d, h, mi]);
  }
  // Été : UTC+2 ; hiver : UTC+1. Si le fuseau était celui de la machine, ce
  // test ne passerait que sur un poste réglé à Paris.
  assert.equal(epochParis(2026, 7, 14, 12, 0), Date.UTC(2026, 6, 14, 10, 0) / 1000);
  assert.equal(epochParis(2026, 1, 15, 12, 0), Date.UTC(2026, 0, 15, 11, 0) / 1000);
  assert.equal(partiesParis(epochParis(2026, 10, 5, 8, 0)).js, 1, 'le 5 octobre 2026 est un lundi');
  assert.equal(partiesParis(epochParis(2026, 10, 11, 8, 0)).js, 7, 'le 11 est un dimanche');
  assert.equal(dateParis(epochParis(2026, 10, 5, 0, 5)), '2026-10-05');
  assert.equal(heureParis(epochParis(2026, 10, 5, 0, 5)), '00:05');
});

// --- lieux --------------------------------------------------------------------
test('un lieu garde son texte, et ce qu’on sait de précis', () => {
  assert.deepEqual(nettoyerLieu('  Capitole  '), { texte: 'Capitole' });
  assert.deepEqual(nettoyerLieu({ texte: 'Chez moi', lat: 43.6, lon: 1.44 }), { lat: 43.6, lon: 1.44, texte: 'Chez moi' });
  assert.deepEqual(nettoyerLieu({ lat: 43.6, lon: 1.44 }), { lat: 43.6, lon: 1.44, texte: '43.60000,1.44000' });
  assert.equal(nettoyerLieu({ texte: 'X', stop_id: 'stop_point:SP_12' }).stop_id, 'stop_point:SP_12');
  assert.equal(nettoyerLieu({ texte: 'X', stop_id: '<script>' }).stop_id, undefined, 'un identifiant fantaisiste est écarté');
  assert.equal(nettoyerLieu(''), null);
  assert.equal(nettoyerLieu({ lat: 999, lon: 1 }), null, 'des coordonnées impossibles ne font pas un lieu');
  assert.equal(nettoyerLieu({ texte: '\u0000\u0007' }), null, 'un texte de caractères de contrôle est vide');
  assert.equal(nettoyerLieu({ texte: 'x'.repeat(500) }).texte.length, LIMITES.lieu);
});

test('la requête d’un lieu retombe sur ce qui existe encore', () => {
  const l = { texte: 'Capitole', stop_id: 'stop_point:SP_1', lat: 43.6, lon: 1.44 };
  assert.equal(requeteLieu(l, () => true), 'stop_point:SP_1');
  // Tisséo a republié son réseau, l'arrêt a changé d'identifiant : on ne
  // renvoie pas un identifiant mort au calculateur.
  assert.equal(requeteLieu(l, () => false), '43.6,1.44');
  assert.equal(requeteLieu({ texte: 'Capitole', stop_id: 'stop_point:SP_1' }, () => false), 'Capitole');
});

// --- trajets planifiés ----------------------------------------------------------
test('un trajet planifié est soit daté, soit répété', () => {
  const base = { de: 'Capitole', a: 'Jean Jaurès', heure: '8:05' };
  const date = nettoyerPlan({ ...base, date: '2026-10-07' });
  assert.equal(date.heure, '08:05');
  assert.equal(date.date, '2026-10-07');
  assert.equal(date.jours, null);
  assert.equal(date.mode, 'partir');
  const rep = nettoyerPlan({ ...base, jours: [5, 1, 1, 3], mode: 'arriver', rappel_min: 10 });
  assert.deepEqual(rep.jours, [1, 3, 5]);
  assert.equal(rep.date, null);
  assert.equal(rep.mode, 'arriver');
  assert.equal(rep.rappel_min, 10);
  refuse(() => nettoyerPlan(base), /date|jours/i);
  refuse(() => nettoyerPlan({ ...base, date: '2026-02-31' }), /n’existe pas/);
  refuse(() => nettoyerPlan({ ...base, heure: '25:00', date: '2026-10-07' }), /HH:MM/);
  refuse(() => nettoyerPlan({ ...base, jours: [0, 8] }), /Jours/);
  refuse(() => nettoyerPlan({ de: 'Capitole', heure: '08:00', date: '2026-10-07' }), /départ et une arrivée/);
  refuse(() => nettoyerPlan({ ...base, date: '2026-10-07', rappel_min: 999 }), /Rappel/);
});

test('prochaine occurrence : datée, répétée, et la tolérance du quart d’heure', () => {
  const lundi7h = epochParis(2026, 10, 5, 7, 0);
  const date = nettoyerPlan({ de: 'A', a: 'B', heure: '08:15', date: '2026-10-05' });
  assert.deepEqual(prochaineOccurrence(date, lundi7h), { quand: epochParis(2026, 10, 5, 8, 15), passe: false });
  assert.equal(prochaineOccurrence(date, epochParis(2026, 10, 5, 8, 20)).passe, false, 'à 08:20, le trajet de 08:15 n’est pas encore « passé »');
  assert.equal(prochaineOccurrence(date, epochParis(2026, 10, 5, 9, 0)).passe, true);

  const semaine = nettoyerPlan({ de: 'A', a: 'B', heure: '08:15', jours: [1, 2, 3, 4, 5] });
  assert.equal(prochaineOccurrence(semaine, lundi7h).quand, epochParis(2026, 10, 5, 8, 15), 'ce matin');
  assert.equal(prochaineOccurrence(semaine, epochParis(2026, 10, 5, 9, 0)).quand, epochParis(2026, 10, 6, 8, 15), 'demain');
  assert.equal(prochaineOccurrence(semaine, epochParis(2026, 10, 9, 9, 0)).quand, epochParis(2026, 10, 12, 8, 15), 'vendredi 9 h → lundi');
  const dimanche = nettoyerPlan({ de: 'A', a: 'B', heure: '10:00', jours: [7] });
  assert.equal(prochaineOccurrence(dimanche, lundi7h).quand, epochParis(2026, 10, 11, 10, 0));
  // Le changement d'heure du 25 octobre ne décale pas 08:15.
  const apres = prochaineOccurrence(semaine, epochParis(2026, 10, 23, 9, 0)).quand;
  assert.equal(heureParis(apres), '08:15');
  assert.equal(dateParis(apres), '2026-10-26');
});

// --- sessions -------------------------------------------------------------------
test('une session : le jeton ouvre, son empreinte seule est gardée', () => {
  const { accounts, store, horloge } = banc();
  accounts.ouvrirCompte({ id: 42, pseudo: 'Plagnito' });
  const jeton = accounts.ouvrirSession(42);
  assert.deepEqual(accounts.session(jeton), { uid: '42', pseudo: 'Plagnito', genre: 'web' });
  const garde = JSON.stringify(store.collection('sessions').lire());
  assert.ok(!garde.includes(jeton), 'le jeton en clair n’est écrit nulle part');
  assert.ok(garde.includes(empreinte(jeton)));
  assert.equal(accounts.session('n-importe-quoi'), null);
  assert.equal(accounts.session(null), null);
  horloge.t += LIMITES.sessionJours * 86400 + 1;
  assert.equal(accounts.session(jeton), null, 'expirée');
});

test('une session active ne meurt pas : elle glisse', () => {
  const { accounts, horloge } = banc();
  accounts.ouvrirCompte({ id: 1, pseudo: 'A' });
  const jeton = accounts.ouvrirSession(1, { genre: 'android' });
  for (let i = 0; i < 4; i++) { horloge.t += 30 * 86400; assert.equal(accounts.session(jeton)?.genre, 'android'); }
  assert.equal(accounts.fermerSession(jeton), true);
  assert.equal(accounts.session(jeton), null);
});

test('un compte Atlas mal formé est refusé', () => {
  const { accounts } = banc();
  refuse(() => accounts.ouvrirCompte({ id: '../etc', pseudo: 'x' }), /Compte Atlas/);
});

// --- trajets enregistrés ----------------------------------------------------------
test('trajets enregistrés : pas de doublon, les plus utilisés d’abord', () => {
  const { accounts, horloge } = banc();
  accounts.ouvrirCompte({ id: 1, pseudo: 'A' });
  const maison = accounts.enregistrerTrajet(1, { nom: 'Maison → Travail', de: 'Capitole', a: 'Jean Jaurès' });
  const gare = accounts.enregistrerTrajet(1, { de: 'Capitole', a: 'Matabiau' });
  assert.equal(gare.nom, 'Capitole → Matabiau', 'nom par défaut');
  const encore = accounts.enregistrerTrajet(1, { de: 'capitole', a: 'JEAN JAURÈS' });
  assert.equal(encore.deja, true);
  assert.equal(encore.id, maison.id);
  assert.equal(accounts.listerTrajets(1).length, 2);
  horloge.t += 60;
  accounts.utiliserTrajet(1, gare.id);
  accounts.utiliserTrajet(1, gare.id);
  accounts.utiliserTrajet(1, maison.id);
  assert.deepEqual(accounts.listerTrajets(1).map((t) => t.nom), ['Capitole → Matabiau', 'Maison → Travail']);
  assert.equal(accounts.modifierTrajet(1, maison.id, { nom: 'Boulot' }).nom, 'Boulot');
  accounts.supprimerTrajet(1, maison.id);
  assert.equal(accounts.listerTrajets(1).length, 1);
  refuse(() => accounts.supprimerTrajet(1, maison.id), /introuvable/);
  refuse(() => accounts.enregistrerTrajet(1, { de: 'Capitole' }), /départ et une arrivée/);
});

test('les trajets d’un compte ne se voient pas d’un autre', () => {
  const { accounts } = banc();
  accounts.ouvrirCompte({ id: 1, pseudo: 'A' });
  accounts.ouvrirCompte({ id: 2, pseudo: 'B' });
  const t = accounts.enregistrerTrajet(1, { de: 'Capitole', a: 'Matabiau' });
  assert.deepEqual(accounts.listerTrajets(2), []);
  refuse(() => accounts.trajet(2, t.id), /introuvable/);
  refuse(() => accounts.supprimerTrajet(2, t.id), /introuvable/);
  refuse(() => accounts.modifierTrajet(2, t.id, { nom: 'volé' }), /introuvable/);
});

test('la limite de trajets est annoncée, pas dépassée', () => {
  const { accounts } = banc();
  accounts.ouvrirCompte({ id: 1, pseudo: 'A' });
  for (let i = 0; i < LIMITES.trajets; i++) accounts.enregistrerTrajet(1, { de: `A${i}`, a: `B${i}` });
  assert.throws(() => accounts.enregistrerTrajet(1, { de: 'Z', a: 'Y' }), (e) => e instanceof Refus && e.code === 'LIMITE' && e.statut === 409);
});

// --- trajets planifiés (compte) ------------------------------------------------------
test('trajets planifiés : le prochain d’abord, les passés à la fin', () => {
  const { accounts, horloge } = banc();
  accounts.ouvrirCompte({ id: 1, pseudo: 'A' });
  const passe = accounts.planifier(1, { de: 'A', a: 'B', heure: '06:00', date: '2026-10-05' });
  const midi = accounts.planifier(1, { de: 'A', a: 'B', heure: '12:00', date: '2026-10-05', nom: 'Déjeuner' });
  const travail = accounts.planifier(1, { de: 'A', a: 'B', heure: '08:15', jours: [1, 2, 3, 4, 5], nom: 'Travail' });
  assert.equal(passe.passe, true);
  assert.deepEqual(accounts.listerPlans(1).map((p) => p.nom), ['Travail', 'Déjeuner', 'A → B']);
  // Passer d'un trajet répété à un trajet daté efface les jours, et inversement.
  const m = accounts.modifierPlan(1, travail.id, { date: '2026-10-06' });
  assert.equal(m.jours, null);
  assert.equal(m.date, '2026-10-06');
  const r = accounts.modifierPlan(1, travail.id, { jours: [6, 7], heure: '10:30' });
  assert.equal(r.date, null);
  assert.deepEqual(r.jours, [6, 7]);
  assert.equal(r.prochaine, epochParis(2026, 10, 10, 10, 30));
  refuse(() => accounts.modifierPlan(1, midi.id, { heure: 'midi' }), /HH:MM/);
  assert.equal(accounts.plan(1, midi.id).heure, '12:00', 'une modification refusée ne change rien');
  horloge.t = epochParis(2026, 10, 5, 13, 0);
  assert.equal(accounts.plan(1, midi.id).passe, true);
  accounts.supprimerPlan(1, midi.id);
  refuse(() => accounts.plan(1, midi.id), /introuvable/);
});

// --- partages ------------------------------------------------------------------------
function trois() {
  const b = banc();
  for (const [id, pseudo] of [[1, 'Plagnito'], [2, 'Bruno'], [3, 'Kiri']]) b.accounts.ouvrirCompte({ id, pseudo });
  return b;
}

test('partager un trajet : l’ami le reçoit, un tiers ne le voit pas', () => {
  const { accounts } = trois();
  const p = accounts.partager(1, { type: 'trajet', vers: [{ id: 2, pseudo: 'Bruno' }, { id: 1, pseudo: 'moi' }, { id: 2, pseudo: 'Bruno' }], trajet: { nom: 'Concert', de: 'Capitole', a: 'Zénith' }, message: 'On y va ensemble ?' });
  assert.deepEqual(p.vers, [{ id: '2', pseudo: 'Bruno' }], 'ni soi-même, ni deux fois le même');
  assert.equal(accounts.partagesDe(2).recus[0].trajet.a.texte, 'Zénith');
  assert.equal(accounts.partagesDe(2).recus[0].vers, undefined, 'un destinataire ne lit pas la liste des autres');
  assert.deepEqual(accounts.partagesDe(3), { envoyes: [], recus: [] });
  refuse(() => accounts.partage(3, p.id), /introuvable/);
  refuse(() => accounts.retirerPartage(3, p.id), /introuvable/);
  refuse(() => accounts.partager(1, { type: 'trajet', vers: [], trajet: { de: 'A', a: 'B' } }), /au moins un ami/);
  refuse(() => accounts.partager(1, { type: 'trajet', vers: [{ id: 2 }] }), /Aucun trajet|départ/);
});

test('un trajet planifié se partage avec son horaire', () => {
  const { accounts } = trois();
  const p = accounts.partager(1, { type: 'trajet', vers: [{ id: 2 }], trajet: { de: 'A', a: 'B', heure: '08:15', jours: [1, 2], mode: 'arriver' } });
  assert.deepEqual([p.trajet.heure, p.trajet.jours, p.trajet.mode], ['08:15', [1, 2], 'arriver']);
  // Une heure sans date ni jours n'est pas un horaire : le trajet part sans.
  const q = accounts.partager(1, { type: 'trajet', vers: [{ id: 2 }], trajet: { de: 'A', a: 'B', heure: '08:15' } });
  assert.equal(q.trajet.heure, undefined);
});

test('position : en mémoire seulement, bornée, et une seule à la fois', () => {
  const { accounts, store, horloge } = trois();
  refuse(() => accounts.partager(1, { type: 'position', vers: [{ id: 2 }], duree_s: 30 }), /Durée/);
  refuse(() => accounts.partager(1, { type: 'position', vers: [{ id: 2 }], duree_s: 99 * 3600 }), /Durée/);
  const p = accounts.partager(1, { type: 'position', vers: [{ id: 2, pseudo: 'Bruno' }], duree_s: 900 });
  assert.equal(accounts.partage(2, p.id).position, null);
  assert.match(accounts.partage(2, p.id).position_attente, /Aucune position/);
  accounts.majPosition(1, p.id, { lat: 43.604512345, lon: 1.444234567, precision_m: 12.4 });
  assert.deepEqual(accounts.partage(2, p.id).position, { lat: 43.60451, lon: 1.44423, precision_m: 12, age_s: 0, fraiche: true });
  assert.ok(!JSON.stringify(store.collection('partages').lire()).includes('43.60451'), 'la position n’est pas écrite dans le stockage');
  refuse(() => accounts.majPosition(2, p.id, { lat: 1, lon: 1 }), /terminé/);
  refuse(() => accounts.majPosition(1, p.id, { lat: 'x', lon: 1 }), /illisible/);
  horloge.t += 300;
  assert.equal(accounts.partage(2, p.id).position.fraiche, false, 'cinq minutes après, elle est dite ancienne');
  assert.equal(accounts.partage(2, p.id).position.age_s, 300);
  // Un second partage de position remplace le premier.
  const q = accounts.partager(1, { type: 'position', vers: [{ id: 3 }], duree_s: 900 });
  refuse(() => accounts.partage(2, p.id), /introuvable/);
  assert.equal(accounts.partagesDe(1).envoyes.filter((x) => x.type === 'position').length, 1);
  horloge.t += 901;
  refuse(() => accounts.partage(3, q.id), /introuvable/);
  refuse(() => accounts.majPosition(1, q.id, { lat: 43.6, lon: 1.44 }), /terminé/);
  assert.equal(accounts._positions.size, 0, 'la position meurt avec le partage');
});

test('un assistant ne lit la position d’un ami que si cet ami l’a permis', () => {
  const { accounts } = trois();
  const ferme = accounts.partager(1, { type: 'position', vers: [{ id: 2 }], duree_s: 900 });
  accounts.majPosition(1, ferme.id, { lat: 43.6, lon: 1.44 });
  assert.ok(accounts.partage(2, ferme.id).position, 'l’ami la voit');
  const vue = accounts.partage(2, ferme.id, 'assistant');
  assert.equal(vue.position, null);
  assert.match(vue.position_reservee, /n’a pas autorisé/);
  const ouvert = accounts.partager(1, { type: 'position', vers: [{ id: 2 }], duree_s: 900, assistants: true });
  accounts.majPosition(1, ouvert.id, { lat: 43.6, lon: 1.44 });
  assert.ok(accounts.partage(2, ouvert.id, 'assistant').position);
  // L'auteur, lui, voit toujours la sienne, même par un assistant.
  assert.ok(accounts.partage(1, ouvert.id, 'assistant').position);
});

test('arrêter, se retirer, supprimer son compte', () => {
  const { accounts } = trois();
  const p = accounts.partager(1, { type: 'trajet', vers: [{ id: 2 }, { id: 3 }], trajet: { de: 'A', a: 'B' } });
  assert.deepEqual(accounts.retirerPartage(2, p.id), { retire: true });
  assert.equal(accounts.partagesDe(2).recus.length, 0);
  assert.equal(accounts.partagesDe(3).recus.length, 1, 'l’autre destinataire le garde');
  assert.deepEqual(accounts.retirerPartage(1, p.id), { arrete: true });
  assert.equal(accounts.partagesDe(3).recus.length, 0);

  accounts.enregistrerTrajet(1, { de: 'A', a: 'B' });
  accounts.planifier(1, { de: 'A', a: 'B', heure: '08:00', jours: [1] });
  const jeton = accounts.ouvrirSession(1);
  accounts.partager(1, { type: 'trajet', vers: [{ id: 2 }], trajet: { de: 'A', a: 'B' } });
  accounts.partager(2, { type: 'trajet', vers: [{ id: 1 }], trajet: { de: 'C', a: 'D' } });
  accounts.supprimerCompte(1);
  assert.equal(accounts.compte(1), null);
  assert.equal(accounts.session(jeton), null);
  assert.deepEqual(accounts.listerTrajets(1), []);
  assert.equal(accounts.partagesDe(2).recus.length, 0, 'ses partages disparaissent avec lui');
  assert.equal(accounts.partagesDe(2).envoyes.length, 0, 'un partage dont il était le seul destinataire aussi');
});

// --- stockage ---------------------------------------------------------------------------
test('stockage : écrit par renommage, relu au redémarrage, sans fichier temporaire oublié', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tisseo-compte-'));
  try {
    const a = createAccounts({ store: createStore({ dir }), now: () => 1000 });
    a.ouvrirCompte({ id: 7, pseudo: 'Plagnito' });
    a.enregistrerTrajet(7, { de: 'Capitole', a: 'Matabiau' });
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
    const b = createAccounts({ store: createStore({ dir }), now: () => 2000 });
    assert.equal(b.compte(7).pseudo, 'Plagnito');
    assert.equal(b.listerTrajets(7)[0].a.texte, 'Matabiau');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stockage : un fichier illisible est mis de côté, pas écrasé', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tisseo-compte-'));
  try {
    writeFileSync(join(dir, 'trajets.json'), '{"1":[{"id":"t_abc","nom":"préc');
    const journal = [];
    const a = createAccounts({ store: createStore({ dir, log: (m) => journal.push(m) }), now: () => 1000 });
    assert.deepEqual(a.listerTrajets(1), []);
    assert.equal(journal.length, 1);
    const copie = readdirSync(dir).find((f) => f.startsWith('trajets.json.illisible-'));
    assert.ok(copie, 'la copie existe');
    assert.match(readFileSync(join(dir, copie), 'utf8'), /préc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stockage : un nom de collection ne sort pas du dossier', () => {
  assert.throws(() => createStore({ dir: null }).collection('../ailleurs'), /invalide/);
});

// --- OAuth des assistants -------------------------------------------------------------------
function bancOAuth() {
  const horloge = { t: 1_800_000_000 };
  const oauth = createOAuth({ store: createStore({ dir: null }), now: () => horloge.t });
  return { horloge, oauth };
}
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const erreur = (fn, code) => assert.throws(fn, (e) => e instanceof ErreurOAuth && e.error === code);

function autoriser(oauth, { amis = false, scope = 'tisseo amis' } = {}) {
  const c = oauth.enregistrerClient({ client_name: 'ChatGPT', redirect_uris: [CHATGPT] });
  const { verifier, challenge } = pkce();
  const id = oauth.ouvrirDemande({ client_id: c.client_id, redirect_uri: CHATGPT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope, state: 'xyz' });
  const retour = new URL(oauth.conclure(id, 42, { accord: true, amis }));
  return { c, verifier, code: retour.searchParams.get('code'), retour };
}

test('OAuth : un client ne peut revenir que chez un assistant connu', () => {
  const { oauth } = bancOAuth();
  erreur(() => oauth.enregistrerClient({ redirect_uris: ['https://pirate.example/cb'] }), 'invalid_redirect_uri');
  erreur(() => oauth.enregistrerClient({ redirect_uris: ['http://chatgpt.com/cb'] }), 'invalid_redirect_uri');
  erreur(() => oauth.enregistrerClient({ redirect_uris: ['https://user:pw@chatgpt.com/cb'] }), 'invalid_redirect_uri');
  erreur(() => oauth.enregistrerClient({ redirect_uris: [] }), 'invalid_redirect_uri');
  erreur(() => oauth.enregistrerClient({ redirect_uris: [CHATGPT], token_endpoint_auth_method: 'client_secret_post' }), 'invalid_client_metadata');
  const c = oauth.enregistrerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:33418/cb'] });
  assert.equal(c.token_endpoint_auth_method, 'none');
  assert.deepEqual(oauth.client(c.client_id).hotes, ['claude.ai', 'localhost']);
});

test('OAuth : la demande exige PKCE S256 et l’adresse déclarée', () => {
  const { oauth } = bancOAuth();
  const c = oauth.enregistrerClient({ redirect_uris: [CHATGPT] });
  const base = { client_id: c.client_id, redirect_uri: CHATGPT, response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256' };
  erreur(() => oauth.ouvrirDemande({ ...base, client_id: 'inconnu' }), 'invalid_client');
  erreur(() => oauth.ouvrirDemande({ ...base, redirect_uri: 'https://chatgpt.com/autre' }), 'invalid_request');
  for (const mauvais of [{ code_challenge: '' }, { code_challenge_method: 'plain' }, { response_type: 'token' }]) {
    assert.throws(() => oauth.ouvrirDemande({ ...base, ...mauvais }), (e) => e instanceof ErreurOAuth && e.versClient === true, JSON.stringify(mauvais));
  }
  const id = oauth.ouvrirDemande(base);
  assert.deepEqual(oauth.demande(id).portees, ['tisseo']);
  assert.deepEqual(oauth.demande(id).client.hotes, ['chatgpt.com']);
});

test('OAuth : code → jetons, une seule fois, avec le bon vérificateur', () => {
  const { oauth } = bancOAuth();
  const { c, verifier, code, retour } = autoriser(oauth);
  assert.equal(retour.searchParams.get('state'), 'xyz');
  assert.equal(retour.origin + retour.pathname, CHATGPT);
  erreur(() => oauth.echanger({ grant_type: 'authorization_code', client_id: c.client_id, code, redirect_uri: CHATGPT, code_verifier: 'faux' }), 'invalid_grant');
  // Le code a été brûlé par la tentative ratée : même avec le bon vérificateur, il ne sert plus.
  erreur(() => oauth.echanger({ grant_type: 'authorization_code', client_id: c.client_id, code, redirect_uri: CHATGPT, code_verifier: verifier }), 'invalid_grant');

  const b = autoriser(oauth);
  const j = oauth.echanger({ grant_type: 'authorization_code', client_id: b.c.client_id, code: b.code, redirect_uri: CHATGPT, code_verifier: b.verifier });
  assert.equal(j.token_type, 'Bearer');
  assert.equal(j.scope, 'tisseo');
  assert.deepEqual(oauth.verifier(j.access_token).portees, ['tisseo']);
  assert.equal(oauth.verifier(j.access_token).uid, '42');
  assert.equal(oauth.verifier(j.refresh_token), null, 'un jeton de rafraîchissement n’ouvre rien');
  erreur(() => oauth.echanger({ grant_type: 'authorization_code', client_id: b.c.client_id, code: b.code, redirect_uri: CHATGPT, code_verifier: b.verifier }), 'invalid_grant');
});

test('OAuth : « amis » ne s’obtient que par la case, quoi que demande le client', () => {
  const { oauth } = bancOAuth();
  const sans = autoriser(oauth, { amis: false, scope: 'tisseo amis' });
  const j1 = oauth.echanger({ grant_type: 'authorization_code', client_id: sans.c.client_id, code: sans.code, redirect_uri: CHATGPT, code_verifier: sans.verifier });
  assert.deepEqual(oauth.verifier(j1.access_token).portees, ['tisseo']);
  const avec = autoriser(oauth, { amis: true, scope: '' });
  const j2 = oauth.echanger({ grant_type: 'authorization_code', client_id: avec.c.client_id, code: avec.code, redirect_uri: CHATGPT, code_verifier: avec.verifier });
  assert.deepEqual(oauth.verifier(j2.access_token).portees, ['tisseo', 'amis']);
});

test('OAuth : refus, expiration, rafraîchissement tournant, retrait', () => {
  const { oauth, horloge } = bancOAuth();
  const c = oauth.enregistrerClient({ redirect_uris: [CHATGPT] });
  const d = { client_id: c.client_id, redirect_uri: CHATGPT, response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256', state: 's' };
  const non = new URL(oauth.conclure(oauth.ouvrirDemande(d), 42, { accord: false }));
  assert.equal(non.searchParams.get('error'), 'access_denied');
  assert.equal(non.searchParams.get('code'), null);
  const vieille = oauth.ouvrirDemande(d);
  horloge.t += 11 * 60;
  assert.equal(oauth.demande(vieille), null);
  erreur(() => oauth.conclure(vieille, 42, { accord: true }), 'invalid_request');

  const a = autoriser(oauth, { amis: true });
  const j = oauth.echanger({ grant_type: 'authorization_code', client_id: a.c.client_id, code: a.code, redirect_uri: CHATGPT, code_verifier: a.verifier });
  horloge.t += 3601;
  assert.equal(oauth.verifier(j.access_token), null, 'le jeton d’accès vit une heure');
  const r = oauth.echanger({ grant_type: 'refresh_token', client_id: a.c.client_id, refresh_token: j.refresh_token });
  assert.deepEqual(oauth.verifier(r.access_token).portees, ['tisseo', 'amis'], 'les portées suivent');
  erreur(() => oauth.echanger({ grant_type: 'refresh_token', client_id: a.c.client_id, refresh_token: j.refresh_token }), 'invalid_grant');
  erreur(() => oauth.echanger({ grant_type: 'password', client_id: a.c.client_id }), 'unsupported_grant_type');

  assert.equal(oauth.autorisations(42).length, 1);
  assert.deepEqual(oauth.autorisations(42)[0].hotes, ['chatgpt.com']);
  assert.deepEqual(oauth.autorisations(7), []);
  assert.equal(oauth.revoquer(7, a.c.client_id), 0, 'on ne retire pas l’assistant d’un autre');
  assert.ok(oauth.revoquer(42, a.c.client_id) >= 2);
  assert.equal(oauth.verifier(r.access_token), null);
  erreur(() => oauth.echanger({ grant_type: 'refresh_token', client_id: a.c.client_id, refresh_token: r.refresh_token }), 'invalid_grant');
});

test('OAuth : les jetons ne sont gardés qu’en empreinte', () => {
  const horloge = { t: 1_800_000_000 };
  const store = createStore({ dir: null });
  const oauth = createOAuth({ store, now: () => horloge.t });
  const a = autoriser(oauth);
  const j = oauth.echanger({ grant_type: 'authorization_code', client_id: a.c.client_id, code: a.code, redirect_uri: CHATGPT, code_verifier: a.verifier });
  const garde = JSON.stringify(store.collection('oauth').lire());
  assert.ok(!garde.includes(j.access_token) && !garde.includes(j.refresh_token));
  assert.equal(oauth.revoquerJeton(j.refresh_token), true);
  assert.equal(oauth.verifier(j.access_token), null, 'retirer un jeton retire la paire');
});

test('découverte : la ressource nomme son serveur d’autorisation', () => {
  const d = documentsDecouverte('https://tisseo.plagnito.com', 'https://tisseo.plagnito.com/mcp/compte');
  assert.equal(d.ressource.resource, 'https://tisseo.plagnito.com/mcp/compte');
  assert.deepEqual(d.ressource.authorization_servers, ['https://tisseo.plagnito.com']);
  assert.equal(d.serveur.registration_endpoint, 'https://tisseo.plagnito.com/oauth/register');
  assert.deepEqual(d.serveur.code_challenge_methods_supported, ['S256']);
});
