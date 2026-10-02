// Transports en direct d'une AUTRE ville que Toulouse, dans un vrai navigateur.
//
// Ce que ce test garde : dans le mode Ville, une ville dont le réseau publie du
// temps réel montre ses véhicules sur la carte — à la couleur de leur ligne,
// au-dessus des lieux, avec une fiche (destination, arrêts à venir, tracé) —
// et dit si la position est publiée (GPS) ou estimée. Les arrêts apparaissent
// de près, avec leurs passages. Décocher retire tout ; une ville sans réseau
// connu ne montre rien, et rien de la ville précédente ne reste.
//
// Le réseau est FABRIQUÉ (les réponses de /api/net/* et /api/city/* sont
// interceptées) : le test ne dépend d'aucun flux réel.
//
// Autonome : lance son propre serveur sur un port libre.
//   node test/e2e-reseaux.mjs
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch { /* */ }
  const cache = join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  for (const dir of existsSync(cache) ? readdirSync(cache) : []) {
    const p = join(cache, dir, 'node_modules', 'playwright');
    if (existsSync(p)) return createRequire(import.meta.url)(p);
  }
  throw new Error('playwright introuvable');
}
const { chromium } = loadPlaywright();
const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const portLibre = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

const fails = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails.push(m); };

// --- deux villes fabriquées : l'une a un réseau, l'autre non --------------------------
const VILLE = { id: 'fr:99997', name: 'Réseauville', lat: 47.2, lon: 2.4, country: 'France', country_code: 'FR', region: 'Banc', transport: 'osm', timezone: 'Europe/Paris' };
const BOURG = { id: 'fr:99998', name: 'Petitbourg', lat: 44.0, lon: 0.5, country: 'France', country_code: 'FR', region: 'Banc', transport: 'osm', timezone: 'Europe/Paris' };
const SOURCE = { label: 'Banc d’essai', url: 'https://example.org/', license: 'aucune' };
const CATEGORIES = [['parks', 'Parcs & jardins', 'discover', 'leaf', '#9ace83'], ['events', 'Événements', 'discover', 'calendar', '#f5bd71'], ['works', 'Travaux & voirie', 'daily', 'works', '#f4ac69'], ['stops', 'Arrêts de transports', 'mobility', 'pin', '#79a9f4']]
  .map(([id, label, group, icon, color]) => ({ id, label, group, icon, color, live: false, source: SOURCE }));
// Un lieu posé EXACTEMENT sous le premier véhicule : le clic doit atteindre le véhicule.
const LIEU = { lat: VILLE.lat, lon: VILLE.lon, id: `${VILLE.id}:parks:0`, city_id: VILLE.id, city: VILLE.name, category: 'parks', name: 'Square du Banc', subtitle: 'parc', address: '', description: '', details: [], opening_hours: '', wheelchair: 'unknown', vegetarian: false, free_access: null, opening_state: 'unknown', source_url: SOURCE.url, source_label: SOURCE.label };

