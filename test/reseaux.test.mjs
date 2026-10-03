// Réseaux des autres villes : lecture du GTFS, catalogue national, flux temps
// réel (binaire et JSON), positions publiées et positions estimées.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvRows, csvObjects, buildNetwork, simplify, modeOf } from '../lib/reseaux/gtfs.mjs';
import { entriesFromDatasets, networksFor, shortName, createCatalogue } from '../lib/reseaux/catalogue.mjs';
import { decodeGtfsRt, feedKinds } from '../lib/reseaux/gtfsrt.mjs';
import {
  publicUrl, decodeFeed, indexNet, joli, project, pointAt, dedupe,
  vehiclesFromPositions, vehiclesFromTripUpdates, departuresFromTripUpdates, createNetworks,
} from '../lib/reseaux/instance.mjs';
import { mountNetworks } from '../lib/reseaux/routes.mjs';

// --- GTFS statique ----------------------------------------------------------------
test('csv : guillemets, virgules et retours à la ligne dans un champ, BOM, CRLF', () => {
  const rows = [...csvRows('﻿a,b,c\r\n1,"x, y","dit ""oui"""\r\n2,"deux\nlignes",\r\n\r\n3,,z')];
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'dit "oui"'], ['2', 'deux\nlignes', ''], ['3', '', 'z']]);
  assert.deepEqual([...csvObjects('id , nom\n7, Sept \n', ['nom', 'absent'])], [{ nom: 'Sept', absent: '' }]);
});

const GTFS = {
  'routes.txt': 'route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nR1,B,Tram B,0,E50040,FFFFFF\nR2,23,"Principale, 23",3,,\nR3,,Navette fluviale,4,00A0E0,\n',
  'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n'
    + 'R1,s,t1,FRANCE ALOUETTE,0,S1\nR1,s,t2,FRANCE ALOUETTE,0,S1\nR1,s,t3,FRANCE ALOUETTE,0,S1\nR1,s,t4,FRANCE ALOUETTE,0,S2\nR1,s,t5,Berges,1,S3\nR1,s,t6,Rare,0,S9\nR2,s,t7,Hippodrome,0,\nRX,s,t8,Fantôme,0,S1\n',
  'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n'
    + 'S1,44.8300,-0.5700,2\nS1,44.8200,-0.5700,1\nS1,44.8400,-0.5700,3\nS2,44.8200,-0.5700,1\nS2,44.8200,-0.5600,2\nS3,44.8400,-0.5700,1\nS3,44.8200,-0.5700,2\nS9,44.0,0.0,1\nS9,44.1,0.0,2\n',
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nA,Alpha,44.8200,-0.5700,0,\nB,Bravo,44.8300,-0.5700,,\nC,Charlie,44.8400,-0.5700,0,\nP,Pôle,44.83,-0.57,1,\nE,Entrée,44.83,-0.57,2,P\nZ,Nulle part,0,0,0,\n',
  // Jamais lu : sa seule présence ne doit rien coûter.
  'stop_times.txt': null,
};
const feedOf = (files) => ({ read: (n) => files[n] ?? null });

test('gtfs : lignes, courses, arrêts et un tracé représentatif par sens', () => {
  const net = buildNetwork([feedOf(GTFS)], { now: Date.UTC(2026, 9, 2) });
  assert.deepEqual(net.routes.map((r) => [r.id, r.short, r.mode, r.color, r.text]), [
    ['R1', 'B', 'Tram', '#e50040', '#ffffff'], ['R2', '23', 'Bus', null, null], ['R3', 'Navette fluviale', 'Bateau', '#00a0e0', null],
  ]);
  assert.equal(net.routes[1].long, 'Principale, 23');
  assert.deepEqual(net.trips.t1, [0, 0, 0]);
  assert.deepEqual(net.trips.t5, [0, 1, 1]);
  assert.equal(net.trips.t8, undefined, 'une course d\'une ligne inconnue est écartée');
  assert.equal(net.headsigns[0], 'FRANCE ALOUETTE');
  // Sens 0 : S1 (3 courses) puis S2 (1 sur 5 = 20 % : sous le quart, écarté) ; S9, rare, jamais.
  assert.equal(net.shapes['0|0'].length, 1);
  assert.deepEqual(net.shapes['0|0'][0], [[44.82, -0.57], [44.84, -0.57]], 'remis dans l\'ordre des séquences, puis simplifié (points alignés)');
  assert.equal(net.shapes['0|1'].length, 1);
  assert.deepEqual(net.stops.map((s) => s[0]), ['A', 'B', 'C', 'P'], 'ni entrée de station, ni arrêt en 0,0');
  assert.equal(net.stops[3][4], 1, 'la station mère est marquée');
  assert.deepEqual(net.bbox, [44.82, -0.57, 44.84, -0.57]);
  assert.equal(net.counts.trips, 7);
});

