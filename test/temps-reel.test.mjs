// Tests du temps réel « fin » : retards, sens de circulation, bus raté,
// trajets directs, départs jamais inventés, correspondances risquées,
// jour de service après minuit. Réseau factice, aucun accès extérieur.
import test from 'node:test';
import assert from 'node:assert/strict';

import { normDelay, indexRealtime } from '../lib/realtime.mjs';
import { pairTimes, mergeDepartures } from '../lib/schedules.mjs';
import { createRouter } from '../lib/router.mjs';
import { createTools, parisToEpoch, heure } from '../lib/tools.mjs';

// --- retards ----------------------------------------------------------------

test('normDelay : le retard de Tisséo décalé d\'un jour est ramené', () => {
  // Relevé réel à 00 h 39 : −87 578 s = −24 h + (−1 178 s).
  assert.equal(normDelay(-87578), -1178);
  assert.equal(normDelay(-86400 + 91), 91);
  assert.equal(normDelay(301), 301, 'un retard ordinaire (journée) est gardé tel quel');
  assert.equal(normDelay(-35), -35);
  assert.equal(normDelay(5 * 3600), null, 'au-delà de 3 h : course mal rattachée, on ne dit rien');
  assert.equal(normDelay(undefined), null);
});

test('indexRealtime : courses, véhicules et heures par quai, avec retard', () => {
  const rt = {
    header: { timestamp: 1000 },
    entity: [{
      id: 'TU:1',
      trip_update: {
        trip: { trip_id: 'T1', route_id: 'r:L10' }, vehicle: { id: '1353' }, timestamp: 990,
        stop_time_update: [
          { stop_sequence: 1, stop_id: 'A', arrival: { time: 1100, delay: -86400 + 60 }, departure: { time: 1160, delay: -86400 + 120 } },
          { stop_sequence: 2, stop_id: 'B', arrival: { time: 1500, delay: 90 } },
        ],
      },
    }],
  };
  const x = indexRealtime(rt);
  assert.equal(indexRealtime(rt), x, 'mémoïsé par flux');
  assert.equal(x.trips.get('T1').vehicleId, '1353');
  assert.equal(x.vehicles.get('r:L10|1353').trip_id, 'T1');
  const a = x.stopTimes.get('T1|A');
  assert.equal(a.d, 1160, 'au quai de départ, on garde l\'heure de DÉPART');
  assert.equal(a.delay, 120, 'et le retard du départ, ramené');
  assert.equal(a.ts, 990);
});

// --- appariement des courses --------------------------------------------------

test('pairTimes : deux rames qui se suivent ne sont pas confondues (métro)', () => {
  // Une rame toutes les 2 min, 12 min de trajet : « la première arrivée
  // après le départ » donnerait 2 min.
  const B = Array.from({ length: 30 }, (_, i) => 7 * 3600 + i * 120);
  const A = B.map((b) => b + 720);
  const pairs = pairTimes(B, A, 690); // estimation un peu courte
  assert.equal(pairs.length, 30);
  assert.ok(pairs.every(([b, a]) => a - b === 720), JSON.stringify(pairs.slice(0, 3)));
});

test('pairTimes : décalage de rang (courses injectées en ligne) et estimation imparfaite', () => {
  // 20 courses creuses (10 min) puis 8 de pointe (2 min), 12 min de trajet ;
  // 3 courses commencent entre les deux quais : 3 arrivées de plus, AVANT.
  const B = [...Array.from({ length: 20 }, (_, i) => 6 * 3600 + i * 600), ...Array.from({ length: 8 }, (_, i) => 9 * 3600 + 120 + i * 120)];
  const A = [6 * 3600 - 900, 6 * 3600 - 600, 6 * 3600 - 300, ...B.map((b) => b + 720)];
  const pairs = pairTimes(B, A, 600); // estimation trop courte de 2 min : ambiguë en pointe
  assert.equal(pairs.length, B.length);
  assert.ok(pairs.every(([b, a]) => a - b === 720), JSON.stringify(pairs.filter(([b, a]) => a - b !== 720)));
});

