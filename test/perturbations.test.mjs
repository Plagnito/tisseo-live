// Perturbations lues comme des contraintes : arrêts non desservis, tronçons
// coupés, périodes. Les textes sont ceux de Tisséo (relevés le 02/10/2026, voir
// test/fixtures/alertes-2026-10-02.json) ; le réseau est fabriqué pour le test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDisruptions, parsePeriod, htmlSections, parisEpoch, normName, NO_DISRUPTION } from '../lib/perturbations.mjs';
import { createRouter } from '../lib/router.mjs';

const ALERTES = JSON.parse(readFileSync(new URL('./fixtures/alertes-2026-10-02.json', import.meta.url), 'utf8'));
const NOW = parisEpoch(2026, 10, 2, 18, 30); // vendredi 2 octobre 2026, 18 h 30

// Réseau fabriqué : chaque ligne a des sens, chaque sens ses arrêts (un quai
// par arrêt et par sens, comme dans les données de Tisséo).
function reseau(lignes) {
  const routes = [], stops = {}, variants = {};
  for (const [id, nom, type, sens] of lignes) {
    routes.push({ route_id: id, short_name: nom, long_name: nom, color: '888888', text_color: 'ffffff', type });
    // Un arrêt est au même endroit dans les deux sens (ses deux quais se font
    // face), à 900 m du suivant : trop loin pour s'y rendre à pied d'un arrêt à l'autre.
    const rang = (n) => sens[0][1].indexOf(n);
    const lat = (n, d) => 43.6 + rang(n) * 0.008 + d * 0.0001, lon = 1.44 + routes.length * 0.05;
    variants[id] = sens.map(([headsign, noms], d) => ({
      dir: String(d), headsign,
      stops: noms.map((n, k) => { const sid = `${nom}:${d}:${k}`; stops[sid] = { n, lat: lat(n, d), lon }; return sid; }),
      shape: noms.map((n) => [lat(n, d), lon]),
    }));
  }
  return { routes, stops, variants, routeById: new Map(routes.map((r) => [r.route_id, r])) };
}
const T1 = ['MEETT', 'Aéroconstellation', 'Purpan', 'Cartoucherie', 'Zénith', 'Hippodrome', 'Arènes', 'Déodat de Séverac', 'Croix de Pierre', 'Avenue Muret Marcel Cavaillé', 'Fer à Cheval', 'Ile du Ramier', 'Palais de Justice'];
const L9 = ['St-Orens Ctre Cial', 'Malepère', 'Route de Revel', 'François Verdier', 'Saint-Georges', 'Jean Jaurès', 'Jeanne d\'Arc', 'Place Roquelaine', 'Pont Matabiau', 'Matabiau - Raynal', 'L\'Union Grande Halle'];
const NET = reseau([
  ['line:68', 'T1', 0, [['Palais de Justice', T1], ['MEETT', [...T1].reverse()]]],
  ['line:174', 'L9', 3, [['L\'Union Grande Halle', L9], ['St-Orens Ctre Cial', [...L9].reverse()]]],
  ['line:32', '59', 3, [['Lespinasse', ['La Vache', 'Fenouillet Ctre Cial', 'Sers', 'Tournelle', 'Clos', 'Lespinasse']], ['La Vache', ['Lespinasse', 'Clos', 'Tournelle', 'Sers', 'Fenouillet Ctre Cial', 'La Vache']]]],
  ['line:142', '13', 3, [['Oncopole Courrière', ['St Cyprien - République', 'Teinturiers', 'Landes', 'Oncopole Courrière']], ['Saint Cyprien République', ['Oncopole Courrière', 'Landes', 'Teinturiers', 'St Cyprien - République']]]],
  ['line:161', '313', 3, [['Muret Gare SNCF', ['Le Fauga Cimetière', 'Mairie Lavernose', 'Graves', 'Route de Toulouse', 'Terrefort', 'Muret Gare SNCF']], ['Le Fauga Cimetière', ['Muret Gare SNCF', 'Terrefort', 'Route de Toulouse', 'Graves', 'Mairie Lavernose', 'Le Fauga Cimetière']]]],
  ['line:269', 'L12', 3, [['Piste', ['Auriol', 'Montaudran Gare', 'Piste']]]],
  ['line:217', '321', 3, [['Stade', ['Petit Barry', 'Lilas', 'Stade']]]],
  ['line:18', '41', 3, [['Chaussas', ['Borderouge', 'Chaussas']]]],
  ['line:61', 'A', 1, [['Balma-Gramont', ['Basso Cambo', 'Jean Jaurès', 'Balma-Gramont']]]],
]);
const dis = parseDisruptions(ALERTES, { ...NET, now: NOW });
const de = (ligne, motif) => dis.closures.filter((c) => c.line === ligne && (!motif || motif.test(c.title)));
const quai = (ligne, sens, nom) => NET.variants[NET.routes.find((r) => r.short_name === ligne).route_id][sens].stops.find((id) => NET.stops[id].n === nom);
const heure = (y, mo, d, h, mi = 0) => parisEpoch(y, mo, d, h, mi);

