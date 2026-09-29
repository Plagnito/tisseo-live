// Tests du connecteur MCP : protocole, outils (avec un réseau factice),
// heures de Paris, résolution des lieux, homonymes, lignes hors service.
// Aucun réseau requis : `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMcpServer, checkArgs, ToolError } from '../lib/mcp.mjs';
import { createTools, parseHeure, parisToEpoch, heure } from '../lib/tools.mjs';
import { createRouter } from '../lib/router.mjs';
import { routeActiveAt, ymd } from '../lib/schedules.mjs';

// --- protocole -------------------------------------------------------------

const echo = {
  name: 'echo',
  description: 'renvoie son argument',
  inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 5 }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['n'], additionalProperties: false },
  handler: async ({ n }) => {
    if (n === 4) throw new ToolError('quatre refusé');
    if (n === 5) throw new Error('boum');
    return { n };
  },
};
const server = createMcpServer({ name: 't', title: 'T', version: '0', instructions: 'i', tools: [echo] });

test('mcp : initialize négocie la version et annonce les outils', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.ok(r.result.capabilities.tools);
  const r2 = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(r2.result.protocolVersion, '2025-06-18', 'version inconnue → la plus récente');
});

test('mcp : une notification ne reçoit pas de réponse', async () => {
  assert.equal(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('mcp : tools/list marque les outils en lecture seule', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(r.result.tools[0].name, 'echo');
  assert.equal(r.result.tools[0].annotations.readOnlyHint, true);
});

test('mcp : appel réussi → structuredContent + texte JSON', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { n: 2 } } });
  assert.deepEqual(r.result.structuredContent, { n: 2 });
  assert.deepEqual(JSON.parse(r.result.content[0].text), { n: 2 });
});

test('mcp : arguments invalides → erreur d\'outil lisible, pas de plantage', async () => {
  const r = await server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { n: 9, mode: 'z', x: 1 } } });
  assert.equal(r.result.isError, true);
  const msg = r.result.content[0].text;
  assert.match(msg, /≤ 5/);
  assert.match(msg, /"a" \| "b"/);
  assert.match(msg, /inconnu « x »/);
});

test('mcp : ToolError passe tel quel, une autre erreur est emballée', async () => {
  const a = await server.handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo', arguments: { n: 4 } } });
  assert.equal(a.result.content[0].text, 'quatre refusé');
  const orig = console.error; console.error = () => {};
  const b = await server.handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { n: 5 } } });
  console.error = orig;
  assert.equal(b.result.isError, true);
  assert.match(b.result.content[0].text, /boum/);
});

test('mcp : outil ou méthode inconnus → erreurs JSON-RPC', async () => {
  const a = await server.handleMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(a.error.code, -32602);
  const b = await server.handleMessage({ jsonrpc: '2.0', id: 9, method: 'sampling/x' });
  assert.equal(b.error.code, -32601);
  const c = await server.handleMessage({ id: 10, method: 'ping' });
  assert.equal(c.error.code, -32600);
});

test('checkArgs : requis vide et types', () => {
  const s = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] };
  assert.deepEqual(checkArgs(s, { a: 'x', b: 2 }), []);
  assert.equal(checkArgs(s, { a: '' }).length, 1);
  assert.equal(checkArgs(s, { a: 'x', b: '2' }).length, 1);
});

// --- heures de Paris ----------------------------------------------------------

test('parisToEpoch : heure d\'été et heure d\'hiver', () => {
  // 29/09/2026 08:15 Paris = 06:15 UTC (UTC+2)
  assert.equal(parisToEpoch(2026, 9, 29, 8, 15), Date.UTC(2026, 8, 29, 6, 15) / 1000);
  // 15/01/2027 08:15 Paris = 07:15 UTC (UTC+1)
  assert.equal(parisToEpoch(2027, 1, 15, 8, 15), Date.UTC(2027, 0, 15, 7, 15) / 1000);
  assert.equal(heure(parisToEpoch(2026, 10, 25, 3, 30)), '03:30', 'jour du passage à l\'heure d\'hiver');
});

