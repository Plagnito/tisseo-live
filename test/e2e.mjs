// Vérification navigateur : la carte doit être une VRAIE carte, et le repli
// « tracés du réseau » doit prendre le relais quand plus aucun fond ne
// charge. Lance le serveur d'abord (npm start), puis : npm run test:e2e
//
// Playwright n'est pas une dépendance du projet ; on le résout depuis le
// cache npx de la machine s'il n'est pas installé localement.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch { /* on cherche plus loin */ }
  const cache = join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  if (!existsSync(cache)) throw new Error('playwright introuvable : npm i -D playwright');
  for (const dir of readdirSync(cache)) {
    const p = join(cache, dir, 'node_modules', 'playwright');
    if (existsSync(p)) return createRequire(import.meta.url)(p);
  }
  throw new Error('playwright introuvable dans le cache npx : npm i -D playwright');
}

const { chromium } = loadPlaywright();
const URL = process.env.URL || 'http://localhost:4127/';
// Tous les hôtes listés dans lib/tiles.mjs : il suffit d'en oublier un pour
// que le test passe à côté du but.
const TILE_HOSTS = /cartocdn\.com|openstreetmap\.org|openstreetmap\.fr|opentopomap\.org|arcgisonline\.com/;
const shot = (n) => join(process.env.TEMP || '.', `tisseo-${n}.png`);

const browser = await chromium.launch();
const fails = [];
const ok = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) fails.push(msg);
};

async function probe(label, { blockTiles = false, clickMapButton = false, wait = 4000 } = {}) {
  // serviceWorkers: 'block' — sinon le service worker de l'app récupère les
  // tuiles par lui-même et échappe à page.route(). Le cache est désactivé
  // pour la même raison (Chromium sert alors les tuiles depuis sa mémoire).
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  if (blockTiles) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.route('**/*', (r) => (TILE_HOSTS.test(r.request().url()) ? r.abort() : r.continue()));
  }

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(wait);
  if (clickMapButton) { await page.click('#btnMap'); await page.waitForTimeout(3000); }
  if (blockTiles) await page.waitForTimeout(20000); // laisse la chaîne de secours s'épuiser

  const info = await page.evaluate(() => ({
    leaflet: typeof window.L !== 'undefined',
    libM: typeof window.M?.predict === 'function' && typeof window.M.smoothSpeed === 'function',
    libIt: typeof window.IT?.pickVariantForVehicle === 'function',
    notiles: document.getElementById('map').classList.contains('notiles'),
    tuiles: document.querySelectorAll('.leaflet-tile-loaded').length,
    sources: [...new Set([...document.querySelectorAll('.leaflet-tile')].map((t) => t.src.split('/')[2]))],
    tracés: document.querySelectorAll('.leaflet-overlay-pane path').length,
    vehicules: document.querySelectorAll('.leaflet-marker-icon').length,
    banner: document.getElementById('liveText')?.textContent,
    toast: document.getElementById('toast')?.textContent,
  }));
  await page.screenshot({ path: shot(label) });
  console.log(`\n=== ${label} === ${JSON.stringify(info)}`);
  console.log(`    capture : ${shot(label)}`);
  if (errors.length) console.log('    erreurs JS :', errors.slice(0, 3));
  await ctx.close();
  return info;
}

// 1. Fond de carte réel : des tuiles chargées, et surtout pas un placeholder.
const carte = await probe('a-carte');
ok(carte.leaflet, 'Leaflet chargé depuis public/vendor');
// Si le pont vers lib/ est cassé, la carte se fige sans lever d'erreur
// visible : c'est le genre de panne qu'on ne voit qu'en regardant l'écran.
ok(carte.libM, 'logique de mouvement partagée chargée depuis lib/motion.mjs');
ok(carte.libIt, 'choix du sens partagé chargé depuis lib/itinerary.mjs');
ok(carte.tuiles > 4, `des tuiles chargées (${carte.tuiles})`);
// Combien de véhicules le flux annonce-t-il à cet instant ? Le nombre
// varie selon l'heure (le réseau est quasi vide la nuit) : on compare donc
// l'affichage à l'API plutôt que d'exiger un effectif.
const announced = (await (await fetch(URL + 'api/vehicles')).json()).vehicles.length;
ok(carte.vehicules > 0, `des véhicules affichés (${carte.vehicules}, l'API en annonce ${announced})`);
ok(carte.vehicules <= announced, 'on n\'invente pas de véhicules hors du flux');
ok(!carte.notiles, 'fond de carte actif');

// 2. Plus aucun fond ne répond : repli automatique sur les tracés.
const sansTuile = await probe('b-sans-tuiles', { blockTiles: true });
ok(sansTuile.notiles, 'repli automatique en mode tracés');
ok(sansTuile.tracés > 100, `réseau entier dessiné (${sansTuile.tracés} tracés)`);
ok(sansTuile.vehicules > 0, `véhicules toujours affichés sans tuile (${sansTuile.vehicules})`);

// 3. Bascule manuelle, sans aucune tuile.
const manuel = await probe('c-traces', { blockTiles: true, clickMapButton: true });
ok(manuel.notiles, 'mode tracés activable à la main');
ok(manuel.tracés > 100, `tracés présents (${manuel.tracés})`);

await browser.close();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout est vert');
process.exit(fails.length ? 1 : 0);