test('une alerte se découpe en sujets, un par titre', () => {
  const l9 = ALERTES.find((a) => a.title.startsWith('L9 :'));
  const sujets = htmlSections(l9.description);
  assert.ok(sujets.length >= 4);
  assert.match(sujets[0].title, /Déviation ligne L9/);
  assert.ok(sujets.some((s) => /Matabiau - Raynal/.test(s.title)));
  assert.deepEqual(htmlSections(''), []);
  assert.equal(htmlSections('<p>sans titre</p>').length, 1);
});

test('les périodes écrites par Tisséo sont lues, heures comprises', () => {
  const p = (s) => parsePeriod(s, NOW)?.periods;
  // Un jour de service va de 4 h à 4 h : le dernier métro du samedi soir est encore « samedi ».
  assert.deepEqual(p('Du lundi 7 septembre au dimanche 4 octobre 2026, l\'itinéraire est modifié'), [[heure(2026, 9, 7, 4), heure(2026, 10, 5, 4)]]);
  assert.deepEqual(p('Du jeudi 1<sup>er</sup> au samedi 3 octobre 2026 : déviation'), [[heure(2026, 10, 1, 4), heure(2026, 10, 4, 4)]]);
  assert.deepEqual(p('Du mercredi 7 octobre à 23h30 au dimanche 11 octobre 2026 : déviation'), [[heure(2026, 10, 7, 23, 30), heure(2026, 10, 12, 4)]]);
  assert.deepEqual(p('Du dimanche 27 septembre à 17h00 au lundi 5 octobre 2026 à 16h30'), [[heure(2026, 9, 27, 17), heure(2026, 10, 5, 16, 30)]]);
  assert.deepEqual(p('modification d\'itinéraire du 07/09 au 04/10/2026'), [[heure(2026, 9, 7, 4), heure(2026, 10, 5, 4)]]);
  assert.deepEqual(p('Déviation ligne L12 du 07 au 11/10/2026'), [[heure(2026, 10, 7, 4), heure(2026, 10, 12, 4)]]);
  assert.deepEqual(p('Le vendredi 2 octobre 2026 dès 05h00 : la ligne est interrompue'), [[heure(2026, 10, 2, 5), heure(2026, 10, 3, 4)]]);
  assert.deepEqual(p('Le samedi 3 octobre à partir de 13h30 : déviation'), [[heure(2026, 10, 3, 13, 30), heure(2026, 10, 4, 4)]]);
  assert.deepEqual(p('Le lundi 5 octobre 2026 jusqu\'à 14h00 : déviation'), [[heure(2026, 10, 5, 4), heure(2026, 10, 5, 14)]]);
  assert.deepEqual(p('Le mardi 6 octobre 2026, de 9h00 à 16h00 : déviation'), [[heure(2026, 10, 6, 9), heure(2026, 10, 6, 16)]]);
  assert.deepEqual(p('Samedi 3 et lundi 5 octobre 2026, de 17h30 à 21h00 : déviation'), [[heure(2026, 10, 3, 17, 30), heure(2026, 10, 3, 21)], [heure(2026, 10, 5, 17, 30), heure(2026, 10, 5, 21)]]);
  assert.deepEqual(p('Jusqu\'au vendredi 30 avril 2027, le terminus n\'est pas desservi'), [[null, heure(2027, 5, 1, 4)]]);
  assert.deepEqual(p('Déplacement d\'arrêt jusqu\'au 02/11/2026'), [[null, heure(2026, 11, 3, 4)]]);
  assert.deepEqual(p('A compter du lundi 21 septembre, le départ est avancé'), [[heure(2026, 9, 21, 4), null]]);
  assert.deepEqual(p('Arrêt partiel tram - le 02/10'), [[heure(2026, 10, 2, 4), heure(2026, 10, 3, 4)]]);
  // Une année absente est celle qui place la date au plus près de maintenant.
  assert.deepEqual(p('Du lundi 28 décembre au dimanche 3 janvier'), [[heure(2026, 12, 28, 4), heure(2027, 1, 4, 4)]]);
  assert.equal(parsePeriod('Du lundi 28 septembre au vendredi 6 novembre 2026, sauf week-ends et jours fériés', NOW).weekdaysOnly, true);
  assert.equal(parsePeriod('Déviation momentanée ligne 13', NOW), null, 'aucune date : rien n\'est inventé');
});