test('parseHeure : formats, et une heure passée désigne demain', () => {
  const now = parisToEpoch(2026, 9, 28, 21, 0);
  assert.equal(parseHeure(undefined, now), now);
  assert.equal(parseHeure('21:30', now), parisToEpoch(2026, 9, 28, 21, 30));
  assert.equal(parseHeure('20h30', now), parisToEpoch(2026, 9, 28, 20, 30), 'moins d\'une heure avant : aujourd\'hui');
  assert.equal(parseHeure('8h15', now), parisToEpoch(2026, 9, 29, 8, 15), 'le matin, vu du soir : demain');
  assert.equal(parseHeure('2026-10-01T07:05', now), parisToEpoch(2026, 10, 1, 7, 5));
  assert.throws(() => parseHeure('25:00', now), ToolError);
  assert.throws(() => parseHeure('demain matin', now), ToolError);
});

// --- outils sur un réseau factice -----------------------------------------------

// Deux arrêts « Jean Jaurès » : un au centre sur 3 lignes, un en banlieue sur 1.
const routes = [
  { route_id: 'r:A', short_name: 'A', long_name: 'Basso Cambo / Balma', type: '1', color: 'f00', text_color: 'fff' },
  { route_id: 'r:L1', short_name: 'L1', long_name: 'Sept Deniers / Gonin', type: '3', color: '0f0', text_color: 'fff' },
  { route_id: 'r:14', short_name: '14', long_name: 'Marengo / Basso Cambo', type: '3', color: '00f', text_color: 'fff' },
  { route_id: 'r:58', short_name: '58', long_name: 'Muret / Seysses', type: '3', color: '999', text_color: 'fff' },
];
const stops = {
  'stop_point:JJ1': { n: 'Jean Jaurès', lat: 43.6060, lon: 1.4487 },
  'stop_point:JJ2': { n: 'Jean Jaurès', lat: 43.6062, lon: 1.4490 },
  'stop_point:JJM': { n: 'Jean Jaurès', lat: 43.5063, lon: 1.3234 },
  'stop_point:AER': { n: 'Aéroport', lat: 43.6309, lon: 1.3745 },
  'stop_point:CAP': { n: 'Capitole', lat: 43.6045, lon: 1.4455 },
};
const variants = {
  'r:A': [{ dir: '0', headsign: 'Balma', stops: ['stop_point:CAP', 'stop_point:JJ1'] }],
  'r:L1': [{ dir: '0', headsign: 'Gonin', stops: ['stop_point:JJ2', 'stop_point:CAP'] }],
  'r:14': [{ dir: '0', headsign: 'Basso Cambo', stops: ['stop_point:JJ2', 'stop_point:AER'] }],
  'r:58': [{ dir: '0', headsign: 'Seysses', stops: ['stop_point:JJM'] }],
};
const routeById = new Map(routes.map((r) => [r.route_id, r]));
const modeOf = (r) => ({ 1: 'Métro', 3: 'Bus' })[r?.type] ?? 'Bus';
const plainName = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function fakeSvc(extra = {}) {
  const calls = { geocode: [], journey: [] };
  const svc = {
    routes, stops, variants, routeById, modeOf,
    now: () => parisToEpoch(2026, 9, 28, 18, 0),
    // Recherche naïve : un id par nom, pris au hasard — comme la vraie, qui
    // ne départage pas les homonymes.
    searchStops: (q) => {
      const key = plainName(q);
      const seen = new Set();
      return Object.entries(stops)
        .filter(([, s]) => key.split(' ').every((t) => plainName(s.n).includes(t)))
        .reverse()
        .filter(([, s]) => (seen.has(s.n) ? false : seen.add(s.n)))
        .map(([id, s]) => ({ id, name: s.n, lat: s.lat, lon: s.lon, kind: 'point', served: true }));
    },
    nearestStopPoints: (lat, lon, n) => Object.entries(stops)
      .map(([id, s]) => ({ id, name: s.n, dist_m: Math.round(Math.hypot((s.lat - lat) * 111_000, (s.lon - lon) * 80_000)) }))
      .sort((a, b) => a.dist_m - b.dist_m).slice(0, n),
    geocode: async (q) => {
      calls.geocode.push(q);
      if (/toulouse/i.test(q)) return [{ label: '12 Rue d\'Alsace Lorraine 31000 Toulouse', type: 'address', lat: 43.6022, lon: 1.4458 }];
      return [{ label: '12 Rue Alsace Lorraine 81500 Lavaur', type: 'address', lat: 43.6989, lon: 1.8190 }];
    },
    journey: async (from, to, at) => { calls.journey.push({ from, to, at }); return { error: 'arrêt du test' }; },
    live: async () => ({ snap: { vehicles: [], alerts: [], perRoute: {}, rt_timestamp: 0 } }),
    liveOrNull: async () => null,
    departuresAt: () => [],
    track: () => [],
    ...extra,
  };
  return { svc, calls };
}
const tool = (tools, name) => tools.find((t) => t.name === name);

