const CLIENT = 'ToulouseVille/1.0 (https://tisseo.plagnito.com/)';
export function cityPoint(lat, lon) {
  if (lat == null || lon == null || lat === '' || lon === '') return null;
  lat = Number(lat); lon = Number(lon);
  return Number.isFinite(lat + lon) && lat >= 43.35 && lat <= 43.9 && lon >= 1.05 && lon <= 1.85 ? { lat, lon } : null;
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
    weather() {
      return memo('weather', 15 * 60_000, async () => {
        const j = await request('https://api.open-meteo.com/v1/forecast?latitude=43.6047&longitude=1.4442&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Europe%2FParis&forecast_days=1');
        if (!j.current || !Number.isFinite(j.current.temperature_2m)) throw new Error('Météo indisponible');
        return { ...j.current, min: j.daily?.temperature_2m_min?.[0] ?? null, max: j.daily?.temperature_2m_max?.[0] ?? null, rain_probability: j.daily?.precipitation_probability_max?.[0] ?? null,
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
      if (Math.hypot((from.lat - to.lat) * 111, (from.lon - to.lon) * 80) > 20) throw new RangeError('Choisis une destination à moins de 20 km.');
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
  };
}
