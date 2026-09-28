// Lecture fine du flux GTFS-RT de Tisséo : retard de chaque passage, heure
// théorique correspondante, âge de la donnée, et index par course/véhicule.
//
// Le champ `delay` de Tisséo est DÉCALÉ D'UN JOUR : relevé le 29/09/2026 à
// 00 h 39, les 1 056 retards publiés valaient tous entre −24 h 24 min et
// −23 h 53 min. Ramené dans ±12 h, chaque « heure − retard » tombe à moins
// d'une minute d'un horaire théorique du GTFS (1 056 sur 1 056). On ne se
// fie donc qu'au retard RAMENÉ dans ±12 h, jamais à la valeur brute.

const DAY = 86400;

// Retard publié → retard réel en secondes (positif = en retard), ou null.
export function normDelay(delay) {
  if (!Number.isFinite(delay)) return null;
  const d = ((delay % DAY) + DAY + DAY / 2) % DAY - DAY / 2;
  // Au-delà de 3 h d'écart, ce n'est plus un retard mais une course mal
  // rattachée : on préfère ne rien dire.
  return Math.abs(d) <= 3 * 3600 ? d : null;
}

const cache = new WeakMap();

// Index d'un flux (mémoïsé par objet) :
//   trips    : trip_id -> { route_id, vehicle, ts, stops: [{ id, seq, t, d, delay }] (ordre du parcours) }
//   vehicles : "route_id|vehicule" -> même objet
//   stopTimes: "trip_id|stop_id" -> { t, d, delay, ts }
//   feedTs   : horodatage du flux
export function indexRealtime(rt) {
  if (!rt || typeof rt !== 'object') return null;
  const hit = cache.get(rt);
  if (hit) return hit;
  const trips = new Map();
  const vehicles = new Map();
  const stopTimes = new Map();
  for (const e of rt.entity ?? []) {
    const tu = e.trip_update;
    if (!tu) continue;
    const tripId = tu.trip?.trip_id ?? e.id;
    const routeId = tu.trip?.route_id ?? null;
    const ts = Number(tu.timestamp) || Number(rt.header?.timestamp) || null;
    const list = (tu.stop_time_update ?? [])
      .map((s) => {
        const t = s.arrival?.time ?? s.departure?.time ?? null;
        const d = s.departure?.time ?? s.arrival?.time ?? null;
        const delay = normDelay(s.departure?.delay ?? s.arrival?.delay);
        return { id: s.stop_id, seq: s.stop_sequence ?? 0, t, d, delay };
      })
      .filter((s) => s.t != null && s.id)
      .sort((a, b) => a.seq - b.seq || a.t - b.t);
    if (!list.length) continue;
    const trip = { trip_id: tripId, route_id: routeId, vehicle: tu.vehicle?.id ?? e.id, ts, stops: list };
    trips.set(tripId, trip);
    if (routeId) vehicles.set(`${routeId}|${trip.vehicle}`, trip);
    for (const s of list) stopTimes.set(`${tripId}|${s.id}`, { t: s.t, d: s.d, delay: s.delay, ts });
  }
  const out = { trips, vehicles, stopTimes, feedTs: Number(rt.header?.timestamp) || null };
  cache.set(rt, out);
  return out;
}

// Retard « courant » d'une course : celui du prochain arrêt à desservir
// (le dernier connu si la course est finie).
export function tripDelay(trip, now) {
  if (!trip) return null;
  const next = trip.stops.find((s) => s.t >= now - 30 && s.delay != null);
  if (next) return next.delay;
  const known = trip.stops.filter((s) => s.delay != null);
  return known.length ? known[known.length - 1].delay : null;
}
