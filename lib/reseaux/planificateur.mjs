// Itinéraires sur le réseau d'une autre ville : le routeur de Toulouse, nourri
// du plan préparé depuis le GTFS de ce réseau (lib/reseaux/plan.mjs).
//
// Ce qui diffère de Toulouse, et qui est dit dans chaque réponse : les heures
// viennent des HORAIRES PUBLIÉS (théoriques), sauf pour les courses que le
// flux temps réel du réseau annonce ; les perturbations ne sont pas lues.
import { createRouter } from '../router.mjs';
import { loadSchedules, scheduleDepartures } from '../schedules.mjs';
import { createJourneyOpts } from '../journey-opts.mjs';
import { decorateJourney } from '../journey-geometry.mjs';
import { modeOf, distM } from './gtfs.mjs';

const plat = (x) => String(x ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\bste\b/g, 'sainte').replace(/\bst\b/g, 'saint').trim();
const STATION_M = 250; // deux quais de même nom à moins de cela forment une station

export function createPlanner(plan, { walk = null, now = () => Date.now() } = {}) {
  const { stops, variants, routes } = plan;
  const routeById = new Map(routes.map((r) => [r.route_id, r]));
  const router = createRouter({ stops, variants, routes });
  const schedules = loadSchedules(plan.schedules, { routeById, modeOf: (r) => modeOf(r?.type) });
  const opts = createJourneyOpts({ variants, schedules: () => schedules, now });

  // Lignes de chaque quai, puis stations : les quais de même nom et voisins.
  const lignesDe = new Map();
  for (const [routeId, list] of Object.entries(variants)) {
    const nom = routeById.get(routeId)?.short_name ?? routeId;
    for (const v of list) for (const id of v.stops) { let s = lignesDe.get(id); if (!s) lignesDe.set(id, s = new Set()); s.add(nom); }
  }
  const stations = [];        // { name, cle, ids, lat, lon, lines }
  const stationDe = new Map(); // quai → station
  {
    const parNom = new Map();
    for (const [id, s] of Object.entries(stops)) {
      if (!lignesDe.has(id)) continue;
      const cle = plat(s.n);
      let groupes = parNom.get(cle);
      if (!groupes) parNom.set(cle, groupes = []);
      let g = groupes.find((x) => distM(x.lat, x.lon, s.lat, s.lon) <= STATION_M);
      if (!g) { g = { name: s.n, cle, ids: [], lat: s.lat, lon: s.lon, lines: new Set() }; groupes.push(g); stations.push(g); }
      g.ids.push(id);
      for (const l of lignesDe.get(id)) g.lines.add(l);
      stationDe.set(id, g);
    }
    const ordre = (a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true });
    for (const g of stations) g.lines = [...g.lines].sort(ordre);
  }

  // Stations dont le nom répond à une saisie : le nom exact, celles qui
  // commencent ainsi, puis celles dont chaque mot commence un mot du nom. À
  // rang égal, la mieux desservie d'abord.
  function searchStops(q, max = 6) {
    const voulu = plat(q);
    if (voulu.length < 2) return [];
    const mots = voulu.split(' ');
    const out = [];
    for (const g of stations) {
      const rang = g.cle === voulu ? 0 : g.cle.startsWith(voulu) ? 1 : mots.every((m) => g.cle.split(' ').some((w) => w.startsWith(m))) ? 2 : -1;
      if (rang >= 0) out.push({ rang, g });
    }
    return out.sort((a, b) => a.rang - b.rang || b.g.lines.length - a.g.lines.length || a.g.cle.length - b.g.cle.length)
      .slice(0, max).map(({ rang, g }) => ({ id: g.ids[0], name: g.name, stop_ids: g.ids, lat: g.lat, lon: g.lon, lines: g.lines, exact: rang === 0 }));
  }
  // Tous les quais de la station d'un quai (les deux sens d'une ligne n'ont pas le même).
  const station = (stopId) => { const g = stationDe.get(stopId); return g ? { stop_ids: g.ids, label: g.name } : null; };
  const stopsNear = (lat, lon, radiusM) => router.stopsNear(lat, lon, radiusM);

  // from / to : { stop_ids, label } ou { lat, lon, label }.
  async function journey(from, to, at) {
    const out = router.journey(from, to, at, opts);
    if (out.error) return out;
    for (const leg of out.legs) if (leg.type === 'ride') leg.mode = modeOf(routeById.get(leg.route_id)?.type);
    await decorateJourney(out, { variants, stops, walk });
    out.theoretical = !out.real;
    out.schedules_until = plan.until;
    return out;
  }

  // Passages THÉORIQUES à des quais (les deux sens d'un arrêt), les plus proches d'abord.
  function departures(stopIds, t, max = 16) {
    const out = [];
    for (const id of stopIds) for (const d of scheduleDepartures(schedules, id, t, max)) out.push(d);
    const vus = new Set();
    return out.sort((a, b) => a.time - b.time)
      .filter((d) => { const k = `${d.route_id}|${d.dir}|${d.time}`; return vus.has(k) ? false : vus.add(k); })
      .slice(0, max)
      .map((d) => ({ line: d.line, route_id: d.route_id, mode: d.mode, color: d.color ? `#${d.color}` : null, text: d.text_color ? `#${d.text_color}` : null, long: null, headsign: d.destination || null, time: d.time, delay_s: null, trip_id: null, theoretical: true }));
  }

  return {
    journey, searchStops, station, stopsNear, departures,
    setFeed: (rt) => router.setFeed(rt),
    until: plan.until, from: plan.from, built_at: plan.built_at, bbox: plan.bbox, counts: plan.counts,
  };
}