test('pairTimes : une course partielle (qui ne va pas jusqu\'à B) est écartée', () => {
  // Bus toutes les 20 min, 25 min de trajet ; la course de 7 h 20 s'arrête avant.
  const B = [7 * 3600, 7 * 3600 + 1200, 7 * 3600 + 2400];
  const A = [7 * 3600 + 1500, 7 * 3600 + 2400 + 1500];
  const pairs = pairTimes(B, A, 1500);
  assert.deepEqual(pairs.map(([b, a]) => a - b), [1500, 1500]);
  assert.deepEqual(pairs.map(([b]) => b), [B[0], B[2]]);
});

test('mergeDepartures : au terminus, le bus qui arrive n\'absorbe pas celui qui repart', () => {
  // Le bus qui arrive (sans temps réel) passe juste avant celui qui repart.
  const rt = [{ line: 'L10', destination: 'Fenouillet', time: 1000 }];
  const gtfs = [{ line: 'L10', destination: 'La Vache', time: 990 }, { line: 'L10', destination: 'Fenouillet', time: 960 }];
  const out = mergeDepartures(rt, gtfs);
  assert.equal(out.filter((d) => d.destination === 'Fenouillet').length, 1, JSON.stringify(out));
  assert.equal(out.filter((d) => d.destination === 'La Vache').length, 1);
});

// --- routeur : pas de départ inventé -------------------------------------------

function twoLines() {
  const st = { 'stop_point:P': { n: 'P', lat: 43.60, lon: 1.40 }, 'stop_point:Q': { n: 'Q', lat: 43.60, lon: 1.44 } };
  const rt = [{ route_id: 'rapide', short_name: 'R', type: '0' }, { route_id: 'lente', short_name: 'S', type: '3' }];
  const shape = [[43.60, 1.40], [43.60, 1.44]];
  const va = {
    rapide: [{ dir: '0', headsign: 'Q', stops: ['stop_point:P', 'stop_point:Q'], shape }],
    lente: [{ dir: '0', headsign: 'Q', stops: ['stop_point:P', 'stop_point:Q'], shape }],
  };
  return createRouter({ stops: st, variants: va, routes: rt });
}
const from = { stop_id: 'stop_point:P' }, to = { stop_id: 'stop_point:Q' };

test('router : une ligne sans aucun départ est écartée au profit d\'une autre', () => {
  const r = twoLines().journey(from, to, 1000, { nextDeparture: (id) => (id === 'rapide' ? null : 1900) });
  const ride = r.legs.find((l) => l.type === 'ride');
  assert.equal(ride.line, 'S', 'la ligne sans horaire n\'est pas proposée');
  assert.equal(ride.depart, 1900, 'et le départ est celui de l\'horaire, pas « tout de suite »');
  assert.equal(r.no_departure, undefined);
});

test('router : si plus rien n\'a d\'horaire, l\'étape le dit au lieu de partir « maintenant »', () => {
  const r = twoLines().journey(from, to, 1000, { nextDeparture: () => null });
  assert.equal(r.no_departure, true);
  assert.equal(r.legs.find((l) => l.type === 'ride').no_departure, true);
});

test('router : la nuit, le premier départ du matin est pris, avec une longue attente signalée', () => {
  const r = twoLines().journey(from, to, 1000, { nextDeparture: () => 1000 + 5 * 3600 });
  const ride = r.legs.find((l) => l.type === 'ride');
  assert.equal(ride.depart, 1000 + 5 * 3600);
  assert.equal(ride.long_wait, true);
});

test('router : l\'arrivée théorique est lue dans la grille quand on la connaît', () => {
  const r = twoLines().journey(from, to, 1000, { nextDeparture: () => 1300, scheduledArrival: () => 1300 + 777 });
  const ride = r.legs.find((l) => l.type === 'ride');
  assert.equal(ride.arrive, 2077);
  assert.equal(ride.arrive_scheduled, true);
});

// --- outils : sens, bus raté, trajets directs ---------------------------------