test('lieux : une commune dans la requête ne masque pas l\'arrêt', async () => {
  const { svc, calls } = fakeSvc();
  const it = tool(createTools(svc), 'itineraire');
  await assert.rejects(it.handler({ depart: 'Capitole', arrivee: 'aéroport de Blagnac' }), /arrivée comme « Aéroport »/);
  assert.equal(calls.geocode.length, 0, 'un arrêt franc ne consulte pas le géocodeur');
});

test('lieux : une adresse hors du réseau (Lavaur) est écartée au profit de Toulouse', async () => {
  const { svc, calls } = fakeSvc();
  const it = tool(createTools(svc), 'itineraire');
  await assert.rejects(it.handler({ depart: '12 rue Alsace-Lorraine', arrivee: 'Capitole' }), /31000 Toulouse/);
  assert.deepEqual(calls.geocode.sort(), ['12 rue Alsace-Lorraine', '12 rue Alsace-Lorraine Toulouse']);
  assert.deepEqual(calls.journey[0].from, { lat: 43.6022, lon: 1.4458, label: '12 Rue d\'Alsace Lorraine 31000 Toulouse' });
});

test('lieux : entre deux homonymes, le plus desservi gagne et les autres sont signalés', async () => {
  const { svc } = fakeSvc();
  const pp = tool(createTools(svc), 'prochains_passages');
  const r = await pp.handler({ arret: 'Jean Jaurès' });
  assert.ok(['stop_point:JJ1', 'stop_point:JJ2'].includes(r.arret.arret_id), `choisi : ${r.arret.arret_id}`);
  assert.equal(r.interprete_comme.homonymes.length, 1);
  assert.deepEqual(r.interprete_comme.homonymes[0].lignes, ['58']);
});

test('lignes : « métro A », « ligne 14 », « l1 » sont reconnus ; l\'inconnu est expliqué', async () => {
  const { svc } = fakeSvc();
  const ligne = tool(createTools(svc), 'ligne');
  for (const q of ['métro A', 'ligne 14', 'l1']) {
    const r = await ligne.handler({ ligne: q });
    assert.equal(r.lignes.length, 1, q);
  }
  await assert.rejects(ligne.handler({ ligne: 'Z9' }), /Ligne inconnue/);
});

test('itineraire : étapes lisibles, marches fusionnées, direction et attente', async () => {
  const t0 = parisToEpoch(2026, 9, 28, 18, 0);
  const { svc } = fakeSvc({
    journey: async () => ({
      depart_at: t0, arrive_at: t0 + 1500, duration_s: 1500, transfers: 0, real: false,
      legs: [
        { type: 'walk', seconds: 60, from: 'Départ', to: 'Jean Jaurès' },
        { type: 'walk', seconds: 60, from: 'Jean Jaurès', to: 'Jean Jaurès' },
        { type: 'ride', route_id: 'r:14', line: '14', mode: 'Bus', from: 'Jean Jaurès', from_id: 'stop_point:JJ2', to: 'Aéroport', to_id: 'stop_point:AER', depart: t0 + 300, arrive: t0 + 1440, seconds: 1140, real: false, scheduled: true },
        { type: 'walk', seconds: 30, from: 'Aéroport', to: 'Aéroport' },
      ],
    }),
  });
  const r = await tool(createTools(svc), 'itineraire').handler({ depart: '43.60,1.44', arrivee: 'Aéroport' });
  assert.equal(r.etapes.length, 2, JSON.stringify(r.etapes));
  assert.equal(r.etapes[0].type, 'marche');
  assert.equal(r.etapes[0].duree_min, 2);
  assert.equal(r.etapes[1].direction, 'Basso Cambo');
  assert.equal(r.etapes[1].attente_min, 3);
  assert.equal(r.etapes[1].source, 'gtfs');
  assert.equal(r.etapes[1].horaire_theorique, r.etapes[1].depart);
  assert.equal(r.etapes[1].source_arrivee, 'estimation', 'arrivée sans temps réel = estimée');
  assert.equal(r.partir_a, '18:00');
});

