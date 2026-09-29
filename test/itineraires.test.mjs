// Balayage du planificateur : des centaines de trajets, des invariants.
//
// Pourquoi : les deux bugs de routage corrigés ont été trouvés en testant TROIS
// trajets à la main. Un coût d'attente erroné rendait toute correspondance plus
// chère qu'une marche de 300 m, et personne ne l'avait vu pendant des semaines
// parce que personne n'en avait пробé cent. Ce test vérifie des propriétés
// qui doivent être vraies pour tout le réseau, pas quelques cas choisis.
//
// Le tirage est déterministe (PRNG à graine fixe) : un échec se rejoue à
// l'identique.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../lib/router.mjs';
import { haversineM } from '../lib/core.mjs';
import { loadSchedules, routeActiveAt } from '../lib/schedules.mjs';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (n) => JSON.parse(fs.readFileSync(join(racine, 'data', n), 'utf8'));
const stops = lire('stops.json');
const routes = lire('routes.json');
const variants = lire('route_variants.json');
const router = createRouter({ stops, variants, routes });

// Mêmes options que le serveur (server.mjs, `journeyOpts`). Le filtre de
// service vit ici et pas dans le routeur : sans lui, la recherche Suppose que
// TOUTES les lignes roulent, y compris le métro à 3 h du matin.
const idxSchedules = loadSchedules(lire('schedules.json'), {
  routeById: new Map(routes.map((r) => [r.route_id, r])),
  modeOf: (r) => String(r?.type),
});
const enService = (routeId, t) => routeActiveAt(idxSchedules, routeId, t, 20 * 60) !== false;
const OPTS = { inService: enService };

// Mercredi 30 septembre 2026, 10 h 00 heure de Toulouse. Une heure de service,
// pas 3 h du matin : sinon le métro est légitimement écarté et on ne teste
// rien. (Toulouse = UTC+2 en été, d'où la conversion.)
//
// La date doit être DANS la fenêtre du calendrier GTFS (ici du 24/09 au
// 28/10/2026). Hors de cette fenêtre, routeActiveAt renvoie « inconnu » pour
// tout, et comme la vérification est `=== false`, aucune ligne n'est écartée :
// le routeur estimerait qu'un tram circule à 4 h du matin. C'est un
// comportement à part entière, testé plus bas.
const JOUR = 2026; const MOIS = 8; // septembre 2026 (mois 0-indexé)
const MIDI = Math.floor(new Date(JOUR, MOIS, 30, 10, 0, 0).getTime() / 1000);
const NUIT = Math.floor(new Date(JOUR, MOIS, 30, 3, 0, 0).getTime() / 1000);

const HORAIRES = { walkMaxS: 45 * 60, trajetMaxS: 4 * 3600, voisinMaxS: 20 * 60 };