// Ligne L10 : La Vache ⇄ Fenouillet, par Borderouge. La Vache a deux quais
// (un par sens).
const T0 = parisToEpoch(2026, 9, 29, 7, 45);
const routes = [{ route_id: 'r:L10', short_name: 'L10', long_name: 'La Vache / Fenouillet', type: '3' }];
const stops = {
  'stop_point:LV1': { n: 'La Vache', lat: 43.6337, lon: 1.4351 },
  'stop_point:LV2': { n: 'La Vache', lat: 43.6338, lon: 1.4352 },
  'stop_point:BO1': { n: 'Borderouge', lat: 43.6400, lon: 1.4400 },
  'stop_point:BO2': { n: 'Borderouge', lat: 43.6401, lon: 1.4401 },
  'stop_point:FE1': { n: 'Fenouillet Ctre Cial', lat: 43.6926, lon: 1.4020 },
  'stop_point:FE2': { n: 'Fenouillet Ctre Cial', lat: 43.6927, lon: 1.4021 },
};
const variants = {
  'r:L10': [
    { dir: '0', headsign: 'Fenouillet Ctre Cial', stops: ['stop_point:LV1', 'stop_point:BO1', 'stop_point:FE1'] },
    { dir: '1', headsign: 'La Vache', stops: ['stop_point:FE2', 'stop_point:BO2', 'stop_point:LV2'] },
  ],
};
const routeById = new Map(routes.map((r) => [r.route_id, r]));
const modeOf = () => 'Bus';
const mid = parisToEpoch(2026, 9, 29, 0, 0);
const sec = (h, m) => h * 3600 + m * 60;
// Grille théorique (secondes depuis minuit, motif 0) : départs de La Vache
// toutes les 10 min, 26 min jusqu'à Fenouillet.
const dep0 = [sec(7, 25), sec(7, 35), sec(7, 43), sec(7, 55), sec(8, 5)];
const entries = {
  'stop_point:LV1': [{ route_id: 'r:L10', dir: '0', destination: 'Fenouillet Ctre Cial', perPat: { 0: dep0 } }],
  'stop_point:FE1': [{ route_id: 'r:L10', dir: '0', destination: 'Fenouillet Ctre Cial', perPat: { 0: dep0.map((x) => x + 1560) } }],
  'stop_point:LV2': [{ route_id: 'r:L10', dir: '1', destination: 'La Vache', perPat: { 0: [sec(7, 40), sec(7, 50)] } }],
  'stop_point:BO1': [{ route_id: 'r:L10', dir: '0', destination: 'Fenouillet Ctre Cial', perPat: { 0: dep0.map((x) => x + 480) } }],
  'stop_point:BO2': [{ route_id: 'r:L10', dir: '1', destination: 'La Vache', perPat: { 0: [sec(7, 47), sec(7, 57)] } }],
};
// Temps réel : la course de 7 h 45 part avec 3 min de retard (7 h 48) ; celle
// de 7 h 35 est partie à 7 h 38 ; un bus de l'autre sens arrive à La Vache.
const rtFeed = {
  header: { timestamp: T0 - 5 },
  entity: [
    { id: 'TU:a', trip_update: { trip: { trip_id: 'a', route_id: 'r:L10' }, vehicle: { id: '1360' }, timestamp: T0 - 5, stop_time_update: [
      { stop_sequence: 1, stop_id: 'stop_point:LV1', departure: { time: mid + sec(7, 38), delay: 180 } },
      { stop_sequence: 3, stop_id: 'stop_point:FE1', arrival: { time: mid + sec(8, 4), delay: 180 } },
    ] } },
    { id: 'TU:b', trip_update: { trip: { trip_id: 'b', route_id: 'r:L10' }, vehicle: { id: '1353' }, timestamp: T0 - 5, stop_time_update: [
      { stop_sequence: 1, stop_id: 'stop_point:LV1', departure: { time: mid + sec(7, 48), delay: -86400 + 300 } },
      { stop_sequence: 2, stop_id: 'stop_point:BO1', arrival: { time: mid + sec(7, 56), delay: 300 } },
      { stop_sequence: 3, stop_id: 'stop_point:FE1', arrival: { time: mid + sec(8, 14), delay: -86400 + 300 } },
    ] } },
    { id: 'TU:c', trip_update: { trip: { trip_id: 'c', route_id: 'r:L10' }, vehicle: { id: '1400' }, timestamp: T0 - 5, stop_time_update: [
      { stop_sequence: 2, stop_id: 'stop_point:BO2', arrival: { time: mid + sec(7, 47) } },
      { stop_sequence: 3, stop_id: 'stop_point:LV2', arrival: { time: mid + sec(7, 50), delay: 0 } },
    ] } },
  ],
};
function svcL10(extra = {}) {
  const gtfsAt = (stopId, t) => (entries[stopId] ?? []).flatMap((e) => e.perPat[0].map((x) => ({
    source: 'gtfs', route_id: e.route_id, dir: e.dir, line: 'L10', mode: 'Bus', destination: e.destination, time: mid + x, service_day: '20260929', stop_id: stopId,
  }))).filter((d) => d.time >= t).sort((a, b) => a.time - b.time);
  return {
    routes, stops, variants, routeById, modeOf,
    now: () => T0,
    searchStops: (q) => Object.entries(stops).filter(([, s]) => s.n.toLowerCase().startsWith(String(q).toLowerCase().slice(0, 5)))
      .map(([id, s]) => ({ id, name: s.n, lat: s.lat, lon: s.lon, kind: 'point', served: true })),
    nearestStopPoints: () => [],
    live: async () => ({ snap: { vehicles: [], alerts: [], perRoute: {}, rt_timestamp: T0 - 5 } }),
    liveOrNull: async () => ({ snap: { vehicles: [], alerts: [], perRoute: {}, rt_timestamp: T0 - 5 } }),
    // Comme le serveur : temps réel + théorique, fusionnés.
    departuresAt: (id, c, t) => {
      const group = Object.keys(stops).filter((k) => stops[k].n === stops[id].n);
      const rtd = [];
      for (const trip of indexRealtime(rtFeed).trips.values()) {
        const last = trip.stops[trip.stops.length - 1];
        for (const x of trip.stops) {
          if (!group.includes(x.id) || x.d < t) continue;
          rtd.push({ source: 'rt', route_id: trip.route_id, trip_id: trip.trip_id, stop_id: x.id, line: 'L10', mode: 'Bus', destination: stops[last.id].n, time: x.d, vehicle: trip.vehicleId });
        }
      }
      return mergeDepartures(rtd.sort((a, b) => a.time - b.time), group.flatMap((g) => gtfsAt(g, t)).sort((a, b) => a.time - b.time), 40);
    },
    scheduleAt: (stopId, t, n, h) => gtfsAt(stopId, t).filter((d) => d.time <= t + h).slice(0, n),
    scheduleEntries: (id) => entries[id] ?? [],
    patternsOn: (ymd) => (ymd === '20260929' ? [0] : []),
    rtIndex: () => indexRealtime(rtFeed),
    rideEstimate: () => 1500,
    track: () => [],
    ...extra,
  };
}
const tool = (tools, name) => tools.find((t) => t.name === name);