test('gtfs : plusieurs archives d\'un même réseau se complètent, la première gagne', () => {
  const autre = { 'routes.txt': 'route_id,route_short_name,route_type\nR1,DOUBLON,3\nR9,N9,3\n', 'trips.txt': 'route_id,trip_id,trip_headsign,direction_id\nR9,n1,Nuit,0\n', 'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nN,Nuit,44.9,-0.6\n' };
  const net = buildNetwork([feedOf(GTFS), feedOf(autre)]);
  assert.equal(net.routes.length, 4);
  assert.equal(net.routes[0].short, 'B');
  assert.deepEqual(net.trips.n1, [3, 0, net.headsigns.indexOf('Nuit')]);
  assert.ok(net.stops.some((s) => s[0] === 'N'));
});

test('gtfs : simplification en mètres et modes étendus', () => {
  const droit = [[0, 0], [0.0001, 0.00000001], [0.0002, 0]];
  assert.equal(simplify(droit, 6).length, 2);
  const coude = [[0, 0], [0.001, 0.001], [0.002, 0]];
  assert.equal(simplify(coude, 6).length, 3);
  assert.deepEqual([0, 1, 3, 4, 6, 109, 401, 715, 900, 1300, 99999].map(modeOf), ['Tram', 'Métro', 'Bus', 'Bateau', 'Télécabine', 'Train', 'Métro', 'Bus', 'Tram', 'Télécabine', 'Bus']);
});

// --- catalogue ---------------------------------------------------------------------
const NOW = Date.UTC(2026, 9, 2, 20, 0, 0);
const gtfs = (url, meta = {}) => ({ format: 'GTFS', url, title: url, is_available: true, metadata: meta });
const rt = (url, features) => ({ format: 'gtfs-rt', url, title: url, is_available: true, features });
const DATASETS = [
  { type: 'public-transit', slug: 'tbm', title: 'Réseau urbain et scolaire TBM', sub_types: ['urban'], licence: 'fr-lo', page_url: 'https://exemple.test/tbm', covered_area: [{ type: 'epci', insee: '243300316', nom: 'Bordeaux Métropole' }],
    resources: [gtfs('https://exemple.test/tbm.zip', { start_date: '2026-10-02', end_date: '2026-12-31' }), rt('https://exemple.test/vp', ['vehicle_positions']), rt('https://exemple.test/tu', ['trip_updates']), { format: 'SIRI Lite', url: 'https://exemple.test/siri', is_available: true }] },
  { type: 'public-transit', slug: 'navette', title: 'Navette Aéroport de Bordeaux', covered_area: [{ type: 'commune', insee: '33063', nom: 'Bordeaux' }],
    resources: [gtfs('https://exemple.test/nav.zip'), rt('https://exemple.test/nav-vp', ['vehicle_positions'])] },
  { type: 'public-transit', slug: 'star', title: 'Réseau urbain STAR', covered_area: [{ type: 'epci', insee: '243500139', nom: 'Rennes Métropole' }],
    resources: [gtfs('https://exemple.test/a-venir.zip', { start_date: '2026-10-19', end_date: '2026-11-01' }), gtfs('https://exemple.test/en-cours.zip', { start_date: '2026-09-30', end_date: '2026-10-18' }), rt('https://exemple.test/star-vp', ['vehicle_positions'])] },
  { type: 'public-transit', slug: 'ilevia', title: 'Réseau urbain ilévia', covered_area: [{ type: 'epci', insee: '200093201', nom: 'MEL' }], resources: [gtfs('https://exemple.test/il.zip'), rt('https://exemple.test/il-tu', ['trip_updates'])] },
  { type: 'public-transit', slug: 'sans-rt', title: 'Réseau urbain TCL', covered_area: [{ type: 'epci', insee: '200046977', nom: 'Lyon' }], resources: [gtfs('https://exemple.test/tcl.zip')] },
  { type: 'public-transit', slug: 'hors-service', title: 'Réseau urbain Fantôme', covered_area: [{ type: 'commune', insee: '33063' }], resources: [gtfs('https://exemple.test/f.zip'), { ...rt('https://exemple.test/f-vp', ['vehicle_positions']), is_available: false }] },
  { type: 'public-transit', slug: 'alertes-seules', title: 'Réseaux urbains de la Métropole', covered_area: [{ type: 'commune', insee: '33063' }], resources: [gtfs('https://exemple.test/m.zip'), rt('https://exemple.test/m-al', ['service_alerts'])] },
  { type: 'public-transit', slug: 'suburbain', title: 'Réseau urbain SUB', covered_area: [{ type: 'epci', insee: '200093201' }, { type: 'epci', insee: '111' }, { type: 'epci', insee: '222' }], resources: [gtfs('https://exemple.test/sub.zip'), rt('https://exemple.test/sub-tu', ['trip_updates'])] },
  { type: 'bike-data', slug: 'velos', title: 'VLS', covered_area: [{ type: 'commune', insee: '33063' }], resources: [gtfs('https://exemple.test/v.zip'), rt('https://exemple.test/v', [])] },
];