test('tram coupé : les stations fermées ne sont ni desservies ni traversées, pendant la période annoncée', () => {
  const [c] = de('T1');
  assert.equal(c.kind, 'coupure');
  assert.deepEqual(c.periods, [[heure(2026, 10, 2, 5), heure(2026, 10, 3, 4)]]);
  assert.equal(c.names.length, 10);
  assert.equal(c.unknown.length, 0);
  assert.equal(c.stopIds.size, 20, 'les dix stations, dans les deux sens');
  const vue = dis.at(NOW);
  assert.ok(vue.stopClosed('line:68', quai('T1', 1, 'Palais de Justice')));
  assert.ok(vue.cut('line:68', quai('T1', 0, 'Cartoucherie')), 'on ne traverse pas un tronçon coupé');
  assert.equal(vue.stopClosed('line:68', quai('T1', 0, 'Purpan')), null, 'Purpan reste desservi (le tram roule de Purpan au MEETT)');
  assert.equal(dis.at(heure(2026, 10, 3, 10)).stopClosed('line:68', quai('T1', 1, 'Palais de Justice')), null, 'le lendemain, la coupure est finie');
  assert.equal(dis.at(heure(2026, 10, 2, 4, 30)).stopClosed('line:68', quai('T1', 1, 'Palais de Justice')), null, 'avant 5 h, elle n\'a pas commencé');
});

test('déviation datée dans le FUTUR : appliquée à l\'heure du trajet, pas avant', () => {
  const [c] = de('L9', /Déviation ligne L9/);
  assert.equal(c.kind, 'arret', 'le bus contourne : les arrêts sont fermés, la ligne continue');
  assert.deepEqual(c.periods, [[heure(2026, 10, 3, 13, 30), heure(2026, 10, 4, 4)]]);
  const jj0 = quai('L9', 0, 'Jean Jaurès'), jj1 = quai('L9', 1, 'Jean Jaurès');
  assert.equal(dis.closedAt('line:174', jj0, NOW), null, 'vendredi soir : desservi');
  assert.equal(dis.closedAt('line:174', jj0, heure(2026, 10, 3, 12)), null, 'samedi midi : desservi');
  assert.ok(dis.closedAt('line:174', jj0, heure(2026, 10, 3, 14)), 'samedi 14 h : fermé');
  assert.ok(dis.closedAt('line:174', jj1, heure(2026, 10, 3, 14)), 'dans les deux sens');
  assert.equal(dis.at(heure(2026, 10, 3, 14)).cut('line:174', jj0), null, 'mais pas coupé : le bus passe ailleurs et continue');
  // « St-Georges » de l'alerte = « Saint-Georges » des horaires.
  assert.ok(c.stopIds.has(quai('L9', 0, 'Saint-Georges')));
  assert.equal(normName('St-Georges'), normName('Saint Georges'));
  // « François Verdier ( Direction L'Union Grande Halle ) » : ce sens seulement.
  assert.ok(c.stopIds.has(quai('L9', 0, 'François Verdier')));
  assert.ok(!c.stopIds.has(quai('L9', 1, 'François Verdier')), 'l\'autre sens reste desservi');
});

test('arrêt seul, nommé dans le titre ou la phrase, dans le sens cité pour NOTRE ligne', () => {
  const [c] = de('L9', /Matabiau - Raynal/);
  assert.deepEqual(c.names, ['Matabiau - Raynal']);
  // « L9 direction Saint-Orens Centre Commercial » ↔ sens « St-Orens Ctre Cial ».
  assert.deepEqual([...c.stopIds], [quai('L9', 1, 'Matabiau - Raynal')]);
  assert.deepEqual(c.periods, [[heure(2026, 7, 16, 4), heure(2027, 1, 1, 4)]]);
  const [landes] = de('13', /Landes/);
  assert.deepEqual([...landes.stopIds], [quai('13', 1, 'Landes')], 'direction Saint Cyprien République');
});