test('prochains_passages : « direction » écarte le bus qui revient, et le retard est détaillé', async () => {
  const r = await tool(createTools(svcL10()), 'prochains_passages').handler({ arret: 'La Vache', ligne: 'L10', direction: 'Fenouillet', nombre: 3 });
  assert.ok(r.passages.every((p) => p.destination === 'Fenouillet Ctre Cial'), JSON.stringify(r.passages));
  const first = r.passages[0];
  assert.equal(first.heure, '07:48');
  assert.equal(first.source, 'realtime');
  assert.equal(first.horaire_theorique, '07:43');
  assert.equal(first.retard_sec, 300, 'retard publié décalé d\'un jour, ramené');
  assert.equal(first.age_donnees_sec, 5);
  assert.equal(r.passages.filter((p) => p.horaire_theorique === '07:43').length, 1, 'la course suivie n\'apparaît pas une 2e fois en théorique');
  assert.equal(r.passages[1].source, 'gtfs');
  assert.equal(r.passages[1].heure, '07:55');
});

test('prochains_passages : au milieu de la ligne, « direction » garde un seul sens', async () => {
  const pp = tool(createTools(svcL10()), 'prochains_passages');
  const tous = await pp.handler({ arret: 'Borderouge', ligne: 'L10' });
  assert.ok(tous.passages.some((p) => p.destination === 'La Vache'), 'sans direction, les deux sens');
  const r = await pp.handler({ arret: 'Borderouge', ligne: 'L10', direction: 'Fenouillet' });
  assert.ok(r.passages.length >= 2);
  assert.ok(r.passages.every((p) => p.destination === 'Fenouillet Ctre Cial'), JSON.stringify(r.passages));
  assert.equal(r.passages[0].heure, '07:56');
  assert.equal(r.passages[0].horaire_theorique, '07:51');
});

