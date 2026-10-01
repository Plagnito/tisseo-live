import { haversineM } from './core.mjs';
const CLIENT = 'ToulouseVille/1.0 (https://tisseo.plagnito.com/)';
export function cityPoint(lat, lon) {
  if (lat == null || lon == null || lat === '' || lon === '') return null;
  lat = Number(lat); lon = Number(lon);
  return Number.isFinite(lat + lon) && lat >= 43.35 && lat <= 43.9 && lon >= 1.05 && lon <= 1.85 ? { lat, lon } : null;
}
export function worldPoint(lat, lon) {
  if (lat == null || lon == null || String(lat).trim() === '' || String(lon).trim() === '') return null;
  lat = Number(lat); lon = Number(lon);
  return Number.isFinite(lat + lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
export function cityTourPoints(value) {
  if (typeof value !== 'string' || value.length > 350) return null;
  const entries = value.split(';');
  if (entries.length < 2 || entries.length > 6) return null;
  const points = entries.map((s) => { const parts = s.split(','); return parts.length === 2 ? worldPoint(...parts) : null; });
  if (points.some((p) => !p) || points.some((p, i) => i && p.lat === points[i - 1].lat && p.lon === points[i - 1].lon)) return null;
  return points;
}
export function decodePolyline(str) {
  const points = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    const next = () => {
      let shift = 0, result = 0, b;
      do { if (i >= str.length || shift > 30) throw new Error('Tracé invalide'); b = str.charCodeAt(i++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32);
      return result & 1 ? ~(result >> 1) : result >> 1;
    };
    lat += next(); lon += next(); points.push([lon / 1e6, lat / 1e6]);
  }
  return points;
}
export function createCityContext({ fetcher = fetch, now = Date.now, routingUrl = process.env.CITY_ROUTING_URL || 'https://valhalla1.openstreetmap.de' } = {}) {
  const cache = new Map(), pending = new Map();
  async function request(url, body) {
    const r = await fetcher(url, { signal: AbortSignal.timeout(25_000), headers: { Accept: 'application/json', 'User-Agent': CLIENT, 'X-Client-Id': 'toulouse-ville', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw new Error(`Source HTTP ${r.status}`);
    return r.json();
  }
  async function memo(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && now() < hit.until) { if (hit.error) throw hit.error; return hit.value; }
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      try {
        const value = await load(); cache.set(key, { value, until: now() + ttl }); return value;
      } catch (error) { cache.set(key, { error, until: now() + 30_000 }); throw error; }
      finally { pending.delete(key); while (cache.size > 64) cache.delete(cache.keys().next().value); }
    })();
    pending.set(key, task); return task;
  }
  return {
    weather(origin = { lat: 43.6047, lon: 1.4442 }) {
      return memo(`weather:${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}`, 15 * 60_000, async () => {
        const j = await request(`https://api.open-meteo.com/v1/forecast?latitude=${origin.lat}&longitude=${origin.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`);
        if (!j.current || !Number.isFinite(j.current.temperature_2m)) throw new Error('Météo indisponible');
        return { ...j.current, timezone: j.timezone, latitude: origin.lat, longitude: origin.lon, min: j.daily?.temperature_2m_min?.[0] ?? null, max: j.daily?.temperature_2m_max?.[0] ?? null, rain_probability: j.daily?.precipitation_probability_max?.[0] ?? null,
          fetched_at: new Date(now()).toISOString(), source: { label: 'Open-Meteo', url: 'https://open-meteo.com/', license: 'CC BY 4.0' } };
      });
    },
    isochrone(origin) {
      return memo(`iso:${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}`, 5 * 60_000, async () => {
        const j = await request(`${routingUrl}/isochrone`, { locations: [origin], costing: 'pedestrian', contours: [5, 10, 15].map((time) => ({ time })), polygons: true, denoise: .2, generalize: 10 });
        if (!Array.isArray(j.features) || j.features.length !== 3 || j.features.some((f) => !['Polygon', 'MultiPolygon'].includes(f.geometry?.type))) throw new Error('Zone à pied indisponible');
        return { type: 'FeatureCollection', features: j.features, origin, source: 'Valhalla / OpenStreetMap', notice: 'Zones estimées à pied sur le réseau de chemins. Vérifie le parcours et les conditions d’accès.' };
      });
    },
    async walk(from, to) {
      // Limite locale : pas de calcul de longue distance depuis cette carte.
      if (haversineM(from.lat,from.lon,to.lat,to.lon) > 20000) throw new RangeError('Choisis une destination à moins de 20 km.');
      const key = `walk:${from.lat},${from.lon}:${to.lat},${to.lon}`;
      return memo(key, 5 * 60_000, async () => {
        const j = await request(`${routingUrl}/route`, { locations: [from, to], costing: 'pedestrian', units: 'kilometers', directions_options: { language: 'fr-FR' } });
        if (j.trip?.status !== 0 || !j.trip.legs?.length || !Number.isFinite(j.trip.summary?.time)) throw new Error('Parcours à pied indisponible');
        return { duration_s: j.trip.summary.time, distance_m: Math.round(j.trip.summary.length * 1000),
          geometry: { type: 'LineString', coordinates: j.trip.legs.flatMap((l) => decodePolyline(l.shape)) },
          instructions: j.trip.legs.flatMap((l) => (l.maneuvers || []).map((m) => ({ text: m.instruction, distance_m: Math.round(m.length * 1000) }))),
          source: 'Valhalla / OpenStreetMap', notice: 'Durée estimée sur le réseau piéton ; accessibilité du parcours non garantie.' };
      });
    },
    tour(points) {
      if (!Array.isArray(points) || points.length < 2 || points.length > 6 || points.some((p) => !p || !worldPoint(p.lat, p.lon))) throw new RangeError('Choisis de deux à six points valides.');
      const length = points.slice(1).reduce((total, p, i) => total + haversineM(p.lat,p.lon,points[i].lat,points[i].lon)/1000, 0);
      if (length > 20) throw new RangeError('Prépare une balade de moins de 20 km entre les étapes.');
      return memo(`tour:${points.map((p) => `${p.lat},${p.lon}`).join(';')}`, 5 * 60_000, async () => {
        const j = await request(`${routingUrl}/route`, { locations: points.map((p) => ({ ...p, type: 'break' })), costing: 'pedestrian', units: 'kilometers', directions_options: { language: 'fr-FR' } });
        if (j.trip?.status !== 0 || j.trip.legs?.length !== points.length - 1 || !Number.isFinite(j.trip.summary?.time) || !Number.isFinite(j.trip.summary?.length)) throw new Error('Balade à étapes indisponible');
        const legs = j.trip.legs.map((leg, index) => {
          if (!Number.isFinite(leg.summary?.time) || !Number.isFinite(leg.summary?.length)) throw new Error('Tronçon incomplet');
          return { from: index, to: index + 1, duration_s: leg.summary.time, distance_m: Math.round(leg.summary.length * 1000), geometry: { type: 'LineString', coordinates: decodePolyline(leg.shape) }, instructions: (leg.maneuvers || []).map((m) => ({ text: m.instruction, distance_m: Math.round(m.length * 1000) })) };
        });
        return { points, legs, duration_s: j.trip.summary.time, distance_m: Math.round(j.trip.summary.length * 1000), geometry: { type: 'LineString', coordinates: legs.flatMap((l) => l.geometry.coordinates) }, source: 'Valhalla / OpenStreetMap', notice: 'Temps de marche estimé, hors pauses et visites. Accessibilité du parcours non garantie.' };
      });
    },
  };
}
