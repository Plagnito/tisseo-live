// Mode Ville sur une GRANDE ville, dans un vrai navigateur.
//
// Ce que ce test garde : le 02/10/2026, choisir Paris figeait la page (un
// téléphone ne répondait plus du tout, un ordinateur se bloquait deux secondes
// à chaque déplacement de la carte). Trois causes, toutes dans le navigateur :
// un formateur de dates reconstruit pour chaque séance de chaque événement, à
// chaque filtrage ; le filtrage refait trois fois par rendu ; et les milliers
// de marqueurs détruits puis recréés un par un à chaque catégorie reçue.
//
// La ville est FABRIQUÉE (les réponses de /api/city/* sont interceptées) : le
// test ne dépend ni d'OpenStreetMap ni d'OpenAgenda, et il est aussi gros que
// Paris à chaque passage. Le processeur est bridé quatre fois, comme un
// téléphone ordinaire.
//
// Autonome : lance son propre serveur sur un port libre.
//   node test/e2e-grande-ville.mjs
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

// --- la ville fabriquée ------------------------------------------------------------
const VILLE = { id: 'fr:99999', name: 'Grandville', lat: 47.2, lon: 2.4, country: 'France', country_code: 'FR', region: 'Banc', transport: 'osm', timezone: 'Europe/Paris' };
const SOURCE = { label: 'Banc d’essai', url: 'https://example.org/', license: 'aucune' };
const CATEGORIES = [
  ['bikes', 'Stations vélo', 'mobility', 'bike', '#55c9bc'], ['parking', 'Parkings', 'mobility', 'parking', '#79a9f4'],
  ['events', 'Événements', 'discover', 'calendar', '#f5bd71'], ['culture', 'Culture', 'discover', 'culture', '#bf9af1'],
  ['visits', 'À visiter', 'discover', 'landmark', '#edb09e'], ['food', 'Restaurants & cafés', 'discover', 'food', '#f19585'],
  ['parks', 'Parcs & jardins', 'discover', 'leaf', '#9ace83'], ['markets', 'Marchés', 'discover', 'market', '#e4ba7a'],
  ['sports', 'Sport', 'discover', 'sport', '#75b9c5'], ['libraries', 'Bibliothèques', 'daily', 'book', '#acb9f7'],
  ['services', 'Mairies & services', 'daily', 'building', '#9cb8c8'], ['water', 'Fontaines à boire', 'daily', 'water', '#7ec8f1'],
  ['toilets', 'Toilettes', 'daily', 'pin', '#c3b9b0'], ['works', 'Travaux & voirie', 'daily', 'works', '#f4ac69'],
  ['stops', 'Arrêts de transports', 'mobility', 'pin', '#79a9f4'],
].map(([id, label, group, icon, color]) => ({ id, label, group, icon, color, live: false, source: SOURCE }));
// Une seconde ville, minuscule et lointaine : en changeant de ville, rien de la première ne doit rester.
const BOURG = { id: 'fr:99998', name: 'Petitbourg', lat: 44.0, lon: 0.5, country: 'France', country_code: 'FR', region: 'Banc', transport: 'osm', timezone: 'Europe/Paris' };

// Générateur pseudo-aléatoire à graine : la ville est la même à chaque passage.
let graine = 20261002;
const alea = () => { graine = (graine * 1664525 + 1013904223) >>> 0; return graine / 2 ** 32; };
const point = () => ({ lat: VILLE.lat + (alea() - 0.5) * 0.09, lon: VILLE.lon + (alea() - 0.5) * 0.13 });
const jour = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const heure = (ms) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));
const H = 3600_000;
const maintenant = Date.now();
const aujourdhui = jour(maintenant);