test('prochains_passages : « direction » accepte aussi un arrêt situé plus loin', async () => {
  const r = await tool(createTools(svcL10()), 'prochains_passages').handler({ arret: 'La Vache', direction: 'Borderouge' });
  assert.ok(r.passages.length > 0);
  assert.ok(r.passages.every((p) => p.destination === 'Fenouillet Ctre Cial'), 'le bus qui arrive à La Vache ne va pas à Borderouge');
});

test('prochains_passages : le bus qui vient de partir est signalé (« bus raté »)', async () => {
  const r = await tool(createTools(svcL10()), 'prochains_passages').handler({ arret: 'La Vache', ligne: 'L10', direction: 'Fenouillet' });
  const gone = r.deja_partis[0];
  assert.equal(gone.heure, '07:38');
  assert.equal(gone.il_y_a_min, 7);
  assert.equal(gone.source, 'realtime');
  assert.match(gone.statut, /confirmé/);
  assert.ok(!r.deja_partis.some((x) => x.horaire_theorique === '07:35' && x.source === 'gtfs'), 'l\'horaire 07:35 est la course confirmée, pas un 2e départ');
  assert.ok(!r.deja_partis.some((x) => x.horaire_theorique === '07:43'), 'la course de 7 h 43 est en RETARD (7 h 48), pas partie');
  assert.match(r.resume, /^Le 07:38 est parti il y a ~7 min ; prochain à 07:48/);
});

test('prochains_passages_vers : ligne, sens et quais trouvés seuls, arrivée et retard', async () => {
  const r = await tool(createTools(svcL10()), 'prochains_passages_vers').handler({ depart: 'La Vache', arrivee: 'Fenouillet' });
  assert.deepEqual(r.lignes_directes, ['L10']);
  const [a, b] = r.trajets;
  assert.equal(a.depart, '07:48');
  assert.equal(a.arrivee, '08:14');
  assert.equal(a.source, 'realtime');
  assert.equal(a.retard_sec, 300);
  assert.equal(a.quai_montee, 'stop_point:LV1', 'le quai du bon sens');
  assert.equal(b.depart, '07:55');
  assert.equal(b.arrivee, '08:21', 'arrivée théorique appariée course par course');
  assert.equal(b.source, 'gtfs');
  assert.ok(!r.trajets.some((x) => x.depart === '07:43'), 'l\'horaire de la course suivie n\'est pas doublé');
  assert.equal(r.deja_partis[0].depart, '07:38');
  assert.match(r.resume, /parti il y a ~7 min ; prochain : L10 direction Fenouillet Ctre Cial à 07:48/);
});

test('prochains_passages_vers : sans ligne directe, on oriente vers l\'itinéraire', async () => {
  // Un arrêt qu'aucune ligne ne relie aux autres.
  const avecIsole = { ...stops, 'stop_point:ISO': { n: 'Isolé', lat: 43.75, lon: 1.55 } };
  const svc = svcL10({
    stops: avecIsole,
    searchStops: (q) => Object.entries(avecIsole).filter(([, x]) => x.n.toLowerCase().startsWith(String(q).toLowerCase().slice(0, 5)))
      .map(([id, x]) => ({ id, name: x.n, lat: x.lat, lon: x.lon, kind: 'point', served: true })),
  });
  const r = await tool(createTools(svc), 'prochains_passages_vers').handler({ depart: 'La Vache', arrivee: 'Isolé' });
  assert.equal(r.lignes_directes.length, 0);
  assert.match(r.note, /itineraire/);
});

test('prochains_passages_vers : même lieu au départ et à l\'arrivée, même refus que « itineraire »', async () => {
  await assert.rejects(tool(createTools(svcL10()), 'prochains_passages_vers').handler({ depart: 'Fenouillet', arrivee: 'Fenouillet' }), /même arrêt/);
});

test('jour de service : un 00:25 du service de la veille est signalé', async () => {
  const lundi = '20260928';
  const svc = svcL10({
    now: () => parisToEpoch(2026, 9, 29, 0, 20),
    scheduleEntries: (id) => (id === 'stop_point:LV1' ? [{ route_id: 'r:L10', dir: '0', destination: 'Fenouillet Ctre Cial', perPat: { 0: [sec(24, 25)] } }] : []),
    patternsOn: (ymd) => (ymd === lundi ? [0] : []),
    departuresAt: () => [{ source: 'gtfs', route_id: 'r:L10', dir: '0', stop_id: 'stop_point:LV1', line: 'L10', mode: 'Bus', destination: 'Fenouillet Ctre Cial', time: parisToEpoch(2026, 9, 29, 0, 25), service_day: lundi }],
    rtIndex: () => null,
  });
  const r = await tool(createTools(svc), 'prochains_passages').handler({ arret: 'La Vache' });
  assert.equal(r.passages[0].heure, '00:25');
  assert.equal(r.passages[0].jour_service, '2026-09-28');
  assert.equal(r.date, '2026-09-29');
});