// --- lignes hors service ---------------------------------------------------------

test('routeActiveAt : dans l\'amplitude, hors amplitude, date inconnue', () => {
  const day = new Date(2026, 8, 28);
  const idx = {
    patternsByDate: new Map([[ymd(day), [0]]]),
    spans: new Map([['r:X', new Map([[0, [6 * 3600, 21 * 3600]]])]]),
  };
  const at = (h) => Math.floor(day.getTime() / 1000) + h * 3600;
  assert.equal(routeActiveAt(idx, 'r:X', at(12)), true);
  assert.equal(routeActiveAt(idx, 'r:X', at(23)), false);
  assert.equal(routeActiveAt(idx, 'r:X', at(5.8)), true, 'marge avant le premier départ');
  assert.equal(routeActiveAt(idx, 'r:Y', at(12)), null, 'ligne inconnue : on ne sait pas');
  assert.equal(routeActiveAt(idx, 'r:X', at(12) + 30 * 86400), null, 'date hors GTFS : on ne sait pas');
});

test('router : une ligne hors service est écartée, avec repli si plus rien ne roule', () => {
  // Deux lignes parallèles de P à Q : « rapide » (tram) et « lente » (bus).
  const st = { 'stop_point:P': { n: 'P', lat: 43.60, lon: 1.40 }, 'stop_point:Q': { n: 'Q', lat: 43.60, lon: 1.44 } };
  const rt = [
    { route_id: 'rapide', short_name: 'R', type: '0' },
    { route_id: 'lente', short_name: 'S', type: '3' },
  ];
  const shape = [[43.60, 1.40], [43.60, 1.44]];
  const va = {
    rapide: [{ dir: '0', headsign: 'Q', stops: ['stop_point:P', 'stop_point:Q'], shape }],
    lente: [{ dir: '0', headsign: 'Q', stops: ['stop_point:P', 'stop_point:Q'], shape }],
  };
  const router = createRouter({ stops: st, variants: va, routes: rt });
  const lineOf = (r) => r.legs.find((l) => l.type === 'ride').line;
  const from = { stop_id: 'stop_point:P' }, to = { stop_id: 'stop_point:Q' };
  assert.equal(lineOf(router.journey(from, to, 1000)), 'R');
  const sansRapide = router.journey(from, to, 1000, { inService: (id) => id !== 'rapide' });
  assert.equal(lineOf(sansRapide), 'S');
  assert.equal(sansRapide.out_of_service, undefined);
  const nuit = router.journey(from, to, 1000, { inService: () => false });
  // Le repli est signalé par la LISTE des lignes qui ne roulent pas, pas par un
  // booléen : l'interface fait `out_of_service.map((r) => r.line)` pour nommer
  // celles qu'il ne faut pas prendre. Un booléen faisait disparaître
  // l'avertissement en silence.
  assert.ok(Array.isArray(nuit.out_of_service), 'repli signalé par une liste de lignes');
  assert.ok(nuit.out_of_service.some((l) => l.line === 'R' || l.line === 'S'),
    'la ligne empruntée figure dans la liste des lignes hors service');
  for (const l of nuit.out_of_service) assert.ok(l.line, 'chaque ligne est nommée');
  const attente = router.journey(from, to, 1000, { nextDeparture: () => 1600 });
  assert.equal(attente.legs[0].depart, 1600);
  assert.equal(attente.legs[0].scheduled, true);
});

// --- outils ajoutés : jours, grilles, fréquences, tarifs, options ---------------
import { parseJour, fmtSec, frequences } from '../lib/tools.mjs';

test('parseJour : aujourd\'hui, demain, jour de semaine, dates', () => {
  const now = parisToEpoch(2026, 9, 29, 10, 0); // mardi 29 septembre 2026
  assert.equal(parseJour(undefined, now).ymd, '20260929');
  assert.equal(parseJour('demain', now).ymd, '20260930');
  assert.equal(parseJour('samedi', now).ymd, '20261003');
  assert.equal(parseJour('mardi', now).ymd, '20260929', 'le jour même, pas la semaine suivante');
  assert.equal(parseJour('2026-10-12', now).ymd, '20261012');
  assert.equal(parseJour('03/10', now).ymd, '20261003');
  assert.match(parseJour('samedi', now).label, /samedi 3 octobre/);
  assert.throws(() => parseJour('la semaine des quatre jeudis', now), ToolError);
});