function lieux(categorie, n) {
  return Array.from({ length: n }, (_, i) => ({
    ...point(), id: `${VILLE.id}:${categorie}:${i}`, city_id: VILLE.id, city: VILLE.name, category: categorie,
    name: `${categorie} ${i}`, subtitle: categorie, address: `${i} rue du Banc`, description: '', details: [],
    opening_hours: '', wheelchair: 'unknown', vegetarian: false, free_access: null, opening_state: 'unknown',
    source_url: SOURCE.url, source_label: SOURCE.label,
  }));
}
// 1 300 événements, 20 séances chacun : des passées de justesse, des séances
// d'aujourd'hui, de ce soir, de la semaine, et de plus tard.
function evenements(n) {
  return Array.from({ length: n }, (_, i) => {
    const decalage = Math.floor(alea() * 20) - 2; // premier jour : d'avant-hier à dans 17 jours
    const debutHeure = 8 + Math.floor(alea() * 14); // 8 h … 21 h (heure du banc)
    const duree = 1 + Math.floor(alea() * 5);
    const sessions = Array.from({ length: 20 }, (_, k) => {
      const begin = maintenant + (decalage + k * (1 + (i % 3))) * 24 * H + (debutHeure - 12) * H;
      return { begin: new Date(begin).toISOString(), end: new Date(begin + duree * H).toISOString() };
    }).filter((s) => jour(Date.parse(s.end)) >= aujourdhui);
    if (!sessions.length) return null;
    return {
      ...lieux('events', 1)[0], id: `${VILLE.id}:events:${i}`, name: `Événement ${i}`, sessions, tags: i % 4 ? [] : ['family'],
      start_date: jour(Date.parse(sessions[0].begin)), end_date: jour(Date.parse(sessions[sessions.length - 1].end)),
    };
  }).filter(Boolean);
}
const DONNEES = new Map(CATEGORIES.map((c) => [c.id, c.id === 'events' ? evenements(1300) : c.id === 'stops' ? [] : lieux(c.id, c.id === 'markets' ? 90 : 420)]));
const duBourg = (categorie) => (categorie === 'parks' ? [0, 1, 2].map((i) => ({ ...lieux('parks', 1)[0], id: `${BOURG.id}:parks:${i}`, city_id: BOURG.id, city: BOURG.name, name: `Square ${i}`, lat: BOURG.lat + i * 0.001, lon: BOURG.lon })) : []);
const total = [...DONNEES.values()].reduce((n, l) => n + l.length, 0);