test('jour de service : aussi pour un passage temps réel (horaire retrouvé par le retard)', async () => {
  const lundi = '20260928';
  const t = parisToEpoch(2026, 9, 29, 0, 20);
  const nuit = { header: { timestamp: t - 3 }, entity: [{ id: 'TU:n', trip_update: { trip: { trip_id: 'n', route_id: 'r:L10' }, timestamp: t - 3, stop_time_update: [
    { stop_sequence: 1, stop_id: 'stop_point:LV1', departure: { time: parisToEpoch(2026, 9, 29, 0, 27), delay: -86400 + 120 } },
    { stop_sequence: 3, stop_id: 'stop_point:FE1', arrival: { time: parisToEpoch(2026, 9, 29, 0, 53) } },
  ] } }] };
  const svc = svcL10({
    now: () => t,
    scheduleEntries: (id) => (id === 'stop_point:LV1' ? [{ route_id: 'r:L10', dir: '0', destination: 'Fenouillet Ctre Cial', perPat: { 0: [sec(24, 25)] } }] : []),
    patternsOn: (ymd) => (ymd === lundi ? [0] : []),
    rtIndex: () => indexRealtime(nuit),
    departuresAt: () => [{ source: 'rt', route_id: 'r:L10', trip_id: 'n', stop_id: 'stop_point:LV1', line: 'L10', mode: 'Bus', destination: 'Fenouillet Ctre Cial', time: parisToEpoch(2026, 9, 29, 0, 27) }],
  });
  const r = await tool(createTools(svc), 'prochains_passages').handler({ arret: 'La Vache' });
  assert.equal(r.passages[0].horaire_theorique, '00:25');
  assert.equal(r.passages[0].retard_sec, 120);
  assert.equal(r.passages[0].jour_service, '2026-09-28', 'le 00:25 du lundi, pas du mardi');
});

// --- itinéraire : provenance, correspondance risquée, aucun départ -----------------

test('itineraire : correspondance trop courte signalée, départ absent jamais inventé', async () => {
  const t0 = T0;
  const legs = [
    { type: 'ride', route_id: 'r:L10', line: 'L10', mode: 'Bus', from: 'La Vache', from_id: 'stop_point:LV1', to: 'Borderouge', to_id: 'stop_point:BO1', ready_at: t0, depart: t0 + 180, arrive: t0 + 600, seconds: 420, real: true, delay_s: 60, rt_ts: t0 - 8 },
    { type: 'ride', route_id: 'r:L10', line: 'L10', mode: 'Bus', from: 'Borderouge', from_id: 'stop_point:BO1', to: 'Fenouillet Ctre Cial', to_id: 'stop_point:FE1', ready_at: t0 + 600, depart: t0 + 660, arrive: t0 + 1500, seconds: 840, real: false, scheduled: true },
  ];
  const svc = svcL10({ journey: async () => ({ depart_at: t0, arrive_at: t0 + 1500, duration_s: 1500, transfers: 1, real: false, legs }) });
  const r = await tool(createTools(svc), 'itineraire').handler({ depart: 'La Vache', arrivee: 'Fenouillet' });
  const [a, b] = r.etapes;
  assert.equal(a.source, 'realtime');
  assert.equal(a.retard_sec, 60);
  assert.equal(a.age_donnees_sec, 8);
  assert.match(a.statut, /confirmé/);
  assert.equal(b.source, 'gtfs');
  assert.equal(b.marge_correspondance_min, 1);
  assert.match(b.correspondance_risquee, /Seulement 1 min/);
  assert.ok(r.alertes.some((x) => /Seulement 1 min/.test(x)));

  const sans = svcL10({ journey: async () => ({ depart_at: t0, arrive_at: t0 + 1500, duration_s: 1500, transfers: 0, real: false, no_departure: true,
    legs: [{ ...legs[1], ready_at: t0, depart: t0, arrive: t0 + 840, scheduled: false, no_departure: true }] }) });
  const r2 = await tool(createTools(sans), 'itineraire').handler({ depart: 'La Vache', arrivee: 'Fenouillet' });
  assert.equal(r2.etapes[0].depart, null);
  assert.equal(r2.etapes[0].statut, 'aucun départ disponible');
  assert.equal(r2.arriver_a, null, 'aucune heure d\'arrivée affirmée');
  assert.match(r2.fiabilite, /aucun départ connu/);
});