const RESEAU = { id: 'banc-reseau', name: 'BANC', title: 'Réseau urbain BANC', nature: 'gps', page: 'https://example.org/banc', licence: 'lov2' };
const maintenant = () => Math.floor(Date.now() / 1000);
let lectures = 0;
function vehicules() {
  lectures++;
  const t = maintenant();
  const liste = [
    // Le tram avance vers le nord à chaque lecture.
    { id: 'tram-1', label: null, lat: VILLE.lat + (lectures - 1) * 0.0008, lon: VILLE.lon, bearing: 0, speed_kmh: 24, line: 'B', route_id: 'R1', mode: 'Tram', color: '#e50040', text: '#ffffff', long: 'Tram B', headsign: 'France Alouette', trip_id: 't1', dir: 0, stop: 'Bravo', status: 'en route', ts: t - 12, age_s: 12, estimated: false },
    { id: 'bus-7', label: null, lat: VILLE.lat + 0.004, lon: VILLE.lon + 0.006, bearing: null, speed_kmh: null, line: '23', route_id: 'R2', mode: 'Bus', color: null, text: null, long: null, headsign: null, trip_id: 't7', dir: 0, stop: 'Charlie', status: 'en approche', ts: t, age_s: 0, estimated: true },
  ];
  // Le bus 31 ne roule que pendant les deux premières lectures.
  if (lectures <= 2) liste.push({ id: 'bus-9', label: null, lat: VILLE.lat - 0.004, lon: VILLE.lon - 0.006, bearing: 135, speed_kmh: 0, line: '31', route_id: 'R3', mode: 'Bus', color: '#00a98b', text: '#ffffff', long: null, headsign: 'Gare', trip_id: 't9', dir: 1, stop: null, status: null, ts: t - 30, age_s: 30, estimated: false });
  return { network: { ...RESEAU, static: 'ok' }, nature: 'gps', at: t, vehicles: liste };
}
const ARRETS = [{ id: 'A', name: 'Alpha', lat: VILLE.lat + 0.0007, lon: VILLE.lon + 0.0011 }, { id: 'B', name: 'Bravo', lat: VILLE.lat - 0.0006, lon: VILLE.lon - 0.0012 }];

// --- le banc ----------------------------------------------------------------------------
const port = await portLibre();
const BASE = `http://127.0.0.1:${port}`;
const serveur = spawn(process.execPath, ['server.mjs'], {
  cwd: racine, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TISSEO_DATA_USER: 'memoire' },
});
let journal = '';
serveur.stdout.on('data', (d) => { journal += d; });
serveur.stderr.on('data', (d) => { journal += d; });
const arreter = () => { try { serveur.kill(); } catch { /* */ } };
process.on('exit', arreter);
for (let i = 0; ; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* pas encore */ }
  if (i > 80 || serveur.exitCode != null) { console.error(journal); throw new Error('le serveur de test ne démarre pas'); }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const erreurs = [];
page.on('pageerror', (e) => erreurs.push(e.message));
await page.addInitScript(() => { window.__reseauPeriode = 1500; });
const json = (route, corps) => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(corps) });
const villeDe = (route) => (new URL(route.request().url()).searchParams.get('city') === BOURG.id ? BOURG : VILLE);
const demandes = { for: [], vehicles: 0, vehicle: [], stops: [], stop: [] };
await page.route('**/api/city/catalog**', (route) => json(route, { city: villeDe(route).name, profile: villeDe(route), categories: CATEGORIES, notice: 'Ville fabriquée pour le test.' }));
await page.route('**/api/cities/search**', (route) => json(route, { cities: [BOURG] }));
await page.route('**/api/city/places**', (route) => {
  const categorie = new URL(route.request().url()).searchParams.get('category');
  return json(route, { category: categorie, source: SOURCE, status: 'ok', fetched_at: new Date().toISOString(), places: villeDe(route) === VILLE && categorie === 'parks' ? [LIEU] : [], city_id: villeDe(route).id });
});
await page.route('**/api/city/weather**', (route) => json(route, { temperature_2m: 18, weather_code: 1, min: 12, max: 21, rain_probability: 10, fetched_at: new Date().toISOString(), timezone: 'Europe/Paris' }));
await page.route('**/api/net/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/api/net/for') { demandes.for.push(u.searchParams.get('city')); return json(route, { city: u.searchParams.get('city'), networks: u.searchParams.get('city') === VILLE.id ? [RESEAU] : [] }); }
  if (!u.pathname.startsWith(`/api/net/${RESEAU.id}/`)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Réseau inconnu du catalogue."}' });
  const quoi = u.pathname.split('/').pop();
  if (quoi === 'vehicles') { demandes.vehicles++; return json(route, vehicules()); }
  if (quoi === 'vehicle') {
    demandes.vehicle.push(u.searchParams.get('vid'));
    const t = maintenant();
    const v = vehicules().vehicles.find((x) => x.id === u.searchParams.get('vid')); lectures--;
    return json(route, { network: { ...RESEAU, static: 'ok' }, at: t, vehicle: v ?? null,
      stops: v?.id === 'tram-1' ? ['Bravo', 'Charlie', 'Delta', 'Écho', 'Foxtrot', 'Golf', 'Hôtel', 'India', 'Juliette'].map((name, i) => ({ name, lat: null, lon: null, time: t + 90 * (i + 1), delay_s: 0 })) : [],
      shapes: v?.id === 'tram-1' ? [[[VILLE.lat - 0.01, VILLE.lon], [VILLE.lat + 0.01, VILLE.lon]]] : [] });
  }
  if (quoi === 'stops') { demandes.stops.push(u.searchParams.get('bbox')); return json(route, { network: { ...RESEAU, static: 'ok' }, total: ARRETS.length, stops: ARRETS }); }
  if (quoi === 'stop') {
    demandes.stop.push(u.searchParams.get('stop_id'));
    const t = maintenant();
    return json(route, { network: { ...RESEAU, static: 'ok' }, at: t, realtime: true, stop: { ...ARRETS[0], quais: 2 },
      departures: [{ line: 'B', color: '#e50040', text: '#ffffff', mode: 'Tram', headsign: 'France Alouette', time: t + 130, delay_s: 0 }, { line: '23', color: null, text: null, mode: 'Bus', headsign: 'Hippodrome', time: t + 3 * 3600, delay_s: null }] });
  }
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
});

