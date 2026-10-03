// Routes HTTP des réseaux d'autres villes : /api/net/…
//
// Le navigateur ne fournit jamais d'adresse : seulement l'identifiant d'un
// réseau du catalogue national. Ce sont les adresses du catalogue qui sont
// lues, après contrôle (voir publicUrl dans instance.mjs).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCatalogue } from './catalogue.mjs';
import { createNetworks } from './instance.mjs';
import { createBikes } from './velos.mjs';

// Les identifiants du catalogue sont des titres entiers mis en minuscules :
// celui de Rennes fait 149 caractères.
const ID = /^[a-z0-9][a-z0-9_-]{1,220}$/;

// Service complet, adossé à un dossier (data-net/ : régénérable, hors dépôt).
export function createNetworkService({ dir, script, walk = null, geocode = null, fetcher = fetch, now = Date.now, maxEnAttente = 6, maxSurDisque = 40 } = {}) {
  const fichier = (...p) => join(dir, ...p);
  const catalogue = createCatalogue({
    fetcher, now,
    load: () => (existsSync(fichier('catalogue.json')) ? JSON.parse(readFileSync(fichier('catalogue.json'), 'utf8')) : null),
    save: (x) => { mkdirSync(dir, { recursive: true }); writeFileSync(fichier('catalogue.json.tmp'), JSON.stringify(x)); renameSync(fichier('catalogue.json.tmp'), fichier('catalogue.json')); },
  });
  // Une préparation à la fois : chacune dézippe un GTFS entier. La file est
  // BORNÉE, et le disque aussi : quelqu'un qui demanderait un à un les deux cents
  // réseaux du catalogue ne doit ni occuper la machine dix minutes, ni la remplir.
  let file = Promise.resolve(), attente = 0;
  function faireDeLaPlace() {
    let dossiers = [];
    try { dossiers = readdirSync(dir).filter((d) => ID.test(d) && existsSync(fichier(d, 'net.json'))).map((d) => ({ d, t: statSync(fichier(d, 'net.json')).mtimeMs })); } catch { return; }
    dossiers.sort((a, b) => b.t - a.t);
    for (const { d } of dossiers.slice(maxSurDisque - 1)) { try { rmSync(fichier(d), { recursive: true, force: true }); } catch { /* occupé : au prochain passage */ } }
  }
  const build = (id, urls, quoi = 'net') => {
    if (attente >= maxEnAttente) { const e = new Error('trop de préparations en attente'); e.code = 'OCCUPE'; return Promise.reject(e); }
    attente++;
    const tache = file.then(() => new Promise((resolve, reject) => {
      faireDeLaPlace();
      const child = spawn(process.execPath, ['--max-old-space-size=1536', script, ...(quoi === 'plan' ? ['--plan'] : []), fichier(id), ...urls], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (b) => { if (err.length < 2000) err += String(b); });
      const garde = setTimeout(() => child.kill(), 5 * 60_000);
      child.on('error', (e) => { clearTimeout(garde); reject(e); });
      child.on('exit', (code) => { clearTimeout(garde); if (code === 0) resolve(); else reject(new Error(err.trim().split('\n').pop() || `préparation interrompue (${code})`)); });
    }));
    file = tache.catch(() => {}).finally(() => { attente--; });
    return tache;
  };
  const readNet = (id) => (ID.test(id) && existsSync(fichier(id, 'net.json')) ? JSON.parse(readFileSync(fichier(id, 'net.json'), 'utf8')) : null);
  const readPlan = (id) => (ID.test(id) && existsSync(fichier(id, 'plan.json')) ? JSON.parse(readFileSync(fichier(id, 'plan.json'), 'utf8')) : null);
  const networks = createNetworks({ catalogue, build, readNet, readPlan, walk, geocode, fetcher, now });
  // Vélos en libre-service : même catalogue, autre famille de données.
  networks.bikes = createBikes({ systemes: () => catalogue.bikes(), lieuDe: (insee) => catalogue.commune(insee), fetcher, now });
  return networks;
}