test('trajet_maintenant : résumé en une phrase et plan B sur la même ligne', async () => {
  const t0 = T0;
  const svc = svcL10({
    journey: async () => ({ depart_at: t0, arrive_at: mid + sec(8, 14), duration_s: mid + sec(8, 14) - t0, transfers: 0, real: true, legs: [
      { type: 'ride', route_id: 'r:L10', line: 'L10', mode: 'Bus', from: 'La Vache', from_id: 'stop_point:LV1', to: 'Fenouillet Ctre Cial', to_id: 'stop_point:FE1', ready_at: t0, depart: mid + sec(7, 48), arrive: mid + sec(8, 14), seconds: 1560, real: true, delay_s: 180, rt_ts: t0 - 5 },
    ] }),
  });
  const r = await tool(createTools(svc), 'trajet_maintenant').handler({ depart: 'La Vache', arrivee: 'Fenouillet' });
  assert.match(r.resume, /prenez bus L10 direction Fenouillet Ctre Cial à La Vache à 07:48 \(temps réel, retard de 3 min\)/);
  assert.match(r.resume, /arrivée vers 08:14/);
  assert.equal(r.si_vous_ratez_le_premier[0].depart, '07:55');
  assert.equal(r.si_vous_ratez_le_premier[0].arrivee_a_descente, '08:21');
  assert.deepEqual(r.perturbations, []);
  assert.equal(heure(t0), r.heure);
});

// --- terminus : l'heure de DÉPART, pas l'arrivée ---------------------------------
import { createModel } from '../lib/core.mjs';

test('passages temps réel : au terminus de départ, l\'heure annoncée est celle du départ', () => {
  // Relevé réel (L10, La Vache) : arrivée 07:47:53, départ 07:58:31.
  const m = createModel({ routes, stops, variants });
  const t = mid + sec(7, 45);
  const rt = { entity: [{ id: 'TU:x', trip_update: { trip: { trip_id: 'x', route_id: 'r:L10' }, stop_time_update: [
    { stop_sequence: 1, stop_id: 'stop_point:LV1', arrival: { time: mid + sec(7, 47) + 53 }, departure: { time: mid + sec(7, 58) + 31 } },
    { stop_sequence: 3, stop_id: 'stop_point:FE1', arrival: { time: mid + sec(8, 24) } },
  ] } }] };
  const d = m.collectDepartures(rt, t).get('stop_point:LV1')[0];
  assert.equal(heure(d.time), '07:58');
});

// --- perturbations appliquées aux outils (test sévère de ChatGPT, 02/10/2026) -------
// Le serveur lit les arrêts non desservis dans le texte des alertes ; les outils
// n'annoncent plus de passage à un quai fermé et ne proposent plus d'y monter.
const { parseDisruptions } = await import('../lib/perturbations.mjs');
const perturbe = (html) => {
  const dis = parseDisruptions([{ id: 'al1', title: 'L10 : Déviation', url: 'https://exemple.test/l10', routes: ['r:L10'], description: html }], { routeById, variants, stops, now: T0 });
  return svcL10({ disruptions: () => dis });
};
const DEVIATION = '<h1>🟠 Déviation ligne L10</h1><p><strong>Le mardi 29 septembre 2026</strong> : déviation ligne L10.<br />❌ <strong>Arrêts non desservis</strong><br /><em>Direction Fenouillet Ctre Cial</em> : <ul><li>Borderouge</li></ul>✔️ La ligne dessert ses autres arrêts.</p>';
const COUPURE = '<h1>🟠 Ligne L10 : arrêt partiel</h1><p><strong>Le mardi 29 septembre 2026 dès 05h00</strong> : la ligne L10 est interrompue entre Borderouge et Fenouillet.<br />❌ <strong>Arrêts non desservis</strong> : <ul><li>Borderouge</li><li>Fenouillet Ctre Cial</li></ul></p>';