const etat = () => page.evaluate(() => ({
  boite: !document.getElementById('reseauBox').classList.contains('hidden'),
  label: document.getElementById('reseauLabel').textContent,
  note: document.getElementById('reseauEtat').textContent,
  coche: document.getElementById('reseauLive').checked,
  marqueurs: [...document.querySelectorAll('.rv-marker .rv')].map((e) => ({ ligne: e.textContent, est: e.classList.contains('est'), fleche: Boolean(e.querySelector('.rv-dir')), fond: getComputedStyle(e).backgroundColor })),
  traces: document.querySelectorAll('path.rv-shape').length,
  arrets: document.querySelectorAll('path.rv-stop').length,
  fiche: document.querySelector('.rv-card')?.innerText.replace(/\s+/g, ' ') ?? null,
}));
const centreDe = (selecteur, n = 0) => page.evaluate(([s, i]) => { const r = document.querySelectorAll(s)[i]?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, [selecteur, n]);

// --- 1. la ville a un réseau : ses véhicules apparaissent ----------------------------------
const t0 = Date.now();
await page.goto(`${BASE}/?vue=ville&city=${VILLE.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('.rv-marker').length >= 3, null, { timeout: 30_000 });
let e = await etat();
ok(e.boite && e.label === 'Transports en direct · BANC' && e.coche, `la ville annonce son réseau (« ${e.label} »)`);
ok(e.marqueurs.length === 3, `trois véhicules sur la carte (${e.marqueurs.map((m) => m.ligne).join(', ')})`);
ok(/3 véhicules · positions GPS publiées par le réseau/.test(e.note) && /Source/.test(e.note), `l'état dit combien, et d'où viennent les positions (« ${e.note} »)`);
const tram = e.marqueurs.find((m) => m.ligne === 'B'), bus = e.marqueurs.find((m) => m.ligne === '23');
ok(tram?.fond === 'rgb(229, 0, 64)' && tram.fleche && !tram.est, `le tram porte la couleur de sa ligne et son cap (${tram?.fond})`);
ok(bus?.est && !bus.fleche, 'une position ESTIMÉE se distingue (contour en tirets), sans cap inventé');
ok(demandes.for.length === 1 && demandes.for[0] === VILLE.id, `le réseau de la ville n'est demandé qu'une fois (${demandes.for.join(', ')})`);

// --- 2. le clic atteint le véhicule, même posé sur un lieu ---------------------------------
await page.waitForFunction(() => document.querySelectorAll('.city-pin, .city-cluster').length >= 1, null, { timeout: 15_000 });
const dessus = await page.evaluate(() => {
  const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
  const v = [...document.querySelectorAll('.rv-marker')].map(z), l = [...document.querySelectorAll('.leaflet-marker-icon:not(.rv-marker)')].map(z);
  return { min: Math.min(...v), max: Math.max(0, ...l), lieux: l.length };
});
ok(dessus.lieux >= 1 && dessus.min > dessus.max, `les véhicules sont au-dessus des lieux (rang ${dessus.min} contre ${dessus.max})`);
let c = await centreDe('.rv-marker');
const iTram = await page.evaluate(() => [...document.querySelectorAll('.rv-marker .rv')].findIndex((x) => x.textContent === 'B'));
c = await centreDe('.rv-marker', iTram);
await page.mouse.click(c.x, c.y);
await page.waitForFunction(() => /Bravo/.test(document.querySelector('.rv-card')?.innerText || '') && document.querySelectorAll('path.rv-shape').length > 0, null, { timeout: 10_000 }).catch(() => {});
e = await etat();
ok(/France Alouette/.test(e.fiche || '') && /Tram · BANC/.test(e.fiche), `la fiche du véhicule s'ouvre (${(e.fiche || '—').slice(0, 70)}…)`);
ok(/Bravo/.test(e.fiche || '') && /2 arrêts de plus, jusqu’à Juliette/.test(e.fiche), 'elle liste les arrêts à venir, et résume la suite');
ok(/Position GPS · il y a \d+ s/.test(e.fiche || ''), 'elle dit d\'où vient la position, et de quand');
ok(e.traces === 1, `le tracé de la ligne est dessiné (${e.traces})`);
ok(demandes.vehicle[0] === 'tram-1' && !(await page.evaluate(() => !document.getElementById('cityDetail').classList.contains('hidden'))), 'c\'est le véhicule qui a reçu le clic, pas le lieu dessous');

// --- 3. les positions se relisent : le tram avance, un bus rentre au dépôt -------------------
const avant = await page.evaluate(() => document.querySelectorAll('.rv-marker').length);
await page.waitForFunction(() => document.querySelectorAll('.rv-marker').length === 2, null, { timeout: 15_000 }).catch(() => {});
e = await etat();
ok(avant === 3 && e.marqueurs.length === 2 && !e.marqueurs.some((m) => m.ligne === '31'), `un véhicule qui ne roule plus quitte la carte (${e.marqueurs.map((m) => m.ligne).join(', ')})`);
ok(/2 véhicules/.test(e.note), `le compte suit (« ${e.note.slice(0, 40)}… »)`);
ok(/France Alouette/.test(e.fiche || ''), 'la fiche ouverte reste ouverte pendant les relectures');
const lat1 = await page.evaluate(() => Reseau.state().vehicles);
ok(lat1 === 2 && demandes.vehicles >= 3, `relectures régulières (${demandes.vehicles})`);

// --- 4. de près, les arrêts ; un arrêt donne ses passages -------------------------------------
ok(e.arrets === 0, 'de loin, pas d\'arrêts');
await page.evaluate(([lat, lon]) => { map.closePopup(); map.setView([lat, lon], 17, { animate: false }); }, [VILLE.lat, VILLE.lon]);
await page.waitForFunction(() => document.querySelectorAll('path.rv-stop').length === 2, null, { timeout: 10_000 }).catch(() => {});
e = await etat();
ok(e.arrets === 2 && e.traces === 0, `de près, les arrêts apparaissent ; fermer la fiche retire le tracé (${e.arrets} arrêts, ${e.traces} tracé)`);
c = await centreDe('path.rv-stop');
await page.mouse.click(c.x, c.y);
await page.waitForFunction(() => /France Alouette/.test(document.querySelector('.rv-card')?.innerText || ''), null, { timeout: 10_000 }).catch(() => {});
e = await etat();
ok(/Alpha/.test(e.fiche || '') && /B France Alouette dans 2 min/.test(e.fiche) && /23 Hippodrome \d\d:\d\d/.test(e.fiche), `la fiche de l'arrêt donne ses passages (${(e.fiche || '—').slice(0, 90)}…)`);
ok(demandes.stop[0] === 'A' || demandes.stop[0] === 'B', 'pour l\'arrêt cliqué');

// --- 5. décocher retire tout, et la préférence est gardée --------------------------------------
await page.evaluate(() => map.closePopup());
await page.locator('#reseauLive').click();
await page.waitForTimeout(400);
e = await etat();
ok(!e.coche && e.marqueurs.length === 0 && e.arrets === 0, 'décocher retire véhicules et arrêts');
const n = demandes.vehicles;
await page.waitForTimeout(3500);
ok(demandes.vehicles === n, `et plus rien n'est demandé au réseau (${demandes.vehicles - n} lecture de trop)`);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.getElementById('reseauBox').classList.contains('hidden'), null, { timeout: 20_000 });
await page.waitForTimeout(2500);
e = await etat();
ok(!e.coche && e.marqueurs.length === 0 && demandes.vehicles === n, 'le choix est retenu au rechargement : toujours rien');
ok(/publie la position de ses véhicules/.test(e.note), `la case dit ce que le réseau offre (« ${e.note.slice(0, 50)}… »)`);
await page.locator('#reseauLive').click();
await page.waitForFunction(() => document.querySelectorAll('.rv-marker').length >= 2, null, { timeout: 10_000 }).catch(() => {});
ok((await etat()).marqueurs.length >= 2, 'recocher ramène les véhicules');

// --- 6. le bouton « Arrêts » : hors de Toulouse, il reste dans la ville ---------------------------
await page.locator('#viewTransport').click();
await page.waitForTimeout(700);
const bulle = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
ok(/en direct : BANC/.test(bulle), `« Arrêts » annonce le temps réel quand la ville a un réseau (« ${bulle} »)`);
ok((await etat()).marqueurs.length >= 2 && demandes.for.length === 2, `les véhicules restent, sans redemander le réseau (${demandes.for.length} demandes : une par chargement de page)`);

// --- 7. une ville sans réseau connu ---------------------------------------------------------------
await page.locator('#cityPickerTitle').click();
await page.fill('#cityNameSearch', 'Petitbourg');
await page.locator('#cityNameGo').click();
await page.locator('#cityChoices [data-city-choice="0"]').click();
await page.waitForFunction(() => /Petitbourg/.test(document.title), null, { timeout: 10_000 });
await page.waitForTimeout(1200);
e = await etat();
ok(!e.boite && e.marqueurs.length === 0, 'une ville sans réseau connu ne montre ni case ni véhicule');
const fantomes = await page.evaluate(async ([lat, lon]) => {
  map.setView([lat, lon], 15, { animate: false });
  await new Promise((r) => setTimeout(r, 2500));
  return document.querySelectorAll('.rv-marker, path.rv-stop, path.rv-shape').length;
}, [VILLE.lat, VILLE.lon]);
ok(fantomes === 0, `rien de la ville précédente ne reste, même à son emplacement (${fantomes})`);
ok(demandes.for.at(-1) === BOURG.id, 'le réseau de la nouvelle ville a bien été demandé');

ok(erreurs.length === 0, `aucune erreur de script${erreurs.length ? ' — ' + erreurs.join(' | ') : ''}`);
console.log(`(${Date.now() - t0} ms)`);
await browser.close();
arreter();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout passe.');
process.exit(fails.length ? 1 : 0);