// Référence indépendante du code de la page : jours formatés un par un.
const fin = (plus) => { const d = new Date(`${aujourdhui}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + plus); return d.toISOString().slice(0, 10); };
const attendu = (periode) => DONNEES.get('events').filter((p) => p.sessions.some((s) => {
  const b = jour(Date.parse(s.begin)), e = jour(Date.parse(s.end));
  if (periode === 'tonight') return b <= aujourdhui && e >= aujourdhui && Date.parse(s.end) > Date.now() && (e > aujourdhui || heure(Date.parse(s.end)) >= 18);
  return b <= fin(periode === 'week' ? 6 : 0) && e >= aujourdhui;
})).length;

// --- le banc -------------------------------------------------------------------
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const erreurs = [];
page.on('pageerror', (e) => erreurs.push(e.message));
const json = (route, corps) => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(corps) });
const villeDe = (route) => (new URL(route.request().url()).searchParams.get('city') === BOURG.id ? BOURG : VILLE);
await page.route('**/api/city/catalog**', (route) => json(route, { city: villeDe(route).name, profile: villeDe(route), categories: CATEGORIES, notice: 'Ville fabriquée pour le test.' }));
await page.route('**/api/cities/search**', (route) => json(route, { cities: [BOURG] }));
await page.route('**/api/city/places**', (route) => {
  const categorie = new URL(route.request().url()).searchParams.get('category');
  const ville = villeDe(route);
  return json(route, { category: categorie, source: SOURCE, status: 'ok', fetched_at: new Date().toISOString(), places: ville === BOURG ? duBourg(categorie) : DONNEES.get(categorie) || [], city_id: ville.id });
});
await page.route('**/api/city/weather**', (route) => json(route, { temperature_2m: 18, weather_code: 1, min: 12, max: 21, rain_probability: 10, fetched_at: new Date().toISOString(), timezone: 'Europe/Paris' }));
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.addInitScript(() => {
  window.__longues = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longues.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
});
const longues = async (remettre = true) => page.evaluate((r) => { const l = window.__longues.slice(); if (r) window.__longues.length = 0; return { n: l.length, total: l.reduce((a, x) => a + x, 0), pire: Math.max(0, ...l) }; }, remettre);
const compteur = async () => Number((await page.locator('#cityResultCount').innerText()).replace(/\D/g, ''));
const sourcesFinies = () => page.waitForFunction(() => { const c = [...document.querySelectorAll('#cityCategories .category-count')]; return c.length > 0 && !c.some((e) => e.textContent === '…'); }, null, { timeout: 60_000 });

// --- 1. lien direct vers la ville ---------------------------------------------------
const t0 = Date.now();
await page.goto(`${BASE}/?vue=ville&city=${VILLE.id}`, { waitUntil: 'domcontentloaded' });
await sourcesFinies();
await page.waitForTimeout(600);
const vue = await page.evaluate(() => ({ lat: map.getCenter().lat, lon: map.getCenter().lng, zoom: map.getZoom(), marqueurs: document.querySelectorAll('.city-pin, .city-cluster').length, titre: document.title }));
ok(Math.abs(vue.lat - VILLE.lat) < 0.01 && Math.abs(vue.lon - VILLE.lon) < 0.01, `un lien direct ouvre la carte SUR la ville (${vue.lat.toFixed(3)}, ${vue.lon.toFixed(3)})`);
ok(vue.marqueurs > 0, `les lieux sont dessinés sans avoir à bouger la carte (${vue.marqueurs} pastilles ou grappes)`);
ok(/Grandville/.test(vue.titre), 'la page porte le nom de la ville');

// --- 2. tout afficher : la page reste vivante -----------------------------------------
await longues();
await page.locator('#sidebarToggle').click();
await page.locator('#cityPresets [data-preset="all"]').click();
await sourcesFinies();
await page.waitForTimeout(800);
const tout = await longues();
const entete = await page.locator('#cityHeaderText').innerText();
ok(Number(entete.replace(/\D/g, '')) === total, `« Tout » affiche les ${total.toLocaleString('fr-FR')} lieux de la ville (${entete})`);
ok(tout.pire < 1500, `aucune tâche ne bloque la page plus d'une seconde et demie en affichant tout (pire : ${tout.pire} ms, processeur ÷4)`);
const dom = await page.evaluate(() => document.querySelectorAll('.leaflet-marker-icon').length);
ok(dom < 1500, `seul ce qui est à l'écran entre dans la page (${dom} marqueurs dessinés sur ${total})`);

// --- 3. se déplacer -----------------------------------------------------------------
await page.locator('#sidebarToggle').click();
await longues();
const t1 = Date.now();
for (let i = 0; i < 6; i++) {
  await page.evaluate((k) => { map.panBy([140 * (k % 2 ? -1 : 1), 90], { animate: false }); }, i);
  await page.waitForTimeout(250);
}
await page.evaluate(() => { map.setZoom(map.getZoom() - 2, { animate: false }); });
await page.waitForTimeout(900);
await page.evaluate(() => { map.setZoom(map.getZoom() + 3, { animate: false }); });
await page.waitForTimeout(900);
const bouger = await longues();
ok(bouger.total < 3000, `six déplacements et deux zooms bloquent la page ${bouger.total} ms en tout (moins de 3 s, processeur ÷4)`);
ok(bouger.pire < 1000, `aucun déplacement ne fige la page une seconde (pire : ${bouger.pire} ms)`);
ok(Date.now() - t1 < 15_000, `la page répond pendant qu'on se déplace (${Date.now() - t1} ms pour huit gestes)`);

// --- 4. les filtres de période disent la même chose qu'avant -----------------------------
await page.locator('#sidebarToggle').click();
await page.locator('#cityToday [data-today="events"]').click();
if (await page.locator('#cityInView').isChecked()) await page.locator('#cityInView').uncheck();
await page.waitForTimeout(300);
ok(await compteur() === attendu('today'), `« aujourd'hui » : ${await compteur()} événements (attendu ${attendu('today')})`);
await page.selectOption('#cityPeriod', 'week');
await page.waitForTimeout(300);
ok(await compteur() === attendu('week'), `« cette semaine » : ${await compteur()} événements (attendu ${attendu('week')})`);
await page.selectOption('#cityPeriod', 'tonight');
await page.waitForTimeout(300);
ok(await compteur() === attendu('tonight'), `« ce soir » : ${await compteur()} événements (attendu ${attendu('tonight')})`);
await page.selectOption('#cityPeriod', 'upcoming');
await page.waitForTimeout(300);
ok(await compteur() === DONNEES.get('events').length, `« à venir » : tous les événements (${await compteur()})`);
await page.selectOption('#cityEventTag', 'family');
await page.waitForTimeout(300);
ok(await compteur() === DONNEES.get('events').filter((p) => p.tags.includes('family')).length, `le filtre « en famille » s'applique (${await compteur()})`);
await page.selectOption('#cityEventTag', '');
const sorties = Number((await page.locator('#cityToday [data-today="events"]').innerText()).replace(/\D/g, ''));
ok(sorties === attendu('today'), `le bandeau du jour compte les mêmes sorties (${sorties})`);

// --- 5. chercher, ouvrir un lieu ------------------------------------------------------
await page.fill('#citySearch', 'Événement 12');
await page.waitForTimeout(500);
const trouves = await compteur();
ok(trouves >= 1 && trouves <= 111, `la recherche réduit la liste (${trouves} résultats pour « Événement 12 »)`);
await page.locator('#cityResults .city-result').first().click();
await page.locator('#cityDetail h3').waitFor({ timeout: 5000 });
ok(/Événement 12/.test(await page.locator('#cityDetail h3').innerText()), 'un clic dans la liste ouvre la fiche du lieu');
await page.locator('#cityDetailClose').click();
// Ouvrir une fiche a refermé la feuille (téléphone) : on la rouvre pour vider la recherche.
await page.locator('#sidebarToggle').click();
await page.fill('#citySearch', '');
await page.waitForTimeout(500);
await page.locator('#sidebarToggle').click();
// Un marqueur seul (pas une grappe) : au plus fort zoom, le regroupement est coupé.
await page.evaluate(() => { map.setZoom(18, { animate: false }); });
await page.waitForTimeout(900);
const epingles = await page.locator('.city-pin').count();
if (epingles) {
  await page.locator('.city-pin').first().click({ force: true });
  const ouverte = await page.locator('#cityDetail h3').waitFor({ timeout: 5000 }).then(() => true, () => false);
  ok(ouverte, 'un clic sur une pastille de la carte ouvre sa fiche (écouteur commun à tous les marqueurs)');
} else ok(true, 'aucune pastille isolée à ce zoom : clic sur la carte non vérifié');

// --- 6. changer de ville ne laisse rien de l'ancienne ---------------------------------------
await page.locator('#cityDetailClose').click().catch(() => {});
await page.locator('#sidebarToggle').click();
await page.locator('#cityPresets [data-preset="all"]').click();
await page.locator('#cityPickerTitle').click();
await page.fill('#cityNameSearch', 'Petitbourg');
await page.locator('#cityNameGo').click();
await page.locator('#cityChoices [data-city-choice="0"]').click();
await page.waitForFunction(() => /Petitbourg/.test(document.title), null, { timeout: 10_000 });
await sourcesFinies();
await page.waitForTimeout(600);
const bourg = await page.evaluate(() => ({ entete: document.getElementById('cityHeaderText').textContent, lat: map.getCenter().lat, marqueurs: document.querySelectorAll('.city-pin, .city-cluster').length }));
ok(/^3 /.test(bourg.entete) && Math.abs(bourg.lat - BOURG.lat) < 0.01 && bourg.marqueurs >= 1 && bourg.marqueurs <= 3, `la nouvelle ville n'affiche que ses lieux (${bourg.entete}, ${bourg.marqueurs} sur la carte)`);
const fantomes = await page.evaluate(async ([lat, lon]) => {
  map.setView([lat, lon], 14, { animate: false });
  await new Promise((r) => setTimeout(r, 700));
  return document.querySelectorAll('.city-pin, .city-cluster').length;
}, [VILLE.lat, VILLE.lon]);
ok(fantomes === 0, `aucun marqueur de l'ancienne ville ne reste sur la carte (${fantomes} à son emplacement)`);

ok(erreurs.length === 0, `aucune erreur de script${erreurs.length ? ' — ' + erreurs.join(' | ') : ''}`);
console.log(`(${Date.now() - t0} ms)`);
await browser.close();
arreter();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout passe.');
process.exit(fails.length ? 1 : 0);