test('catalogue : les réseaux et ce que chacun publie, avec le GTFS en vigueur', () => {
  const e = entriesFromDatasets(DATASETS, NOW);
  assert.deepEqual(e.map((x) => x.id), ['tbm', 'navette', 'star', 'ilevia', 'sans-rt', 'hors-service', 'alertes-seules', 'suburbain'], 'un réseau urbain sans temps réel est gardé pour ses horaires ; les vélos ne sont pas un réseau');
  // Sans temps réel utilisable : ni flux absent, ni flux en panne, ni alertes seules ne font des véhicules.
  for (const id of ['sans-rt', 'hors-service', 'alertes-seules']) assert.deepEqual([e.find((x) => x.id === id).positions, e.find((x) => x.id === id).horaires, e.find((x) => x.id === id).rt.length], [false, false, 0], id);
  const star = e.find((x) => x.id === 'star');
  assert.deepEqual(star.gtfs.map((g) => g.url), ['https://exemple.test/en-cours.zip'], 'la « version à venir » n\'est pas lue');
  const tbm = e[0];
  assert.equal(tbm.name, 'TBM');
  assert.equal(tbm.rt.length, 2, 'le SIRI n\'est pas un flux GTFS-RT');
  assert.ok(tbm.positions && tbm.horaires && tbm.urbain);
  assert.equal(e.find((x) => x.id === 'ilevia').positions, false);
  assert.equal(shortName('Réseau urbain et périurbain Fil Bleu'), 'Fil Bleu');
  assert.equal(shortName('Navette Aéroport de Bordeaux'), 'Navette Aéroport de Bordeaux');
});

test('catalogue : une ville trouve son réseau par sa commune ou son intercommunalité', () => {
  const e = entriesFromDatasets(DATASETS, NOW);
  assert.deepEqual(networksFor(e, { insee: '33063', epci: '243300316' }).map((x) => x.id), ['tbm', 'navette', 'hors-service', 'alertes-seules'], 'le réseau urbain avant la navette, et ceux qui n\'ont que des horaires en dernier');
  assert.deepEqual(networksFor(e, { insee: '33281', epci: '243300316' }).map((x) => x.id), ['tbm'], 'une commune voisine de la métropole a le réseau, pas la navette');
  assert.deepEqual(networksFor(e, { insee: '33063', epci: null }).map((x) => x.id), ['navette', 'hors-service', 'alertes-seules'], 'sans intercommunalité connue : la commune seule');
  assert.deepEqual(networksFor(e, { insee: '69123', epci: '200046977' }).map((x) => x.id), ['sans-rt'], 'Lyon ne publie pas de temps réel : son réseau est là pour ses horaires');
  assert.deepEqual(networksFor(e, { insee: '59350', epci: '200093201' }).map((x) => x.id), ['ilevia', 'suburbain'], 'à nature égale, le réseau de la métropole avant celui qui en couvre trois');
});

test('catalogue : gardé en mémoire, relu du disque si la source est en panne', async () => {
  let appels = 0, panne = false, horloge = NOW, garde = null;
  const fetcher = async (url) => {
    if (String(url).includes('geo.api.gouv.fr')) return { ok: true, json: async () => ({ codeEpci: '243300316' }) };
    appels++;
    if (panne) throw new Error('réseau coupé');
    return { ok: true, json: async () => DATASETS };
  };
  const c = createCatalogue({ fetcher, now: () => horloge, save: (x) => { garde = JSON.parse(JSON.stringify(x)); }, load: () => garde });
  assert.equal((await c.forCity('fr:33063'))[0].id, 'tbm');
  await c.all(); await c.get('tbm');
  assert.equal(appels, 1, 'une seule lecture du catalogue');
  assert.deepEqual(await c.forCity('geo:1:2'), [], 'hors de France : rien');
  assert.equal(await c.get('inconnu'), null);
  // Un autre processus, catalogue national en panne : la copie du disque sert.
  panne = true;
  const c2 = createCatalogue({ fetcher, now: () => horloge, load: () => garde });
  assert.equal((await c2.get('star')).id, 'star');
  // Périmé et toujours en panne : on sert l'ancien plutôt que rien.
  horloge += 13 * 3600_000;
  assert.equal((await c.get('tbm')).id, 'tbm');
});

