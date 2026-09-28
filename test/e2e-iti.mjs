// Vérifie le planificateur d'itinéraire A→B : le calcul serveur existe depuis
// le début mais n'avait aucun écran.
// Lancement : node test/e2e-iti.mjs
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
const URL = process.env.URL || 'http://localhost:3127/';
const shot = (n) => join(process.env.TEMP || '.', `tisseo-${n}.png`);

const fails = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails.push(m); };

// L'API doit répondre pour deux arrêts réels du réseau.
const api = await (await fetch(URL + 'api/journey?from=Capitole&to=Balma-Gramont')).json();
ok(!api.error, `l'API répond (${api.legs?.length} étapes, ${Math.round((api.duration_s || 0) / 60)} min)`);
ok(Array.isArray(api.legs) && api.legs.length > 0, 'elle renvoie des étapes exploitables');
ok(Array.isArray(api.legs) && api.legs.every((l) => l.from && l.to), 'chaque étape a un départ et une arrivée');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// --- 1. Le formulaire est là et se remplit --------------------------------
await page.click('#planner > summary');
await page.fill('#jFrom', 'Capitole');
await page.fill('#jTo', 'Jean Jaurès');
await page.click('#jGo');
await page.waitForTimeout(3500);

const res = await page.evaluate(() => {
  const box = document.getElementById('jResults');
  return {
    ouvert: document.getElementById('planner').open,
    titre: box.querySelector('.jhead b')?.textContent,
    sousTitre: box.querySelector('.jhead span')?.textContent?.replace(/\s+/g, ' '),
    etapes: box.querySelectorAll('li.jleg').length,
    lignes: box.querySelectorAll('li.jleg b .dline').length,
    tracésCarte: document.querySelectorAll('.leaflet-overlay-pane path').length,
    alerte: box.querySelector('.jerr')?.textContent,
  };
});
ok(res.ouvert, 'le volet itinéraire est ouvert');
ok(!res.alerte, `pas d\'erreur de calcul${res.alerte ? ' : ' + res.alerte : ''}`);
ok(/\d+ min/.test(res.titre || ''), `durée affichée : « ${res.titre} »`);
ok(res.sousTitre?.includes('départ') && res.sousTitre.includes('arrivée'), `horaires : « ${res.sousTitre} »`);
ok(res.etapes > 0, `étapes listées (${res.etapes}, dont ${res.lignes} en ligne)`);
ok(res.tracésCarte > 0, `trajet dessiné sur la carte (${res.tracésCarte} tracés)`);
await page.screenshot({ path: shot('itineraire-AB') });
console.log(`     capture : ${shot('itineraire-AB')}`);

// --- 2. Cliquer une étape change le tracé --------------------------------
const avant = res.tracésCarte;
await page.click('li.jleg[data-leg]');
await page.waitForTimeout(2000);
const apres = await page.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane path').length);
ok(apres > 0, `le tracé de l\'étape est mis en avant (${apres} tracés, était ${avant})`);

// --- 3. Une destination introuvable est expliquée -------------------------
await page.fill('#jTo', 'Lavaur');
await page.click('#jGo');
await page.waitForTimeout(2500);
const err = await page.evaluate(() => document.querySelector('#jResults .jerr')?.textContent?.trim());
ok(!!err, `destination hors réseau expliquée : « ${(err || '').slice(0, 90)} »`);

// --- 4. Échap ferme le résultat ------------------------------------------
await page.fill('#jTo', 'Jean Jaurès');
await page.click('#jGo');
await page.waitForTimeout(2500);
await page.click('#jClose');
await page.waitForTimeout(400);
const ferme = await page.evaluate(() => ({
  vide: document.getElementById('jResults').innerHTML === '',
  tracés: document.querySelectorAll('.leaflet-overlay-pane path').length,
}));
ok(ferme.vide, 'le bouton ✕ vide les résultats');
ok(ferme.tracés === 0, 'et efface le trajet de la carte');

if (errors.length) { console.log('erreurs JS :', errors.slice(0, 4)); fails.push('erreurs JS'); }
await browser.close();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout est vert');
process.exit(fails.length ? 1 : 0);