// PRNG déterministe (mulberry32) : mêmes tirages à chaque exécution.
function prng(graine) {
  let a = graine;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Les arrêts réellement desservis : c'est le graphe du routeur.
const desservis = [...new Set(Object.values(variants).flatMap((l) => l.flatMap((v) => v.stops)))]
  .filter((id) => stops[id]?.lat != null);
const routables = desservis.filter((id) => id.startsWith('stop_point:'));

const alea = prng(20260826);
const tirer = (arr) => arr[Math.floor(alea() * arr.length)];

const ERREURS_ATTENDUES = [
  // Îles du réseau : le GTFS de Tisséo ne relie pas tout au tout. 11
  // composantes de moins de 50 arrêts (Lacassagne, Lévignac, Mérenvielle…)
  // ne touchent pas le réseau principal : aucun trajet n'existe, et c'est la
  // bonne réponse. Voir le test « le réseau reste d'un seul tenant ».
  'Aucun itinéraire trouvé',
];

function controlerTrajet(r, depart, arrivee, contexte) {
  const ou = (m) => `${contexte} : ${m}`;
  if (r.error) {
    for (const attendu of ERREURS_ATTENDUES) {
      if (r.error.startsWith(attendu)) return { duree: 0, nbCourses: 0, ile: true };
    }
    assert.fail(ou(`erreur inattendue « ${r.error} »`));
  }
  assert.ok(r.duration_s > 0, ou(`durée nulle (${r.duration_s})`));
  assert.ok(r.duration_s < HORAIRES.trajetMaxS,
    ou(`trajet de ${Math.round(r.duration_s / 60)} min, plus long que le réseau`));
  assert.ok(r.arrive_at >= r.depart_at, ou('arrivée antérieure au départ'));
  assert.ok(Array.isArray(r.legs) && r.legs.length > 0, ou('aucun segment'));

  const courses = r.legs.filter((l) => l.type === 'ride');
  const marches = r.legs.filter((l) => l.type === 'walk');
  assert.equal(r.transfers, Math.max(courses.length - 1, 0),
    ou(`${r.transfers} correspondances annoncées pour ${courses.length} courses`));

  for (const l of marches) {
    assert.ok(l.seconds < HORAIRES.walkMaxS,
      ou(`segment à pied de ${Math.round(l.seconds / 60)} min`));
  }
  for (const l of r.legs) {
    assert.ok(l.type === 'ride' || l.type === 'walk', ou(`type de segment inconnu « ${l.type} »`));
    for (const cle of ['seconds', 'arrive', 'depart']) {
      if (l[cle] != null) assert.ok(Number.isFinite(l[cle]), ou(`${cle} non fini (${l[cle]})`));
    }
  }
  // Continuité : deux segments consécutifs doivent se raccorder.
  for (let i = 1; i < r.legs.length; i++) {
    const a = r.legs[i - 1];
    const b = r.legs[i];
    if (a.to && b.from) {
      assert.equal(a.to, b.from,
        ou(`rupture de continuité entre « ${a.to} » et « ${b.from} »`));
    }
  }
  // Un trajet à pied entre deux points distants n'est pas un itinéraire : c'est
  // ce que le routeur proposait quand aucune ligne ne circule (90 minutes de
  // marche entre deux stations à 7 km, sans avertissement).
  if (courses.length === 0) {
    const d = haversineM(stops[depart].lat, stops[depart].lon, stops[arrivee].lat, stops[arrivee].lon);
    assert.ok(r.duration_s < 30 * 60 || d < 3000,
      ou(`trajet uniquement à pied de ${Math.round(r.duration_s / 60)} min `
        + `sur ${Math.round(d / 1000)} km, sans transports`));
    assert.ok('out_of_service' in r,
      ou('trajet à pied sans signaler qu\'aucune ligne ne circule'));
  }
  // Arrivée au bon endroit.
  assert.equal(r.to.stop_id, arrivee, ou(`arrivé à ${r.to.stop_id} au lieu de ${arrivee}`));
  assert.equal(r.from.stop_id, depart, ou(`départ de ${r.from.stop_id} au lieu de ${depart}`));
  return { duree: r.duration_s, nbCourses: courses.length };
}

test('le balayage du réseau ne trouve aucun trajet incohérent', () => {
  // 120 paires par défaut (~10 s), 800 en approfondi :
  //   BALAYAGE=800 node --test test/itineraires.test.mjs
  const N = Number(process.env.BALAYAGE) || 120;
  const echecs = [];
  const durees = [];
  let enIle = 0;
  for (let i = 0; i < N; i++) {
    const depart = tirer(routables);
    const arrivee = tirer(routables);
    if (depart === arrivee) continue;
    try {
      const r = router.journey({ stop_id: depart }, { stop_id: arrivee }, MIDI, OPTS);
      const { duree, ile } = controlerTrajet(r, depart, arrivee, `${depart} → ${arrivee}`);
      if (ile) { enIle++; continue; }
      durees.push(duree);
    } catch (e) {
      echecs.push(`${depart} → ${arrivee} : ${e.message}`);
    }
  }
  assert.deepEqual(echecs.slice(0, 8), [], `${echecs.length} trajet(s) incohérent(s) sur ${N}`);
  assert.ok(durees.length > N * 0.9,
    `trop de trajets sans résultat : ${durees.length} sur ${N}`);
  const median = durees.sort((a, b) => a - b)[Math.floor(durees.length / 2)];
  console.log(`      ${durees.length} trajets, médiane ${Math.round(median / 60)} min, `
    + `${enIle} sur une île réseau (aucun trajet possible)`);
});

test('le réseau reste d\'un seul tenant', () => {
  // Constat mesuré sur les données Tisséo : le réseau se décompose en 12
  // composantes, dont 11 petites (Lacassagne, Lévignac, Mérenvielle…)
  // représentant 156 arrêts — 4 % du réseau — qu'aucune ligne du GTFS ne
  // relie au reste. Ce n'est pas une régression : on l'inscrit pour qu'un
  // rafraîchissement des données qui aggrave le morcellement se voie, et pour
  // que l'interface puisse l'expliquer au voyageur.
  const liens = new Map();
  const relier = (x, y) => {
    if (!liens.has(x)) liens.set(x, new Set());
    liens.get(x).add(y);
    if (!liens.has(y)) liens.set(y, new Set());
    liens.get(y).add(x);
  };
  for (const list of Object.values(variants)) {
    for (const v of list) {
      for (let i = 1; i < v.stops.length; i++) relier(v.stops[i - 1], v.stops[i]);
    }
  }
  const vus = new Set();
  const tailles = [];
  for (const id of liens.keys()) {
    if (vus.has(id)) continue;
    const file = [id];
    const c = new Set([id]);
    while (file.length) {
      const x = file.pop();
      for (const y of liens.get(x) ?? []) if (!c.has(y)) { c.add(y); file.push(y); }
    }
    for (const x of c) vus.add(x);
    tailles.push(c.size);
  }
  tailles.sort((a, b) => b - a);
  const principale = tailles[0];
  const isoles = tailles.slice(1);
  const total = tailles.reduce((s, t) => s + t, 0);
  console.log(`      ${total} arrêts en ${tailles.length} composante(s) ; `
    + `principale ${principale} ; îlots ${isoles.length} (${isoles.reduce((s, t) => s + t, 0)} arrêts)`);
  assert.ok(principale / total > 0.9,
    `le réseau principal ne couvre que ${Math.round((principale / total) * 100)} % des arrêts`);
  assert.ok(principale > 3000, `composante principale trop petite (${principale})`);
});

test('deux arrêts proches ne donnent pas un trajet absurde', () => {
  // C'est l'invariant qui aurait attrapé le bug du coût d'attente : à moins de
  // 250 m, la marche est plus courte que n'importe quelle correspondance.
  //
  // On cherche les voisins DÉLIBÉRément (le plus proche de chaque arrêt tiré au
  // sort) : tirer deux arrêts au hasard n'a presque aucune chance de donner une
  // paire à moins de 250 m sur 5 700 arrêts.
  const parCle = new Map();
  for (const id of routables) parCle.set(id.toUpperCase(), id);
  const pairs = [];
  for (let i = 0; i < 60 && pairs.length < 40; i++) {
    const a = tirer(routables);
    if (pairs.some((p) => p.a === a || p.b === a)) continue;
    let meilleur = null;
    let meilleure = Infinity;
    for (const b of routables) {
      if (b === a) continue;
      const d = haversineM(stops[a].lat, stops[a].lon, stops[b].lat, stops[b].lon);
      if (d > 250) continue;
      // Un autre quai de la même station compte double dans les tirages :
      // on garde le voisin le plus proche.
      if (d < meilleure) { meilleure = d; meilleur = b; }
    }
    if (meilleur) pairs.push({ a, b: meilleur, d: meilleure });
  }
  assert.ok(pairs.length >= 20, `trop peu de paires proches trouvées (${pairs.length})`);
  const tropLents = [];
  for (const { a, b, d } of pairs) {
    const r = router.journey({ stop_id: a }, { stop_id: b }, MIDI, OPTS);
    if (r.error) continue;
    if (r.duration_s > HORAIRES.voisinMaxS) {
      tropLents.push(`${a} → ${b} (${Math.round(d)} m) = ${Math.round(r.duration_s / 60)} min `
        + `en ${r.legs.filter((l) => l.type === 'ride').map((l) => l.line).join('+')}`);
    }
  }
  assert.deepEqual(tropLents.slice(0, 6), [], `${tropLents.length} trajet(s) trop long(s) entre voisins`);
  console.log(`      ${pairs.length} paires à moins de 250 m vérifiées`);
});

test('un trajet et son retour ont des durées comparables', () => {
  // Un routage fortement asymétrique trahit un sens de ligne mal interprété :
  // 5 min dans un sens, 1 h dans l'autre. Sur 40 paires, on tolère un rapport
  // de 4 entre les deux durées.
  const paires = [];
  for (let i = 0; i < 40; i++) {
    const a = tirer(routables);
    const b = tirer(routables);
    if (a !== b) paires.push([a, b]);
  }
  const asymetries = [];
  for (const [a, b] of paires) {
    const aller = router.journey({ stop_id: a }, { stop_id: b }, MIDI, OPTS);
    const retour = router.journey({ stop_id: b }, { stop_id: a }, MIDI, OPTS);
    if (aller.error || retour.error) continue;
    if (aller.duration_s < 600 || retour.duration_s < 600) continue; // trajets courts : bruit
    const rapport = Math.max(aller.duration_s, retour.duration_s) / Math.min(aller.duration_s, retour.duration_s);
    if (rapport > 4) {
      asymetries.push(`${a}→${b} ${Math.round(aller.duration_s / 60)} min / `
        + `retour ${Math.round(retour.duration_s / 60)} min`);
    }
  }
  assert.deepEqual(asymetries.slice(0, 6), [], `${asymetries.length} aller(s)-retour trop asymétriques`);
});

test('la nuit, le métro n\'est proposé que si on le signale', () => {
  // 3 h du matin : le métro ne roule pas. Le routeur peut malgré tout
  // proposer un trajet qui l'emprunte — c'est volontaire, pour ne pas
  // répondre « rien de prévu » à quelqu'un qui veut quand même un trajet —
  // mais ALORS il doit nommer la ligne dans `out_of_service`, sinon
  // l'interface affiche un itinéraire de métro à 3 h du matin comme s'il était
  // normal. C'est exactement ce qui se passait : le champ était un booléen
  // alors que le client attendait une liste, et l'avertissement disparaissait.
  const metrosNonSignales = [];
  const metrosSignales = [];
  for (let i = 0; i < 60; i++) {
    const a = tirer(routables);
    const b = tirer(routables);
    if (a === b) continue;
    const r = router.journey({ stop_id: a }, { stop_id: b }, NUIT, OPTS);
    if (r.error) continue;
    const metros = r.legs.filter((l) => l.type === 'ride' && /^[AB]$/.test(l.line ?? ''));
    if (!metros.length) continue;
    const nommes = (r.out_of_service || []).map((x) => x.line);
    if (metros.every((x) => nommes.includes(x.line))) metrosSignales.push(metros[0].line);
    else metrosNonSignales.push(`${a}→${b} : ${metros.map((m) => m.line).join('+')} `
      + `non listé dans ${JSON.stringify(r.out_of_service)}`);
  }
  assert.deepEqual(metrosNonSignales.slice(0, 5), [],
    `${metrosNonSignales.length} trajet(s) en métro non signalés comme hors service`);
  console.log(`      ${metrosSignales.length} trajet(s) en métro la nuit, tous signalés`);
});