// --- adresses ------------------------------------------------------------------------
test('adresses : seules les adresses publiques sont lues', () => {
  for (const u of ['https://bdx.mecatran.com/x?apiKey=a', 'http://185.220.72.38:8085/flux', 'https://proxy.transport.data.gouv.fr/resource/x']) assert.ok(publicUrl(u), u);
  for (const u of ['http://localhost:4730/api', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://172.20.3.4/x', 'http://169.254.169.254/latest', 'http://[::1]/x', 'http://[fd00::1]/x', 'http://pi.local/x', 'file:///etc/passwd', 'ftp://exemple.test/x', 'pas une adresse', 'http://0.0.0.0/x', 'http://100.64.1.1/x']) assert.equal(publicUrl(u), null, u);
});

// --- flux temps réel -------------------------------------------------------------------
// Petit encodeur protobuf, pour vérifier le décodeur sur un flux binaire.
const varint = (n) => { const o = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const field = (no, wire, bytes) => [...varint((no << 3) | wire), ...bytes];
const str = (no, s) => { const b = [...new TextEncoder().encode(s)]; return field(no, 2, [...varint(b.length), ...b]); };
const msg = (no, bytes) => field(no, 2, [...varint(bytes.length), ...bytes]);
const f32 = (no, x) => field(no, 5, [...new Uint8Array(new Float32Array([x]).buffer)]);
const int = (no, n) => field(no, 0, varint(n));

test('flux : un GTFS-RT binaire (positions) est décodé champ par champ', () => {
  const bytes = new Uint8Array([
    ...msg(1, [...str(1, '2.0'), ...int(3, 1790973752)]),
    ...msg(2, [...str(1, 'e1'), ...msg(4, [
      ...msg(1, [...str(1, 't1'), ...str(5, 'R1'), ...int(6, 1)]),
      ...msg(2, [...f32(1, 44.83093), ...f32(2, -0.5732), ...f32(3, 198), ...f32(5, 5.5)]),
      ...int(4, 2), ...int(5, 1790973740), ...str(7, 'B'), ...msg(8, [...str(1, 'tram:1306'), ...str(2, 'FRANCE ALOUETTE')]),
    ])]),
  ]);
  const feed = decodeGtfsRt(bytes);
  assert.equal(feed.header.timestamp, 1790973752);
  const v = feed.entity[0].vehicle;
  assert.equal(v.trip.trip_id, 't1'); assert.equal(v.trip.route_id, 'R1'); assert.equal(v.trip.direction_id, 1);
  assert.ok(Math.abs(v.position.latitude - 44.83093) < 1e-4 && Math.abs(v.position.longitude + 0.5732) < 1e-4);
  assert.equal(v.current_status, 2); assert.equal(v.stop_id, 'B'); assert.equal(v.vehicle.id, 'tram:1306');
  assert.deepEqual(feedKinds(feed), { trip_updates: 0, vehicle_positions: 1, alerts: 0 });
  assert.deepEqual(decodeFeed(bytes), feed, 'decodeFeed lit le binaire…');
  assert.throws(() => decodeFeed(new TextEncoder().encode('<!DOCTYPE html><html>')), /GTFS-RT/, 'une page HTML n\'est pas un flux');
});

test('flux : certains réseaux servent du JSON en camelCase', () => {
  const json = { header: { gtfsRealtimeVersion: '2.0', timestamp: 100 }, entity: [{ id: '1', tripUpdate: { trip: { tripId: 't1', routeId: 'R1' }, stopTimeUpdate: [{ stopId: 'A', departure: { time: 120 } }] } }] };
  const feed = decodeFeed(new TextEncoder().encode('\n ' + JSON.stringify(json)));
  assert.equal(feed.entity[0].trip_update.stop_time_update[0].stop_id, 'A');
  assert.equal(feed.entity[0].trip_update.trip.trip_id, 't1');
});

// --- véhicules --------------------------------------------------------------------------
const net = buildNetwork([feedOf(GTFS)], { now: NOW });
const ix = indexNet(net);
const T = 1_790_973_800;
const vp = (id, lat, lon, extra = {}) => ({ id, vehicle: { trip: { trip_id: 't1', route_id: 'R1', direction_id: 0 }, position: { latitude: lat, longitude: lon, bearing: 10 }, timestamp: T - 20, vehicle: { id }, ...extra } });

test('positions publiées : ligne, couleur, destination lisible, arrêt, fraîcheur', () => {
  const feed = { header: { timestamp: T - 5 }, entity: [
    vp('v1', 44.825, -0.57, { stop_id: 'B', current_status: 2 }),
    vp('v2', 44.83, -0.57, { timestamp: T - 3600 }),                                           // périmée
    vp('v3', 0, 0),                                                                            // sans position
    vp('v4', 44.83, -0.56, { trip: { trip_id: 't7' }, timestamp: 0 }),                            // ligne par la course, horodatage du flux
    vp('v5', 44.84, -0.56, { trip: { route_id: '8-B' } }),                                       // identifiant écrit autrement
    vp('v6', 44.85, -0.56, { trip: { route_id: 'INCONNUE:77' }, position: { latitude: 44.85, longitude: -0.56, speed: 6 }, current_status: 1 }),
  ] };
  const list = vehiclesFromPositions([feed], ix, T);
  assert.deepEqual(list.map((v) => v.id), ['v1', 'v4', 'v5', 'v6']);
  const [v1, v4, v5, v6] = list;
  assert.deepEqual([v1.line, v1.color, v1.mode, v1.headsign, v1.stop, v1.status, v1.estimated], ['B', '#e50040', 'Tram', 'France Alouette', 'Bravo', 'en route', false]);
  assert.deepEqual([v4.line, v4.headsign, v4.ts], ['23', 'Hippodrome', T - 5]);
  assert.equal(v5.line, 'B', '« 8-B » est la ligne B');
  assert.deepEqual([v6.line, v6.color, v6.bearing, v6.speed_kmh, v6.status], ['77', null, null, 22, 'en route'], 'ligne inconnue : son nom brut ; « à l\'arrêt » à 22 km/h = en route');
  assert.equal(vehiclesFromPositions([feed], null, T).length, 4, 'sans statique (encore en préparation), les véhicules sortent quand même');
  assert.equal(joli('GARE ST JEAN'), 'Gare St Jean');
  assert.equal(joli('Wambrechies Agrippin'), 'Wambrechies Agrippin');
});

test('doublons : deux flux qui publient le même véhicule n\'en font qu\'un', () => {
  const a = { id: 'a', line: 'B', lat: 44.83, lon: -0.57 };
  assert.deepEqual(dedupe([a, { ...a }, { id: 'b', line: 'B', lat: 44.83005, lon: -0.57 }, { id: 'c', line: '23', lat: 44.83, lon: -0.57 }, { id: 'd', line: 'B', lat: 44.84, lon: -0.57 }]).map((v) => v.id), ['a', 'c', 'd']);
});

test('tracé : projection et point à une abscisse', () => {
  const line = [[44.82, -0.57], [44.84, -0.57]];
  const p = project(line, 44.83, -0.5695);
  assert.ok(Math.abs(p.s - 1112) < 5 && p.d > 30 && p.d < 50, JSON.stringify(p));
  const q = pointAt(line, p.s);
  assert.ok(Math.abs(q.lat - 44.83) < 1e-4 && q.bearing === 0);
  assert.equal(pointAt(line, 1e9).lat, 44.84);
});

const tu = (tripId, stus, extra = {}) => ({ id: tripId, trip_update: { trip: { trip_id: tripId, route_id: 'R1', direction_id: 0, ...extra.trip }, stop_time_update: stus, ...extra.tu } });
const stu = (stop, arr, dep = arr, seq) => ({ stop_id: stop, arrival: { time: arr }, departure: { time: dep }, ...(seq ? { stop_sequence: seq } : {}) });

test('positions estimées : entre l\'arrêt quitté et le suivant, le long du tracé', () => {
  const feed = { header: { timestamp: T }, entity: [
    tu('t1', [stu('A', T - 60), stu('B', T + 60), stu('C', T + 200)]),            // à mi-chemin de A et B
    tu('t2', [stu('A', T - 600), stu('B', T - 500), stu('C', T - 300)]),          // terminée
    tu('t3', [stu('A', T + 300, T + 300, 1), stu('B', T + 400)]),                 // pas encore partie
    tu('t4', [stu('A', T - 30, T + 30), stu('B', T + 120)]),                      // à quai
    tu('t5', [stu('A', T - 60), stu('B', T + 60)], { trip: { schedule_relationship: 3 } }), // annulée
  ] };
  const list = vehiclesFromTripUpdates([feed], ix, T);
  assert.deepEqual(list.map((v) => v.id), ['t1', 't4']);
  const [v1, v4] = list;
  assert.ok(Math.abs(v1.lat - 44.825) < 2e-4 && Math.abs(v1.lon + 0.57) < 1e-4, `à mi-chemin : ${v1.lat}`);
  assert.deepEqual([v1.estimated, v1.bearing, v1.stop, v1.status, v1.headsign, v1.ts], [true, 0, 'Bravo', 'en route', 'France Alouette', T]);
  assert.deepEqual([v4.status, v4.lat], ['à l\'arrêt', 44.82]);
  assert.deepEqual(vehiclesFromTripUpdates([feed], null, T), [], 'sans arrêts connus, aucune estimation');
});

test('positions estimées : un flux qui ne liste que les arrêts à venir', () => {
  const memoire = new Map();
  // Première lecture : seul le prochain arrêt (B, dans 90 s) est connu. Le tracé
  // permet de reculer le long de la ligne.
  let list = vehiclesFromTripUpdates([{ header: { timestamp: T }, entity: [tu('t1', [stu('B', T + 90, T + 90, 5), stu('C', T + 200, T + 200, 6)])] }], ix, T, memoire);
  assert.equal(list.length, 1);
  assert.ok(list[0].lat < 44.83 && list[0].lat > 44.82, `en amont de B : ${list[0].lat}`);
  assert.equal(list[0].stop, 'Bravo');
  // B disparaît de la liste : il vient d'être quitté. Le véhicule est entre B et C.
  list = vehiclesFromTripUpdates([{ header: { timestamp: T + 150 }, entity: [tu('t1', [stu('C', T + 210, T + 210, 6)])] }], ix, T + 150, memoire);
  assert.ok(list[0].lat > 44.83 && list[0].lat < 44.84, `entre B et C : ${list[0].lat}`);
  assert.equal(list[0].stop, 'Charlie');
  // La course n'est plus publiée : sa mémoire est oubliée.
  vehiclesFromTripUpdates([{ header: { timestamp: T + 300 }, entity: [] }], ix, T + 300, memoire);
  assert.equal(memoire.size, 0);
});

test('passages à un arrêt : tous les quais, sans le terminus, les plus proches d\'abord', () => {
  const feed = { header: { timestamp: T }, entity: [
    tu('t1', [stu('A', T + 600), stu('B', T + 700), stu('C', T + 900)]),
    tu('t5', [stu('C', T + 100), stu('B', T + 240), stu('A', T + 500)], { trip: { direction_id: 1 } }),
    tu('t2', [stu('B', T - 400), stu('C', T - 200)]),                           // déjà passé
    tu('t7', [stu('B', T + 3 * 3600)], { trip: { route_id: 'R2' } }),            // trop loin
  ] };
  const d = departuresFromTripUpdates([feed], ix, new Set(['B']), T);
  assert.deepEqual(d.map((x) => [x.line, x.headsign, x.time - T]), [['B', 'Berges', 240], ['B', 'France Alouette', 700]]);
  assert.deepEqual(departuresFromTripUpdates([feed], ix, new Set(['C']), T).map((x) => x.headsign), ['Berges'], 'personne ne monte au terminus');
});

// --- service -----------------------------------------------------------------------------
function banc({ entry, feeds, statique = net }) {
  let horloge = T * 1000, lectures = [], construit = 0;
  const catalogue = { get: async (id) => (id === entry.id ? entry : null), forCity: async (c) => (c === 'fr:33063' ? [entry] : []) };
  const fetcher = async (url) => {
    const u = String(url); lectures.push(u);
    const r = feeds[u];
    if (!r) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    const v = typeof r === 'function' ? r() : r;
    if (v.status) return { ok: false, status: v.status, headers: new Map([['location', v.location]]), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(v)).buffer };
  };
  let pret = null;
  const nets = createNetworks({ catalogue, fetcher, now: () => horloge, build: async () => { construit++; pret = statique; }, readNet: () => pret });
  return { nets, lectures, avancer: (ms) => { horloge += ms; }, construit: () => construit };
}
const ENTRY = { id: 'tbm', name: 'TBM', title: 'Réseau urbain et scolaire TBM', page: 'https://exemple.test/tbm', licence: 'fr-lo', positions: true, gtfs: [{ url: 'https://exemple.test/tbm.zip' }],
  rt: [{ url: 'https://exemple.test/vp', features: ['vehicle_positions'] }, { url: 'https://exemple.test/tu', features: ['trip_updates'] }, { url: 'https://exemple.test/al', features: ['service_alerts'] }] };

test('service : positions lues une fois par fenêtre, statique préparé derrière', async () => {
  const b = banc({ entry: ENTRY, feeds: {
    'https://exemple.test/vp': { header: { timestamp: T }, entity: [vp('v1', 44.825, -0.57)] },
    'https://exemple.test/tu': { header: { timestamp: T }, entity: [tu('t1', [stu('B', T + 60), stu('C', T + 200)])] },
  } });
  let r = await b.nets.vehicles('tbm');
  assert.equal(r.vehicles.length, 1);
  assert.equal(r.nature, 'gps');
  await b.nets._instances.get('tbm').building;
  r = await b.nets.vehicles('tbm');
  assert.deepEqual([r.network.static, r.vehicles[0].line, r.vehicles[0].age_s], ['ok', 'B', 20]);
  assert.deepEqual(b.lectures, ['https://exemple.test/vp'], 'ni les horaires ni les alertes ne sont lus pour afficher des positions ; et pas de seconde lecture avant vingt secondes');
  assert.equal(b.construit(), 1);
  const fiche = await b.nets.vehicle('tbm', 'v1');
  assert.deepEqual(fiche.stops.map((s) => s.name), ['Bravo', 'Charlie']);
  assert.equal(fiche.shapes.length, 2);
  assert.equal((await b.nets.vehicle('tbm', 'inconnu')).vehicle, null);
  const arret = await b.nets.stop('tbm', 'B');
  assert.deepEqual([arret.stop.name, arret.departures.length, arret.realtime], ['Bravo', 1, true]);
  assert.equal((await b.nets.stops('tbm', [44.81, -0.58, 44.835, -0.56])).total, 2, 'A et B ; pas la station mère');
  b.avancer(21_000);
  await b.nets.vehicles('tbm');
  assert.equal(b.lectures.filter((u) => u.endsWith('/vp')).length, 2);
  assert.equal(await b.nets.vehicles('nulle-part'), null);
});

test('service : sans positions publiées, estimation depuis les horaires ; un relais qui limite est ménagé', async () => {
  let refus = 1;
  const b = banc({ entry: { ...ENTRY, positions: false, rt: [{ url: 'https://exemple.test/tu', features: [] }] }, feeds: {
    'https://exemple.test/tu': () => (refus-- > 0 ? { status: 429 } : { header: { timestamp: T }, entity: [tu('t1', [stu('A', T - 60), stu('B', T + 60)])] }),
  } });
  let r = await b.nets.vehicles('tbm');
  assert.equal(r.vehicles.length, 0);
  assert.match(r.error, /ne répond pas/);
  b.avancer(30_000);
  await b.nets.vehicles('tbm');
  assert.equal(b.lectures.length, 1, 'après un 429, on attend plus d\'une minute');
  b.avancer(40_000);
  r = await b.nets.vehicles('tbm');
  assert.deepEqual([r.nature, r.vehicles.length, r.vehicles[0].estimated], ['estime', 1, true]);
});

test('service : une redirection vers la machine elle-même est refusée', async () => {
  const b = banc({ entry: { ...ENTRY, rt: [{ url: 'https://exemple.test/vp', features: ['vehicle_positions'] }] }, feeds: { 'https://exemple.test/vp': { status: 302, location: 'http://127.0.0.1:4730/api/secret' } } });
  const r = await b.nets.vehicles('tbm');
  assert.equal(r.vehicles.length, 0);
  assert.deepEqual(b.lectures, ['https://exemple.test/vp'], 'l\'adresse locale n\'est jamais demandée');
});

// --- routes --------------------------------------------------------------------------------
test('routes : identifiant contrôlé, ville hors de France, réseau inconnu', async () => {
  const routes = new Map();
  const app = { get: (path, ...h) => routes.set(path, h) };
  const networks = { forCity: async () => [{ id: 'tbm', name: 'TBM' }], vehicles: async (id) => (id === 'tbm' ? { vehicles: [] } : null), vehicle: async () => null, stops: async () => ({ stops: [] }), stop: async () => null };
  mountNetworks(app, { networks, ah: (fn) => fn, limit: { windowMs: 60_000, max: 3 } });
  const call = async (path, req) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const [garde, handler] = routes.get(path);
    let suite = false;
    garde({ headers: {}, socket: { remoteAddress: req.ip ?? '1.1.1.1' }, ...req }, res, () => { suite = true; });
    if (suite) await handler({ headers: {}, socket: {}, query: {}, params: {}, ...req }, res);
    return res;
  };
  assert.deepEqual((await call('/api/net/for', { query: { city: 'fr:33063' } })).body.networks, [{ id: 'tbm', name: 'TBM' }]);
  assert.match((await call('/api/net/for', { query: { city: 'geo:48.1:2.3' } })).body.note, /villes françaises/);
  assert.equal((await call('/api/net/:id/vehicles', { params: { id: '../../etc' }, ip: '2.2.2.2' })).code, 400);
  assert.equal((await call('/api/net/:id/vehicles', { params: { id: 'inconnu' }, ip: '2.2.2.2' })).code, 404);
  // Les identifiants du catalogue sont longs (Rennes : 147 caractères) : un long n'est pas « invalide ».
  assert.equal((await call('/api/net/:id/vehicles', { params: { id: 'versions-des-horaires-theoriques-des-lignes-de-bus-et-de-metro-du-reseau-star-dans-les-formats-gtfs-et-netex-ainsi-que-les-urls-dacces-au-gtfs-rt-1' }, ip: '3.3.3.3' })).code, 404);
  assert.equal((await call('/api/net/:id/stops', { params: { id: 'tbm' }, query: { bbox: '1,2,3' }, ip: '2.2.2.2' })).code, 400);
  assert.equal((await call('/api/net/:id/vehicles', { params: { id: 'tbm' }, ip: '2.2.2.2' })).code, 429, 'quatrième appel de la même adresse dans la minute');
});

// --- connecteur : « ville_transports » -------------------------------------------------------
import { createCityTools } from '../lib/tools-ville.mjs';

test('service : un arrêt se retrouve par son nom, quel que soit l\'accent ou « St »', async () => {
  const statique = buildNetwork([feedOf({ ...GTFS, 'stops.txt': GTFS['stops.txt'] + 'S1,St Nicolas,44.8250,-0.5700,0,\nS2,St Nicolas,44.8251,-0.5701,0,\nS3,Hôtel de Ville,44.8260,-0.57,0,\nS4,Hôtel de Police,44.8270,-0.57,0,\n' })]);
  const b = banc({ entry: ENTRY, feeds: { 'https://exemple.test/vp': { header: { timestamp: T }, entity: [] } }, statique });
  assert.equal(await b.nets.ready('tbm'), true);
  assert.deepEqual((await b.nets.findStops('tbm', 'saint-nicolas')).map((s) => s.name), ['St Nicolas'], 'deux quais voisins, un seul arrêt');
  assert.deepEqual((await b.nets.findStops('tbm', 'hotel')).map((s) => s.name), ['Hôtel de Ville', 'Hôtel de Police']);
  assert.deepEqual((await b.nets.findStops('tbm', 'ville hotel')).map((s) => s.name), ['Hôtel de Ville']);
  assert.deepEqual(await b.nets.findStops('tbm', 'poste'), [], '« st » n\'est pas remplacé au milieu d\'un mot');
  assert.equal(await b.nets.ready('inconnu'), null);
});

function outil(extra = {}) {
  const BORDEAUX = { id: 'fr:33063', name: 'Bordeaux', lat: 44.84, lon: -0.58, country: 'France', timezone: 'Europe/Paris', transport: 'osm' };
  const villes = new Map([BORDEAUX, { id: 'fr:31555', name: 'Toulouse', transport: 'tisseo' }, { id: 'fr:69123', name: 'Lyon', transport: 'osm' }, { id: 'geo:52.5:13.4', name: 'Berlin', transport: 'osm' }].map((p) => [p.id, p]));
  const b = banc({ entry: ENTRY, feeds: {
    'https://exemple.test/vp': { header: { timestamp: T }, entity: [vp('v1', 44.825, -0.57, { stop_id: 'B', current_status: 2 }), vp('v2', 44.835, -0.57), vp('v3', 44.83, -0.56, { trip: { trip_id: 't7', route_id: 'R2' } })] },
    'https://exemple.test/tu': { header: { timestamp: T }, entity: [tu('t1', [stu('A', T + 120), stu('B', T + 300), stu('C', T + 600)])] },
    ...extra.feeds,
  } });
  const cities = { get: async (id = 'fr:31555') => { if (villes.has(id)) return villes.get(id); throw new RangeError('Ville inconnue'); }, search: async () => [] };
  const tools = createCityTools({ cities, cityService: {}, cityContext: {}, profileCatalog: () => ({ categories: [] }), reseaux: b.nets, now: () => T * 1000 });
  return { t: tools.find((x) => x.name === 'ville_transports'), b, tools };
}

test('connecteur : véhicules par ligne, véhicules d\'une ligne, passages à un arrêt', async () => {
  const { t, tools } = outil();
  assert.ok(t, 'l\'outil existe quand le service des réseaux est fourni');
  assert.equal(createCityTools({ cities: {}, cityService: {}, cityContext: {}, profileCatalog: () => ({}) }).some((x) => x.name === 'ville_transports'), false, 'et pas sans lui');
  assert.equal(tools.length, 9);
  const lig = await t.handler({ ville: 'fr:33063', ligne: 'b' });
  assert.deepEqual([lig.reseau, lig.ligne, lig.mode, lig.vehicules.length], ['TBM', 'B', 'Tram', 2]);
  assert.match(lig.positions, /publiées par le réseau \(GPS\)/);
  assert.deepEqual([lig.vehicules[0].destination, lig.vehicules[0].prochain_arret, lig.vehicules[0].position_relevee_il_y_a_s], ['France Alouette', 'Bravo', 20]);
  const tout = await t.handler({ ville: 'fr:33063' });
  assert.deepEqual([tout.vehicules, tout.par_ligne.map((x) => `${x.ligne}:${x.vehicules}`).join(' ')], [3, 'B:2 23:1']);
  const rien = await t.handler({ ville: 'fr:33063', ligne: 'Z9' });
  assert.match(rien.note, /Aucun véhicule de la ligne « Z9 ».*Lignes qui roulent : 23, B/);
  const arr = await t.handler({ ville: 'fr:33063', arret: 'bravo' });
  assert.deepEqual([arr.arret.nom, arr.passages.length, arr.passages[0].ligne, arr.passages[0].destination, arr.passages[0].dans_min], ['Bravo', 1, 'B', 'France Alouette', 5]);
  await assert.rejects(t.handler({ ville: 'fr:33063', arret: 'Nulle part ailleurs' }), /Aucun arrêt « Nulle part ailleurs » sur le réseau TBM/);
});

test('connecteur : Toulouse, une ville sans temps réel, une ville étrangère — chaque cas est dit', async () => {
  const { t } = outil();
  await assert.rejects(t.handler({ ville: 'fr:31555' }), /outils Tisséo/);
  await assert.rejects(t.handler({ ville: 'fr:69123' }), /Aucun réseau de Lyon n'est publié au point d'accès national.*Rien n'est inventé/);
  await assert.rejects(t.handler({ ville: 'geo:52.5:13.4' }), /villes françaises/);
});