test('ligne suspendue : tous ses arrêts sont fermés ce jour-là', () => {
  const [c] = de('13', /suspendue/);
  assert.equal(c.kind, 'ligne');
  const vue = dis.at(NOW);
  assert.ok(vue.suspended('line:142'));
  assert.ok(vue.stopClosed('line:142', quai('13', 0, 'Teinturiers')));
  assert.equal(dis.at(heure(2026, 10, 3, 10)).suspended('line:142'), null);
});

test('ce qui n\'est pas une fermeture n\'en devient pas une', () => {
  assert.equal(de('A').length, 0, '« Reprise métro » : rien de fermé');
  assert.equal(de('41').length, 0, 'départs supprimés : pas un arrêt fermé');
  assert.equal(de('L9', /Déplacement d'arrêt/).length, 0, 'un arrêt déplacé reste desservi');
  // Ligne 313 : la liste qui suit « L'arrêt Mairie Lavernose est déplacé : » donne
  // des ADRESSES, pas des arrêts fermés.
  const [c] = de('313');
  assert.deepEqual(c.names, ['Graves', 'Route de Toulouse', 'Terrefort']);
  assert.ok(!c.unknown.some((n) => /allée de Plaisance|rue de la Fusion/.test(n)));
  assert.equal(c.stopIds.size, 3, 'direction Muret Gare SNCF seulement');
  // Alertes sans ligne (fermeture d'agence, fête au MEETT) : ignorées.
  assert.ok(dis.closures.every((x) => x.route_id));
});

test('perturbation sans date : valable maintenant, pas dans deux jours', () => {
  const sans = parseDisruptions([{ id: 'x', title: '13 : Déviation', routes: ['line:142'], description: '<h1>🟠 Déviation momentanée ligne 13</h1><p>Déviation momentanée ligne 13<br />❌ <strong>Arrêts non desservis</strong><br /><em>Direction Oncopole Courrière</em> : <ul><li>Teinturiers</li></ul></p>' }], { ...NET, now: NOW });
  const [c] = sans.closures;
  assert.equal(c.periods, null);
  assert.deepEqual([...c.stopIds], [quai('13', 0, 'Teinturiers')]);
  assert.ok(sans.closedAt('line:142', quai('13', 0, 'Teinturiers'), NOW + 3600));
  assert.equal(sans.closedAt('line:142', quai('13', 0, 'Teinturiers'), NOW + 48 * 3600), null);
  assert.match(sans.describe(c).periode, /non datée/);
});

test('« sauf week-ends » : la fermeture ne vaut pas le samedi', () => {
  const d = parseDisruptions([{ id: 'y', title: '13', routes: ['line:142'], description: '<h1>Déviation ligne 13</h1><p><strong>Du lundi 28 septembre au vendredi 6 novembre 2026, sauf week-ends et jours fériés</strong>, la ligne 13 est déviée :<br />❌ <strong>Arrêts non desservis</strong> : <ul><li>Landes</li></ul></p>' }], { ...NET, now: NOW });
  const landes = quai('13', 0, 'Landes');
  assert.ok(d.closedAt('line:142', landes, heure(2026, 10, 2, 10)), 'vendredi');
  assert.equal(d.closedAt('line:142', landes, heure(2026, 10, 3, 10)), null, 'samedi');
});

test('un nom d\'arrêt introuvable sur la ligne est gardé à part, jamais deviné', () => {
  const d = parseDisruptions([{ id: 'z', title: '59', routes: ['line:32'], description: '<h1>Ligne 59</h1><p>Le vendredi 2 octobre 2026 : ❌ <strong>Arrêts non desservis</strong> : <ul><li>Sers</li><li>Arrêt Qui N\'Existe Pas</li></ul></p>' }], { ...NET, now: NOW });
  assert.deepEqual(d.closures[0].names, ['Sers']);
  assert.deepEqual(d.closures[0].unknown, ['Arrêt Qui N\'Existe Pas']);
  assert.deepEqual(d.describe(d.closures[0]).arrets_cites_non_reconnus, ['Arrêt Qui N\'Existe Pas']);
});

test('sans alerte, ou avec des alertes illisibles : aucune contrainte, aucune erreur', () => {
  assert.equal(parseDisruptions([], NET).closures.length, 0);
  assert.equal(parseDisruptions(null, NET).closures.length, 0);
  assert.equal(parseDisruptions([{ id: 'a', title: 'x', description: null, routes: ['line:68'] }, { id: 'b', routes: ['inconnue'], description: '<h1>x</h1>non desservi' }], NET).closures.length, 0);
  assert.equal(NO_DISRUPTION.stopClosed('a', 'b'), null);
});

// --- le routeur respecte les fermetures ------------------------------------------------
const router = createRouter(NET);
const ids = (ligne, sens, ...noms) => noms.map((n) => quai(ligne, sens, n));
const lignesDe = (j) => (j.legs ?? []).filter((l) => l.type === 'ride').map((l) => `${l.line}:${l.from}→${l.to}`);

test('itinéraire : on ne monte pas à un arrêt fermé, on ne traverse pas un tronçon coupé', () => {
  const [pj, purpan, meett] = ids('T1', 1, 'Palais de Justice', 'Purpan', 'MEETT');
  const libre = router.journey({ stop_id: pj }, { stop_id: purpan }, NOW, {});
  assert.deepEqual(lignesDe(libre), ['T1:Palais de Justice→Purpan'], 'sans perturbation : le tram, direct');
  const coupe = router.journey({ stop_id: pj }, { stop_id: purpan }, NOW, { blocked: dis.at(NOW) });
  assert.ok(!lignesDe(coupe).some((x) => x.startsWith('T1')), `pendant la coupure, aucun T1 entre Palais de Justice et Purpan (${lignesDe(coupe).join(', ') || coupe.error || 'à pied'})`);
  // De Purpan au MEETT, le tram roule : il reste proposé.
  const nord = router.journey({ stop_id: purpan }, { stop_id: meett }, NOW, { blocked: dis.at(NOW) });
  assert.deepEqual(lignesDe(nord), ['T1:Purpan→MEETT']);
  // Et l'on ne peut pas « traverser » le tronçon coupé en restant à bord.
  const [meett0, pj0] = ids('T1', 0, 'MEETT', 'Palais de Justice');
  const traverse = router.journey({ stop_id: meett0 }, { stop_id: pj0 }, NOW, { blocked: dis.at(NOW) });
  assert.ok(!lignesDe(traverse).some((x) => /→Palais de Justice$/.test(x)), 'pas de descente à Palais de Justice');
});

test('itinéraire : une déviation ferme des arrêts, mais le bus continue au-delà', () => {
  const samedi14 = heure(2026, 10, 3, 14);
  const [revel, jj, union] = ids('L9', 0, 'Route de Revel', 'Jean Jaurès', 'L\'Union Grande Halle');
  const avant = router.journey({ stop_id: jj }, { stop_id: union }, heure(2026, 10, 3, 12), { blocked: dis.at(heure(2026, 10, 3, 12)) });
  assert.deepEqual(lignesDe(avant), ['L9:Jean Jaurès→L\'Union Grande Halle'], 'samedi midi : L9 depuis Jean Jaurès');
  const pendant = router.journey({ stop_id: jj }, { stop_id: union }, samedi14, { blocked: dis.at(samedi14) });
  assert.ok(!lignesDe(pendant).some((x) => x.startsWith('L9:Jean Jaurès')), `samedi 14 h : on ne monte plus dans L9 à Jean Jaurès (${lignesDe(pendant).join(', ') || 'à pied'})`);
  // D'un arrêt ouvert avant la déviation à un arrêt ouvert après : le trajet reste possible.
  const autour = router.journey({ stop_id: revel }, { stop_id: union }, samedi14, { blocked: dis.at(samedi14) });
  assert.deepEqual(lignesDe(autour), ['L9:Route de Revel→L\'Union Grande Halle']);
});

test('isochrone : un arrêt fermé n\'est plus atteignable par la ligne qui le saute', () => {
  const [vache] = ids('59', 0, 'La Vache');
  const sers = quai('59', 0, 'Sers');
  const libre = router.reach(vache, 3600, null, null);
  assert.deepEqual(libre.get(sers)?.routes, ['line:32']);
  const ferme = router.reach(vache, 3600, null, dis.at(NOW));
  assert.ok(!ferme.get(sers)?.routes?.includes('line:32') || ferme.get(sers).routes.length > 1 || !ferme.has(sers), 'Sers n\'est plus atteint en descendant du 59');
});