export function mountNetworks(app, { networks, ah, limit = { windowMs: 60_000, max: 300 } }) {
  // Garde-fou de débit par adresse : chaque appel peut déclencher une lecture amont.
  const hits = new Map();
  const garde = (req, res, next) => {
    const ip = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const t = Date.now();
    let e = hits.get(ip);
    if (!e || t - e.start > limit.windowMs) { e = { start: t, n: 0 }; hits.set(ip, e); }
    if (++e.n > limit.max) return res.status(429).json({ error: 'Trop de requêtes : réessayez dans une minute.' });
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start > limit.windowMs) hits.delete(k);
    next();
  };
  const reseau = (req, res) => {
    const id = String(req.params.id || '');
    if (!ID.test(id)) { res.status(400).json({ error: 'Identifiant de réseau invalide.' }); return null; }
    return id;
  };
  const inconnu = (res) => res.status(404).json({ error: 'Réseau inconnu du catalogue.' });

  app.get('/api/net/for', garde, ah(async (req, res) => {
    const city = String(req.query.city || '');
    if (!/^fr:[\dAB]{5}$/.test(city)) return res.json({ city, networks: [], note: 'Le temps réel des transports n\'est proposé que pour les villes françaises.' });
    try { res.json({ city, networks: await networks.forCity(city) }); }
    catch (e) { res.status(503).json({ city, networks: [], error: 'Le catalogue national des transports ne répond pas.' }); }
  }));
  app.get('/api/net/:id/vehicles', garde, ah(async (req, res) => {
    const id = reseau(req, res); if (!id) return;
    const r = await networks.vehicles(id);
    return r ? res.json(r) : inconnu(res);
  }));
  app.get('/api/net/:id/vehicle', garde, ah(async (req, res) => {
    const id = reseau(req, res); if (!id) return;
    const r = await networks.vehicle(id, String(req.query.vid || '').slice(0, 200));
    return r ? res.json(r) : inconnu(res);
  }));
  app.get('/api/net/:id/stops', garde, ah(async (req, res) => {
    const id = reseau(req, res); if (!id) return;
    const b = String(req.query.bbox || '').split(',').map(Number);
    if (b.length !== 4 || b.some((x) => !Number.isFinite(x)) || b[0] > b[2] || b[1] > b[3]) return res.status(400).json({ error: 'bbox attendu : sud,ouest,nord,est' });
    const r = await networks.stops(id, b);
    return r ? res.json(r) : inconnu(res);
  }));
  // --- itinéraires ---
  const ville = (req) => { const c = String(req.query.city || ''); return /^fr:[\dAB]{5}$/.test(c) ? c : null; };
  app.get('/api/net/:id/plan', garde, ah(async (req, res) => {
    const id = reseau(req, res); if (!id) return;
    const r = await networks.plan(id);
    return r ? res.json(r) : inconnu(res);
  }));
  app.get('/api/net/:id/suggest', garde, ah(async (req, res) => {
    const id = reseau(req, res); if (!id) return;
    const q = String(req.query.q ?? '').trim().slice(0, 120);
    if (q.length < 2) return res.json({ q, stops: [], places: [] });
    const r = await networks.suggest(id, q, ville(req));
    return r ? res.json(r) : inconnu(res);
  }));
  app.get('/api/net/:id/journey', garde, ah(async (req, res) => {
    const id = reseau(req, res); if (!id) return;
    // Un bout : ?from_stop=… (quai choisi), ?from_lat=…&from_lon=…&from_label=…, ou ?from=texte.
    const bout = (cote) => {
      const stop = req.query[`${cote}_stop`];
      if (stop) return { stop: String(stop).slice(0, 200) };
      const brut = [req.query[`${cote}_lat`], req.query[`${cote}_lon`]];
      const lat = Number(brut[0]), lon = Number(brut[1]);
      // « Number('') vaut 0 » : un champ vide ne doit pas devenir le point 0,0.
      if (brut.every((x) => x != null && String(x).trim() !== '') && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon, label: String(req.query[`${cote}_label`] ?? '').slice(0, 160) || undefined };
      return { text: String(req.query[cote] ?? '').slice(0, 200) };
    };
    const at = req.query.at != null && String(req.query.at).trim() !== '' ? Number(req.query.at) : null;
    const r = await networks.journey(id, { from: bout('from'), to: bout('to'), at, city: ville(req) });
    if (!r) return inconnu(res);
    return res.status(r.error ? (r.preparing ? 503 : 400) : 200).json(r);
  }));

  app.get('/api/net/:id/stop', garde, ah(async (req, res) => {
    const id = reseau(req, res); if (!id) return;
    const r = await networks.stop(id, String(req.query.stop_id || '').slice(0, 200));
    return r ? res.json(r) : inconnu(res);
  }));
}