test('fmtSec et frequences : après minuit, médiane par tranche', () => {
  assert.equal(fmtSec(5 * 3600 + 29 * 60), '05:29');
  assert.equal(fmtSec(25 * 3600 + 14 * 60), '01:14', 'service après minuit');
  const pointe = Array.from({ length: 13 }, (_, i) => 7 * 3600 + i * 600); // toutes les 10 min de 7 h à 9 h
  const f = frequences([...pointe, 12 * 3600, 12 * 3600 + 1800]);
  assert.equal(f['pointe du matin (7 h – 9 h)'].toutes_les_min, 10);
  assert.equal(f['pointe du matin (7 h – 9 h)'].passages, 12, '9 h 00 appartient à la tranche suivante');
  // 9 h 00, 12 h 00, 12 h 30 : écarts 180 et 30 min → médiane haute = 180.
  assert.equal(f['journée (9 h – 16 h)'].toutes_les_min, 180, 'médiane des écarts, pas moyenne');
  assert.equal(f['soirée (19 h – 22 h)'], undefined, 'tranche vide absente');
});

// Horaires factices : la ligne A passe à Capitole (quais CAP) à 6 h, 6 h 10,
// 6 h 20 les jours du motif 0 ; le motif 1 (dimanche) n'a qu'un passage.
const day = parisToEpoch(2026, 9, 29, 10, 0);
const schedSvc = (extra = {}) => fakeSvc({
  now: () => day,
  scheduleEntries: (id) => (id === 'stop_point:CAP'
    ? [{ route_id: 'r:A', dir: '0', destination: 'Balma', perPat: { 0: [21600, 22200, 22800], 1: [36000] } }]
    : []),
  patternsOn: (ymd) => (ymd === '20261004' ? [1] : [0]),
  fares: {
    fares: [
      { id: '1', price: 2, on_board: true, transfers: 2, duration_s: 3600 },
      { id: '2', price: 1.8, on_board: false, transfers: 2, duration_s: 3600 },
      { id: '3', price: 9, on_board: false, transfers: 2, duration_s: 5400 },
    ],
    routes: { 'r:A': ['1', '2'], 'r:14': ['1', '2', '3'] },
  },
  ...extra,
}).svc;

test('horaires : premier, dernier, grille compacte, autre jour', async () => {
  const h = tool(createTools(schedSvc()), 'horaires');
  const r = await h.handler({ arret: 'Capitole', ligne: 'A' });
  assert.equal(r.lignes.length, 1);
  assert.equal(r.lignes[0].premier, '06:00');
  assert.equal(r.lignes[0].dernier, '06:20');
  assert.equal(r.lignes[0].grille['06'], '00 10 20');
  const dim = await h.handler({ arret: 'Capitole', ligne: 'A', jour: 'dimanche' });
  assert.equal(dim.lignes[0].premier, '10:00');
  const aucun = await h.handler({ arret: 'Capitole', ligne: 'L1' });
  assert.equal(aucun.lignes.length, 0);
  assert.match(aucun.note, /Aucun passage/);
});

test('tarifs : prix avant/à bord, le plus cher des lignes s\'applique', async () => {
  const t = tool(createTools(schedSvc()), 'tarifs');
  const a = await t.handler({ ligne: 'A' });
  assert.equal(a.lignes[0].tarif.ticket, '1,80 €');
  assert.equal(a.lignes[0].tarif.achete_a_bord, '2,00 €');
  const q = await t.handler({ ligne: '14' });
  assert.equal(q.lignes[0].tarif.ticket, '9,00 €');
  await assert.rejects(tool(createTools(fakeSvc().svc), 'tarifs').handler({}), /non disponibles/);
});

