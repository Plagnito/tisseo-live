// Itinéraires et vélos des autres villes : horaires préparés depuis un GTFS,
// planificateur, service (préparation, passages théoriques), routes, vélos GBFS,
// outil « ville_itineraire ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork } from '../lib/reseaux/gtfs.mjs';
import { windowDates, serviceDates, buildPlan } from '../lib/reseaux/plan.mjs';
import { createPlanner } from '../lib/reseaux/planificateur.mjs';
import { createNetworks } from '../lib/reseaux/instance.mjs';
import { mountNetworks } from '../lib/reseaux/routes.mjs';
import { entriesFromDatasets, networksFor, shortName, createCatalogue } from '../lib/reseaux/catalogue.mjs';
import { bikeName, bikeEntriesFromDatasets, bikeSystemsFor, gbfsFeeds, normalizeGbfs, createBikes } from '../lib/reseaux/velos.mjs';
import { createCityTools } from '../lib/tools-ville.mjs';

// Lundi 5 octobre 2026, 08:00 à Paris (06:00 UTC).
const NOW = Date.UTC(2026, 9, 5, 6, 0, 0);
const T = NOW / 1000;
const hms = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:00`;

// Deux lignes qui se croisent à Bravo : le tram B (Alpha → Bravo → Charlie, toutes
// les 10 min de 6 h à 22 h, dans les deux sens) et le bus 23 (Bravo → Delta,
// toutes les 20 min). Un service « dimanche » qui ne roule pas le lundi.
function gtfs() {
  let trips = 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n';
  let st = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n';
  const course = (id, route, sens, tete, arrets, depart, pas = 240, service = 'sem') => {
    trips += `${route},${service},${id},${tete},${sens},\n`;
    arrets.forEach((s, i) => { st += `${id},${hms(depart + i * pas)},${hms(depart + i * pas)},${s},${i + 1}\n`; });
  };
  for (let t = 6 * 3600, n = 0; t < 22 * 3600; t += 600, n++) {
    course(`b${n}`, 'R1', 0, 'CHARLIE', ['A', 'B', 'C'], t);
    course(`r${n}`, 'R1', 1, 'ALPHA', ['C', 'B', 'A'], t + 120);
  }
  for (let t = 6 * 3600 + 300, n = 0; t < 22 * 3600; t += 1200, n++) course(`d${n}`, 'R2', 0, 'Delta', ['B2', 'D'], t, 480);
  course('dim1', 'R3', 0, 'Dimanche', ['A', 'D'], 9 * 3600, 600, 'dim');
  return {
    'routes.txt': 'route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nR1,B,Tram B,0,E50040,FFFFFF\nR2,23,Ligne 23,3,,\nR3,D7,Dimanche,3,,\n',
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,Alpha,44.8200,-0.5700,0,\nB,Bravo,44.8300,-0.5700,0,\nB2,Bravo,44.8302,-0.5701,0,\nC,Charlie,44.8400,-0.5700,0,\nD,Delta,44.8300,-0.5500,0,\nP,Pôle,44.83,-0.57,1,\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsem,1,1,1,1,1,0,0,20260901,20261231\ndim,0,0,0,0,0,0,1,20260901,20261231\n',
    'calendar_dates.txt': 'service_id,date,exception_type\nsem,20261006,2\n',
    'trips.txt': trips,
    'stop_times.txt': st,
  };
}
const feedOf = (files) => ({ read: (n) => files[n] ?? null, lines: function* (n) { if (files[n]) yield* files[n].split('\n'); } });
const PLAN = buildPlan([feedOf(gtfs())], { now: NOW });

test('horaires : la fenêtre commence la veille, et le calendrier dit quel service roule quel jour', () => {
  const dates = windowDates(NOW, 15);
  assert.deepEqual([dates.length, dates[0].ymd, dates[1].ymd, dates[1].dow, dates.at(-1).ymd], [15, '20261004', '20261005', 1, '20261018']);
  const f = gtfs();
  const svc = serviceDates(f['calendar.txt'], f['calendar_dates.txt'], dates);
  assert.ok(svc.get('sem').has('20261005') && !svc.get('sem').has('20261006'), 'un jour retiré par calendar_dates ne roule pas');
  assert.ok(svc.get('dim').has('20261004') && !svc.get('dim').has('20261005'));
  assert.deepEqual([...serviceDates(null, 'service_id,date,exception_type\nx,20261005,1\nx,20270101,1\n', dates).get('x')], ['20261005'], 'un réseau sans calendar.txt, et une date hors fenêtre');
});

test('horaires : lignes, parcours par sens, fréquence, quais et bornes', () => {
  assert.deepEqual(PLAN.routes.map((r) => [r.route_id, r.short_name, r.color, r.headway_s]), [['R1', 'B', 'e50040', 600], ['R2', '23', PLAN.routes[1].color, 1200], ['R3', 'D7', PLAN.routes[2].color, PLAN.routes[2].headway_s]]);
  assert.deepEqual(PLAN.variants.R1.map((v) => [v.dir, v.headsign, v.stops.join('>')]), [['0', 'Charlie', 'A>B>C'], ['1', 'Alpha', 'C>B>A']]);
  assert.deepEqual(PLAN.variants.R1[0].times, [0, 240, 480], 'les temps de parcours viennent des horaires');
  assert.equal(PLAN.stops.P, undefined, 'une station mère n\'est pas un quai');
  assert.deepEqual([PLAN.from, PLAN.until], ['20261004', '20261018']);
  assert.deepEqual(PLAN.bbox, [44.82, -0.5701, 44.84, -0.55]);
  assert.equal(PLAN.counts.routes, 3);
  assert.ok(JSON.stringify(PLAN).length < 60_000, 'les horaires sont rangés par motifs, pas course par course');
});

test('planificateur : un trajet avec correspondance, aux heures des horaires', async () => {
  const p = createPlanner(PLAN, { now: () => NOW });
  assert.deepEqual(p.searchStops('brav').map((s) => [s.name, s.stop_ids.length, s.lines.join(',')]), [['Bravo', 2, '23,B']], 'deux quais voisins du même nom : un seul arrêt');
  assert.equal(p.searchStops('zz').length, 0);
  const j = await p.journey(p.station('A'), p.station('D'), T);
  assert.equal(j.error, undefined);
  const rides = j.legs.filter((l) => l.type === 'ride');
  assert.deepEqual(rides.map((l) => [l.line, l.mode, l.from, l.to, l.headsign]), [['B', 'Tram', 'Alpha', 'Bravo', 'Charlie'], ['23', 'Bus', 'Bravo', 'Delta', 'Delta']]);
  // 08:00 : tram à 08:00 (arrivée 08:04), bus à 08:05 (arrivée 08:13).
  assert.deepEqual(rides.map((l) => [l.depart - T, l.arrive - T, l.scheduled]), [[0, 240, true], [300, 780, true]]);
  assert.deepEqual([j.theoretical, j.schedules_until, j.transfers], [true, '20261018', 1]);
  assert.ok(rides.every((l) => l.path?.length >= 2), 'chaque étape a son tracé');
  // Le lendemain est retiré du calendrier : la ligne ne roule pas, et c'est dit.
  const demain = await p.journey(p.station('A'), p.station('C'), T + 86_400);
  assert.ok(demain.error || demain.walk_only || 'out_of_service' in demain || demain.no_departure, 'pas de tram inventé un jour sans service');
});

test('planificateur : passages théoriques à un arrêt, les deux sens, sans doublon', () => {
  const p = createPlanner(PLAN, { now: () => NOW });
  const d = p.departures(['B', 'B2'], T, 5);
  assert.deepEqual(d.map((x) => [x.line, x.headsign, (x.time - T) / 60]), [['B', 'Charlie', 4], ['B', 'Alpha', 6], ['23', 'Delta', 5]].sort((a, b) => a[2] - b[2]).concat([['B', 'Charlie', 14], ['B', 'Alpha', 16]]));
  assert.ok(d.every((x) => x.theoretical && x.delay_s === null));
  assert.equal(d[0].color, '#e50040');
});

// --- service -------------------------------------------------------------------------
const ENTRY = { id: 'tcl', name: 'TCL', title: 'Réseau urbain TCL', page: 'https://exemple.test/tcl', licence: 'fr-lo', positions: false, horaires: false, gtfs: [{ url: 'https://exemple.test/tcl.zip' }], rt: [] };
function banc({ planEchoue = false, entry = ENTRY } = {}) {
  let plan = null, net = null; const constructions = [], lectures = [];
  const statique = buildNetwork([feedOf(gtfs())], { now: NOW });
  const catalogue = { get: async (id) => (id === 'tcl' ? entry : null), forCity: async (c) => (c === 'fr:69123' ? [entry] : []) };
  let lacher; const verrou = new Promise((ok) => { lacher = ok; });
  const build = async (id, urls, quoi) => {
    constructions.push(quoi ?? 'net');
    if (quoi === 'plan') { await verrou; if (planEchoue) throw new Error('archive illisible'); plan = PLAN; } else net = statique;
  };
  const geocode = async (q) => (/gare/i.test(q) ? [{ label: 'Gare de Delta', type: 'poi', kind: 'poi', lat: 44.8301, lon: -0.5502 }, { label: 'Gare lointaine', type: 'poi', kind: 'poi', lat: 45.9, lon: 1.2 }] : []);
  const nets = createNetworks({ catalogue, build, readNet: () => net, readPlan: () => plan, geocode, fetcher: async (url) => { lectures.push(String(url)); return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) }; }, now: () => NOW });
  return { nets, constructions, lacher, lectures };
}

test('service : un réseau sans temps réel n\'a pas de véhicules, et le dit', async () => {
  const b = banc();
  assert.deepEqual((await b.nets.forCity('fr:69123')).map((n) => [n.id, n.nature]), [['tcl', 'theorique']]);
  const r = await b.nets.vehicles('tcl');
  assert.deepEqual([r.nature, r.vehicles.length], ['theorique', 0]);
});

test('service : l\'itinéraire attend la préparation des horaires, puis répond', async () => {
  const b = banc();
  const avant = await b.nets.journey('tcl', { from: { text: 'Alpha' }, to: { text: 'Delta' }, at: T });
  assert.ok(avant.preparing && avant.error, 'première demande : horaires en préparation');
  assert.equal((await b.nets.plan('tcl')).state, 'preparation');
  assert.deepEqual((await b.nets.suggest('tcl', 'alp')).stops, [], 'pas de suggestion avant que les arrêts soient prêts');
  b.lacher();
  assert.deepEqual([(await b.nets.plan('tcl', 2000)).state, (await b.nets.plan('tcl')).until], ['pret', '20261018']);
  assert.equal(b.constructions.filter((x) => x === 'plan').length, 1, 'une seule préparation, quel que soit le nombre de demandes');
  const j = await b.nets.journey('tcl', { from: { text: 'alpha' }, to: { text: 'Delta' }, at: T });
  assert.deepEqual([j.network.name, j.origin.label, j.destination.label, j.transfers, j.theoretical], ['TCL', 'Alpha', 'Delta', 1, true]);
  // Un quai choisi dans les suggestions, et un point de la carte.
  const k = await b.nets.journey('tcl', { from: { stop: 'C' }, to: { lat: 44.8201, lon: -0.5701, label: 'Chez moi' }, at: T });
  assert.deepEqual([k.origin.label, k.destination.label, k.legs.find((l) => l.type === 'ride').line], ['Charlie', 'Chez moi', 'B']);
  const perdu = await b.nets.journey('tcl', { from: { text: 'Alpha' }, to: { text: 'Nulle part ailleurs' }, at: T });
  assert.deepEqual(perdu.missing, ['to']);
  assert.equal(await b.nets.journey('inconnu', { from: {}, to: {} }), null);
});

test('service : le temps réel ne sert que pour un départ proche de maintenant', async () => {
  const b = banc({ entry: { ...ENTRY, horaires: true, rt: [{ url: 'https://exemple.test/tu', features: ['trip_updates'] }] } }); b.lacher();
  await b.nets.plan('tcl', 2000);
  const lu = () => b.lectures.filter((u) => u.endsWith('/tu')).length;
  await b.nets.journey('tcl', { from: { text: 'Alpha' }, to: { text: 'Delta' }, at: T + 86_400 * 2 });
  await b.nets.journey('tcl', { from: { text: 'Alpha' }, to: { text: 'Delta' }, at: T - 3 * 3600 });
  assert.equal(lu(), 0, 'après-demain ou ce matin : les horaires, pas le flux — il ferait attendre la première course annoncée');
  const j = await b.nets.journey('tcl', { from: { text: 'Alpha' }, to: { text: 'Delta' } });
  assert.equal(lu(), 1, 'maintenant : le flux est lu');
  assert.equal(j.error, undefined, 'et un flux en panne laisse les horaires théoriques');
});

test('service : suggestions — arrêts du réseau, et adresses seulement si le réseau y passe', async () => {
  const b = banc(); b.lacher();
  await b.nets.plan('tcl', 2000);
  const s = await b.nets.suggest('tcl', 'gare', 'fr:69123');
  assert.deepEqual([s.state, s.stops.length, s.places.map((p) => p.label)], ['pret', 0, ['Gare de Delta']], 'un lieu à cent kilomètres du réseau n\'est pas proposé');
  assert.deepEqual((await b.nets.suggest('tcl', 'bra')).stops.map((x) => [x.name, x.lines.join(',')]), [['Bravo', '23,B']]);
});

test('service : sans temps réel, un arrêt donne ses passages théoriques', async () => {
  const b = banc(); b.lacher();
  await b.nets.ready('tcl', 2000);
  await b.nets.plan('tcl', 2000);
  const a = await b.nets.stop('tcl', 'B');
  assert.deepEqual([a.stop.name, a.theoretical, a.realtime, a.departures[0].line, a.departures[0].theoretical], ['Bravo', true, false, 'B', true]);
});

test('service : des horaires impossibles à préparer — c\'est dit, sans inventer', async () => {
  const b = banc({ planEchoue: true }); b.lacher();
  await b.nets.plan('tcl', 2000);
  const j = await b.nets.journey('tcl', { from: { text: 'Alpha' }, to: { text: 'Delta' } });
  assert.match(j.error, /n'ont pas pu être préparés/);
  assert.equal((await b.nets.plan('tcl')).state, 'indisponible');
});

test('routes : itinéraire — 503 pendant la préparation, 400 sur un lieu inconnu, champ vide ≠ point 0,0', async () => {
  const routes = new Map();
  const app = { get: (path, ...h) => routes.set(path, h) };
  const vus = [];
  const networks = {
    forCity: async () => [], vehicles: async () => null, vehicle: async () => null, stops: async () => null, stop: async () => null,
    plan: async (id) => (id === 'tcl' ? { state: 'pret' } : null),
    suggest: async (id, q, city) => ({ q, city, stops: [], places: [] }),
    journey: async (id, a) => { vus.push(a); return a.from.text === 'bientot' ? { error: 'en préparation', preparing: true } : a.to.text === 'nulle part' ? { error: 'Lieu inconnu' } : { legs: [] }; },
  };
  mountNetworks(app, { networks, ah: (fn) => fn });
  const call = async (path, req) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const [garde, handler] = routes.get(path);
    let suite = false;
    garde({ headers: {}, socket: { remoteAddress: '1.1.1.1' }, ...req }, res, () => { suite = true; });
    if (suite) await handler({ headers: {}, socket: {}, query: {}, params: {}, ...req }, res);
    return res;
  };
  const P = { id: 'tcl' };
  assert.equal((await call('/api/net/:id/journey', { params: P, query: { from: 'bientot', to: 'x' } })).code, 503);
  assert.equal((await call('/api/net/:id/journey', { params: P, query: { from: 'a', to: 'nulle part' } })).code, 400);
  assert.equal((await call('/api/net/:id/journey', { params: P, query: { from_stop: 'S1', to_lat: '45.75', to_lon: '4.85', to_label: 'Ici', at: String(T), city: 'fr:69123' } })).code, 200);
  assert.deepEqual(vus.at(-1), { from: { stop: 'S1' }, to: { lat: 45.75, lon: 4.85, label: 'Ici' }, at: T, city: 'fr:69123' });
  await call('/api/net/:id/journey', { params: P, query: { from_lat: '', from_lon: '', from: 'Alpha', to: 'b' } });
  assert.deepEqual([vus.at(-1).from, vus.at(-1).at], [{ text: 'Alpha' }, null]);
  assert.equal((await call('/api/net/:id/plan', { params: { id: 'inconnu' } })).code, 404);
  assert.deepEqual((await call('/api/net/:id/suggest', { params: P, query: { q: 'a' } })).body.stops, [], 'une lettre : rien');
  assert.equal((await call('/api/net/:id/suggest', { params: P, query: { q: 'gare', city: 'fr:69123' } })).body.city, 'fr:69123');
});

// --- catalogue : réseaux sans temps réel ------------------------------------------------
const g = (url, meta = {}, title = url) => ({ format: 'GTFS', url, title, is_available: true, metadata: meta });
const rt = (url, features) => ({ format: 'gtfs-rt', url, title: url, is_available: true, features });
test('catalogue : un réseau urbain sans temps réel est gardé pour ses horaires ; une archive périmée, non', () => {
  const D = [
    { type: 'public-transit', slug: 'tcl', title: 'Réseau urbain TCL', sub_types: ['urban'], covered_area: [{ type: 'epci', insee: '200046977' }], resources: [g('https://exemple.test/tcl.zip')] },
    { type: 'public-transit', slug: 'cars', title: 'Lignes scolaires du Rhône', covered_area: [{ type: 'epci', insee: '200046977' }], resources: [g('https://exemple.test/cars.zip')] },
    { type: 'public-transit', slug: 'perime', title: 'Réseau urbain Fantôme', covered_area: [{ type: 'epci', insee: '200046977' }], resources: [g('https://exemple.test/f.zip', { start_date: '2025-01-01', end_date: '2025-12-31' })] },
    { type: 'public-transit', slug: 'alertes', title: 'Réseau urbain RTM', covered_area: [{ type: 'commune', insee: '13055' }], resources: [g('https://exemple.test/rtm.zip'), rt('https://exemple.test/al', ['service_alerts'])] },
    { type: 'public-transit', slug: 'metropole', title: 'Réseaux urbains de la Métropole Aix-Marseille-Provence', covered_area: [{ type: 'commune', insee: '13055' }],
      resources: [g('https://exemple.test/a.zip', {}, 'Aix en Bus'), g('https://exemple.test/b.zip', {}, 'RTM'), g('https://exemple.test/c.zip', {}, 'Ciotabus'), g('https://exemple.test/tout.zip', {}, 'Tous les réseaux'), g('https://exemple.test/d.zip', {}, 'Ulysse')] },
    { type: 'public-transit', slug: 'tbm', title: 'Réseau urbain TBM', sub_types: ['urban'], covered_area: [{ type: 'epci', insee: '200046977' }], resources: [g('https://exemple.test/tbm.zip'), rt('https://exemple.test/vp', ['vehicle_positions'])] },
  ];
  const e = entriesFromDatasets(D, NOW);
  assert.deepEqual(e.map((x) => x.id), ['tcl', 'alertes', 'metropole', 'tbm'], 'ni les cars scolaires sans temps réel, ni l\'archive périmée');
  assert.deepEqual(e.map((x) => [x.positions, x.horaires, x.rt.length]), [[false, false, 0], [false, false, 0], [false, false, 0], [true, false, 1]], 'des alertes seules ne font pas un temps réel');
  assert.deepEqual(e[2].gtfs.map((x) => x.url), ['https://exemple.test/tout.zip'], 'l\'archive d\'ensemble plutôt que quinze archives');
  assert.equal(e[2].name, 'Métropole Aix-Marseille-Provence');
  assert.equal(shortName('Réseau urbain Le Met\''), 'Le Met\'', 'un article en capitale fait partie du nom');
  assert.deepEqual(networksFor(e, { insee: '69123', epci: '200046977' }).map((x) => x.id), ['tbm', 'tcl'], 'à territoire égal, le réseau qui publie du temps réel d\'abord');
});

test('catalogue : une commune introuvable un instant n\'est pas oubliée pour toujours', async () => {
  let horloge = NOW, panne = true, appels = 0;
  const fetcher = async (url) => {
    if (String(url).includes('geo.api.gouv.fr')) { appels++; if (panne) throw new Error('lent'); return { ok: true, json: async () => ({ codeEpci: '200046977', codeDepartement: '69', codeRegion: '84' }) }; }
    return { ok: true, json: async () => [{ type: 'public-transit', slug: 'tcl', title: 'Réseau urbain TCL', sub_types: ['urban'], covered_area: [{ type: 'epci', insee: '200046977' }], resources: [g('https://exemple.test/tcl.zip')] }] };
  };
  const c = createCatalogue({ fetcher, now: () => horloge });
  assert.deepEqual(await c.forCity('fr:69123'), [], 'annuaire en panne : pas d\'intercommunalité, pas de réseau');
  assert.equal(appels, 2, 'deux essais');
  panne = false;
  assert.deepEqual(await c.forCity('fr:69123'), [], 'dans la minute, on ne réinterroge pas');
  horloge += 61_000;
  assert.deepEqual((await c.forCity('fr:69123')).map((x) => x.id), ['tcl']);
  assert.deepEqual(await c.commune('69123'), { insee: '69123', epci: '200046977', dep: '69', region: '84' });
  const avant = appels; await c.forCity('fr:69123');
  assert.equal(appels, avant, 'une bonne réponse est gardée');
});

// --- vélos en libre-service ---------------------------------------------------------------
const LYON = { id: 'fr:69123', name: 'Lyon', lat: 45.76, lon: 4.84 };
const VELOS = [
  { type: 'vehicles-sharing', slug: 'velov', title: 'VLS Vélo\'v Lyon', sub_types: ['bicycle'], licence: 'fr-lo', page_url: 'https://exemple.test/velov', covered_area: [{ type: 'epci', insee: '200046977' }], resources: [{ format: 'gbfs', url: 'https://exemple.test/velov/gbfs.json', is_available: true }] },
  { type: 'vehicles-sharing', slug: 'trottinettes', title: 'Trottinettes Lyon', sub_types: ['scooter', 'freefloating'], covered_area: [{ type: 'epci', insee: '200046977' }], resources: [{ format: 'gbfs', url: 'https://exemple.test/t/gbfs.json', is_available: true }] },
  { type: 'vehicles-sharing', slug: 'flotte', title: 'Vélos sans station', sub_types: ['bicycle', 'freefloating'], covered_area: [{ type: 'epci', insee: '200046977' }], resources: [{ format: 'gbfs', url: 'https://exemple.test/f/gbfs.json', is_available: true }] },
  { type: 'vehicles-sharing', slug: 'region', title: 'Vélos de la région', sub_types: ['bicycle'], covered_area: [{ type: 'region', insee: '84' }], resources: [{ format: 'gbfs', url: 'https://exemple.test/r/gbfs.json', is_available: true }] },
  { type: 'vehicles-sharing', slug: 'sans-flux', title: 'VLS Sans flux', sub_types: ['bicycle'], covered_area: [{ type: 'epci', insee: '200046977' }], resources: [{ format: 'csv', url: 'https://exemple.test/x.csv', is_available: true }] },
];

test('vélos : seuls les systèmes à stations, le plus local d\'abord', () => {
  const e = bikeEntriesFromDatasets(VELOS);
  assert.deepEqual(e.map((x) => [x.id, x.name]), [['velov', 'Vélo\'v Lyon'], ['region', 'Vélos de la région']]);
  assert.equal(bikeName('VLS Le Vélo TBM'), 'Le Vélo TBM');
  assert.deepEqual(bikeSystemsFor(e, { insee: '69123', epci: '200046977', dep: '69', region: '84' }).map((x) => x.id), ['velov', 'region']);
  assert.deepEqual(bikeSystemsFor(e, { insee: '33063', epci: '243300316', dep: '33', region: '75' }), []);
});

test('vélos : les trois versions du format GBFS donnent les mêmes lieux', () => {
  assert.deepEqual(gbfsFeeds({ data: { fr: { feeds: [{ name: 'station_information', url: 'https://a/i' }, { name: 'station_status', url: 'https://a/s' }] } } }), { station_information: 'https://a/i', station_status: 'https://a/s' });
  assert.deepEqual(gbfsFeeds({ data: { feeds: [{ name: 'station_status', url: 'https://a/s' }, { name: 'sans-url' }] } }), { station_status: 'https://a/s' });
  assert.deepEqual(gbfsFeeds(null), {});
  const systeme = { id: 'velov', name: 'Vélo\'v Lyon', page: 'https://exemple.test/velov' };
  // v2 : noms en texte, num_bikes_available, last_reported en secondes.
  const v2 = normalizeGbfs(
    { data: { stations: [{ station_id: 1, name: 'BELLECOUR', lat: 45.7578, lon: 4.8320, capacity: 20 }, { station_id: 2, name: 'Loin', lat: 46.5, lon: 4.8 }, { station_id: 3, name: '', lat: 45.76, lon: 4.84 }, { station_id: 4, name: 'Zéro', lat: 0, lon: 0 }] } },
    { data: { stations: [{ station_id: '1', num_bikes_available: 7, num_docks_available: 13, is_renting: 1, is_returning: true, is_installed: 1, last_reported: T - 60, num_bikes_available_types: [{ mechanical: 3 }, { ebike: 4 }] }] } },
    null, { systeme, profile: LYON });
  assert.equal(v2.length, 1, 'ni la station hors de la ville, ni la station sans nom, ni le point 0,0');
  assert.deepEqual([v2[0].id, v2[0].name, v2[0].bikes, v2[0].docks, v2[0].renting, v2[0].returning, v2[0].reported_at, v2[0].category, v2[0].city_id], ['bikes:velov:1', 'Bellecour', 7, 13, true, true, T - 60, 'bikes', 'fr:69123']);
  assert.deepEqual(v2[0].details, [{ label: 'Capacité', value: '20' }, { label: 'Vélos mécaniques', value: '3' }, { label: 'Vélos électriques', value: '4' }]);
  // v3 : noms par langue, num_vehicles_available, date ISO, types de véhicules.
  const v3 = normalizeGbfs(
    { data: { stations: [{ station_id: 'a', name: [{ text: 'Part-Dieu', language: 'fr' }], lat: 45.7606, lon: 4.8594 }] } },
    { data: { stations: [{ station_id: 'a', num_vehicles_available: 9, num_docks_available: 2, is_renting: false, is_returning: true, last_reported: new Date((T - 120) * 1000).toISOString(), vehicle_types_available: [{ vehicle_type_id: 'm', count: 2 }, { vehicle_type_id: 'e', count: 5 }, { vehicle_type_id: 't', count: 2 }] }] } },
    { data: { vehicle_types: [{ vehicle_type_id: 'm', form_factor: 'bicycle', propulsion_type: 'human' }, { vehicle_type_id: 'e', form_factor: 'bicycle', propulsion_type: 'electric_assist' }, { vehicle_type_id: 't', form_factor: 'scooter_standing', propulsion_type: 'electric' }] } },
    { systeme, profile: LYON });
  assert.deepEqual([v3[0].name, v3[0].bikes, v3[0].docks, v3[0].renting, v3[0].reported_at], ['Part-Dieu', 7, 2, false, T - 120], 'les trottinettes de la station ne sont pas des vélos');
  // Sans statut : la station existe, ses disponibilités sont inconnues — pas zéro.
  const nu = normalizeGbfs({ data: { stations: [{ station_id: 1, name: 'Bellecour', lat: 45.7578, lon: 4.8320 }] } }, null, null, { systeme, profile: LYON });
  assert.deepEqual([nu[0].bikes, nu[0].docks, nu[0].reported_at, nu[0].renting], [null, null, null, null]);
});

test('vélos : lecture en direct, gardée une minute ; un système qui ne dessert pas la ville est écarté', async () => {
  let horloge = NOW; const lectures = [];
  const reponses = {
    'https://exemple.test/velov/gbfs.json': { data: { fr: { feeds: [{ name: 'station_information', url: 'https://exemple.test/velov/info' }, { name: 'station_status', url: 'https://exemple.test/velov/statut' }] } } },
    'https://exemple.test/velov/info': { data: { stations: [{ station_id: 1, name: 'Bellecour', lat: 45.7578, lon: 4.8320 }] } },
    'https://exemple.test/velov/statut': () => ({ last_updated: Math.floor(horloge / 1000), data: { stations: [{ station_id: 1, num_bikes_available: Math.floor((horloge - NOW) / 1000), num_docks_available: 5, last_reported: Math.floor(horloge / 1000) }] } }),
    'https://exemple.test/r/gbfs.json': { data: { feeds: [{ name: 'station_information', url: 'https://exemple.test/r/info' }, { name: 'station_status', url: 'https://exemple.test/r/statut' }] } },
    'https://exemple.test/r/info': { data: { stations: [{ station_id: 9, name: 'Grenoble Gare', lat: 45.19, lon: 5.71 }] } },
    'https://exemple.test/r/statut': { data: { stations: [] } },
  };
  const fetcher = async (url) => { const u = String(url); lectures.push(u); const r = reponses[u]; return r ? { ok: true, status: 200, headers: new Map(), json: async () => (typeof r === 'function' ? r() : r) } : { ok: false, status: 404, headers: new Map() }; };
  const systemes = bikeEntriesFromDatasets(VELOS);
  const lieux = { 69123: { insee: '69123', epci: '200046977', dep: '69', region: '84' }, 38185: { insee: '38185', epci: 'x', dep: '38', region: '84' }, 33063: { insee: '33063', epci: 'y', dep: '33', region: '75' } };
  const velos = createBikes({ systemes: async () => systemes, lieuDe: async (insee) => lieux[insee], fetcher, now: () => horloge });
  const r = await velos.places(LYON);
  assert.deepEqual([r.live, r.system.name, r.source.label, r.places.length, r.places[0].bikes, r.status], [true, 'Vélo\'v Lyon', 'Vélo\'v Lyon · GBFS', 1, 0, 'ok']);
  horloge += 30_000;
  assert.equal((await velos.places(LYON)).places[0].bikes, 0, 'moins d\'une minute : pas de nouvelle lecture');
  assert.equal(lectures.filter((u) => u.endsWith('/statut')).length, 1);
  horloge += 40_000;
  await velos.places(LYON); // périmé : servi tout de suite, relu derrière
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal((await velos.places(LYON)).places[0].bikes, 70);
  assert.equal(lectures.filter((u) => u.endsWith('/velov/info')).length, 1, 'les stations ne sont pas relues à chaque fois');
  // Grenoble : seul le système régional le couvre, et il y a bien une station.
  assert.equal((await velos.places({ id: 'fr:38185', name: 'Grenoble', lat: 45.19, lon: 5.72 })).places[0].name, 'Grenoble Gare');
  assert.equal(await velos.places({ id: 'fr:33063', name: 'Bordeaux', lat: 44.84, lon: -0.58 }), null, 'aucun système : la carte retombera sur OpenStreetMap');
  assert.equal(await velos.places({ id: 'geo:52.5:13.4', name: 'Berlin', lat: 52.5, lon: 13.4 }), null);
});

// --- connecteur --------------------------------------------------------------------------------
test('connecteur : « ville_itineraire » rend les étapes et dit que les heures sont théoriques', async () => {
  const b = banc(); b.lacher();
  const villes = new Map([{ id: 'fr:69123', name: 'Lyon', transport: 'osm', timezone: 'Europe/Paris' }, { id: 'fr:31555', name: 'Toulouse', transport: 'tisseo' }, { id: 'fr:75056', name: 'Paris', transport: 'osm' }, { id: 'geo:52.5:13.4', name: 'Berlin', transport: 'osm' }].map((p) => [p.id, p]));
  const cities = { get: async (id = 'fr:31555') => { if (villes.has(id)) return villes.get(id); throw new RangeError('Ville inconnue'); }, search: async () => [] };
  const tools = createCityTools({ cities, cityService: {}, cityContext: {}, profileCatalog: () => ({ categories: [] }), reseaux: b.nets, now: () => NOW });
  const t = tools.find((x) => x.name === 'ville_itineraire');
  assert.ok(t);
  const r = await t.handler({ ville: 'fr:69123', de: 'Alpha', a: 'Delta', depart: '08:00' });
  assert.deepEqual([r.reseau, r.de, r.a, r.depart, r.arrivee, r.correspondances], ['TCL', 'Alpha', 'Delta', '08:00', '08:13', 1]);
  assert.deepEqual(r.etapes.filter((e) => e.ligne).map((e) => [e.ligne, e.mode, e.monter, e.a, e.descendre, e.arrivee, e.heure]), [['B', 'Tram', 'Alpha', '08:00', 'Bravo', '08:04', 'horaire théorique'], ['23', 'Bus', 'Bravo', '08:05', 'Delta', '08:13', 'horaire théorique']]);
  assert.match(r.nature, /sans temps réel/);
  assert.equal(r.horaires_connus_jusqu_au, '2026-10-18');
  await assert.rejects(t.handler({ ville: 'fr:69123', de: 'Alpha', a: 'Nulle part ailleurs' }), /Nulle part ailleurs|introuvable|inconnu/i);
  await assert.rejects(t.handler({ ville: 'fr:69123', de: 'Alpha', a: 'Delta', depart: 'tantôt' }), /illisible/);
  await assert.rejects(t.handler({ ville: 'fr:31555', de: 'a', a: 'b' }), /« itineraire »/);
  await assert.rejects(t.handler({ ville: 'fr:75056', de: 'a', a: 'b' }), /Paris et de l'Île-de-France/);
  await assert.rejects(t.handler({ ville: 'geo:52.5:13.4', de: 'a', a: 'b' }), /villes françaises/);
  // « ville_transports » sur un réseau sans temps réel : pas de véhicules, passages théoriques.
  const tr = tools.find((x) => x.name === 'ville_transports');
  const sans = await tr.handler({ ville: 'fr:69123' });
  assert.deepEqual([sans.vehicules, sans.temps_reel], [0, false]);
  assert.match(sans.note, /ne publie pas de temps réel/);
  const arr = await tr.handler({ ville: 'fr:69123', arret: 'bravo' });
  assert.match(arr.nature, /THÉORIQUES/);
  assert.equal(arr.passages[0].ligne, 'B');
});