test('perturbation : aucun passage annoncé à un arrêt non desservi, et la raison est dite', async () => {
  const sans = await tool(createTools(svcL10()), 'prochains_passages').handler({ arret: 'Borderouge', ligne: 'L10', direction: 'Fenouillet' });
  assert.ok(sans.passages.length > 0, 'sans perturbation, des passages');
  const r = await tool(createTools(perturbe(DEVIATION)), 'prochains_passages').handler({ arret: 'Borderouge', ligne: 'L10', direction: 'Fenouillet' });
  assert.deepEqual(r.passages, [], 'ni temps réel ni théorique à un quai fermé');
  assert.equal(r.deja_partis, undefined, 'et rien n\'y est « passé »');
  assert.equal(r.non_desservi[0].ligne, 'L10');
  assert.deepEqual(r.non_desservi[0].arrets_non_desservis, ['Borderouge']);
  assert.match(r.non_desservi[0].periode, /29 septembre/);
  assert.match(r.resume, /NON DESSERVI/);
  assert.match(r.note, /perturbation/);
  // L'autre sens n'est pas concerné : il garde ses passages.
  const retour = await tool(createTools(perturbe(DEVIATION)), 'prochains_passages').handler({ arret: 'Borderouge', ligne: 'L10', direction: 'La Vache' });
  assert.ok(retour.passages.length > 0, 'sens La Vache : desservi');
});

test('perturbation : un trajet direct ne monte ni ne descend à un arrêt fermé', async () => {
  const vers = tool(createTools(perturbe(DEVIATION)), 'prochains_passages_vers');
  const ferme = await vers.handler({ depart: 'La Vache', arrivee: 'Borderouge' });
  assert.deepEqual(ferme.trajets, []);
  assert.match(ferme.resume, /IMPOSSIBLE/);
  assert.deepEqual(ferme.perturbations[0].arrets_non_desservis, ['Borderouge']);
  // Déviation : le bus saute Borderouge et continue — La Vache → Fenouillet reste direct.
  const audela = await vers.handler({ depart: 'La Vache', arrivee: 'Fenouillet' });
  assert.ok(audela.trajets.length > 0, 'au-delà de l\'arrêt fermé, la ligne reste utilisable');
  assert.equal(audela.perturbations, undefined);
});

test('perturbation : une ligne coupée ne se traverse pas, même sur une course « temps réel »', async () => {
  const vers = tool(createTools(perturbe(COUPURE)), 'prochains_passages_vers');
  const r = await vers.handler({ depart: 'La Vache', arrivee: 'Fenouillet' });
  assert.deepEqual(r.trajets, [], 'la course temps réel « b » est écartée elle aussi');
  assert.match(r.resume, /L10 : trajet direct IMPOSSIBLE/);
  assert.match(r.perturbations[0].effet, /interrompue/);
});

test('perturbation : la fiche d\'arrêt et l\'outil « perturbations » disent ce qui est fermé et quand', async () => {
  const svc = perturbe(DEVIATION);
  const alerte = { id: 'al1', title: 'L10 : Déviation', description: DEVIATION, url: 'https://exemple.test/l10', routes: ['r:L10'] };
  const avecAlertes = { ...svc, live: async () => ({ snap: { vehicles: [], alerts: [alerte], perRoute: {}, rt_timestamp: T0 - 5 } }), liveOrNull: async () => ({ snap: { vehicles: [], alerts: [alerte], perRoute: {}, rt_timestamp: T0 - 5 } }) };
  const fiche = await tool(createTools(avecAlertes), 'arret').handler({ arret: 'Borderouge' });
  assert.equal(fiche.non_desservi[0].ligne, 'L10');
  assert.ok(fiche.prochains_passages.every((p) => p.destination !== 'Fenouillet Ctre Cial'), 'aucun passage vers Fenouillet');
  assert.deepEqual(fiche.perturbations[0].effets[0].arrets_non_desservis, ['Borderouge']);
  const p = await tool(createTools(avecAlertes), 'perturbations').handler({ ligne: 'L10' });
  assert.deepEqual(p.perturbations[0].effets[0].arrets_non_desservis, ['Borderouge']);
  assert.match(p.perturbations[0].effets[0].periode, /mardi 29 septembre/);
  assert.match(p.note, /APPLIQUÉS/);
});