// Routeur factice : la durée dépend des lignes exclues, et l'heure d'arrivée
// de l'heure de départ — de quoi vérifier « arriver avant » et les options.
function routedSvc({ d14 = 1200, dL1 = 1500 } = {}) {
  const calls = [];
  const svc = schedSvc({
    journey: async (from, to, at, extra = {}) => {
      calls.push({ at, exclude: [...(extra.exclude ?? [])] });
      const ex = extra.exclude ?? new Set();
      const [route, line, dur] = !ex.has('r:14') ? ['r:14', '14', d14] : !ex.has('r:L1') ? ['r:L1', 'L1', dL1] : [null, null, 0];
      if (!route) return { error: 'Aucun itinéraire trouvé' };
      return {
        depart_at: at, arrive_at: at + dur, duration_s: dur, transfers: 0, real: false,
        legs: [{ type: 'ride', route_id: route, line, mode: 'Bus', from: 'Jean Jaurès', from_id: 'stop_point:JJ2', to: 'Aéroport', to_id: 'stop_point:AER', depart: at, arrive: at + dur, seconds: dur, real: false }],
      };
    },
  });
  return { svc, calls };
}

test('itineraire : arriver avant une heure → départ le plus tardif qui convient', async () => {
  // 55 min de trajet : le premier essai (départ 45 min avant) arrive EN RETARD,
  // il faut donc corriger vers plus tôt — c'est ce cas qui compte.
  const { svc } = routedSvc({ d14: 3300 });
  const r = await tool(createTools(svc), 'itineraire').handler({ depart: 'Jean Jaurès', arrivee: 'Aéroport', arriver_avant: '12:00' });
  const cible = parisToEpoch(2026, 9, 29, 12, 0);
  const arrive = parisToEpoch(2026, 9, 29, +r.arriver_a.slice(0, 2), +r.arriver_a.slice(3));
  assert.ok(arrive <= cible, `arrive à ${r.arriver_a}`);
  assert.ok(cible - arrive <= 180, `pas de départ inutilement tôt (arrive à ${r.arriver_a})`);
  assert.equal(r.arriver_avant, '12:00');
  assert.equal(r.tarif.ticket, '9,00 €');
});

test('itineraire : options, lignes évitées toujours respectées', async () => {
  const { svc, calls } = routedSvc();
  const it = tool(createTools(svc), 'itineraire');
  const r = await it.handler({ depart: 'Jean Jaurès', arrivee: 'Aéroport', heure_depart: '11:00', options: 2 });
  assert.deepEqual(r.lignes, ['14']);
  assert.deepEqual(r.autres_options.map((o) => o.lignes), [['L1']]);
  const e = await it.handler({ depart: 'Jean Jaurès', arrivee: 'Aéroport', heure_depart: '11:00', eviter: '14' });
  assert.deepEqual(e.lignes, ['L1']);
  assert.deepEqual(e.lignes_evitees, ['14']);
  assert.ok(calls.every((c) => !c.exclude.length || c.exclude.includes('r:14') || c.exclude.includes('r:L1')));
  await assert.rejects(it.handler({ depart: 'Jean Jaurès', arrivee: 'Aéroport', heure_depart: '11:00', arriver_avant: '12:00' }), /pas les deux/);
});

test('itineraire : une alternative beaucoup plus longue est écartée', async () => {
  const { svc } = routedSvc({ d14: 1200, dL1: 5000 });
  const r = await tool(createTools(svc), 'itineraire').handler({ depart: 'Jean Jaurès', arrivee: 'Aéroport', heure_depart: '11:00', options: 3 });
  assert.deepEqual(r.autres_options, []);
  assert.match(r.autres_options_note, /Aucun autre/);
});

test('search / fetch : formes attendues par ChatGPT', async () => {
  const tools = createTools(schedSvc());
  const s = await tool(tools, 'search').handler({ query: 'Jean Jaurès' });
  assert.ok(s.results.length >= 1);
  for (const x of s.results) assert.ok(x.id && x.title && x.url, JSON.stringify(x));
  const arret = s.results.find((x) => x.id.startsWith('arret:'));
  const f = await tool(tools, 'fetch').handler({ id: arret.id });
  assert.equal(typeof f.text, 'string');
  assert.match(f.text, /Jean Jaurès/);
  assert.ok(f.url && f.title && f.metadata);
  const l = await tool(tools, 'fetch').handler({ id: 'ligne:r:A' });
  assert.match(l.text, /premier départ 06:00/);
  await assert.rejects(tool(tools, 'fetch').handler({ id: 'n-importe-quoi' }), /non reconnu/);
});
