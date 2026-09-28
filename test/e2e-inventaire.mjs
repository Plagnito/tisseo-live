// Vérifie les panneaux d'inventaire (lignes / véhicules) et la bascule de
// fond de carte au-delà du zoom natif du fournisseur.
// Lancement : node test/e2e-inventaire.mjs  (serveur déjà lancé sur 3127)
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
  throw new Error('playwright introuvable : npm i -D playwright');
}
const { chromium } = loadPlaywright();
const URL = process.env.URL || 'http://localhost:3127/';
const shot = (n) => join(process.env.TEMP || '.', `tisseo-${n}.png`);

const fails = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails.push(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

// --- 1. Compteur « véhicules » → liste de tous les véhicules en service ----
await page.click('#statVehiclesBtn');
await page.waitForTimeout(800);
const invVeh = await page.evaluate(() => {
  const box = document.getElementById('inventory');
  return {
    visible: !box.classList.contains('hidden'),
    titre: box.querySelector('h3')?.textContent,
    lignes: box.querySelectorAll('li.inv').length,
    avecPosition: [...box.querySelectorAll('li.inv .pos')].every((e) => /-?\d+\.\d{5}, -?\d+\.\d{5}/.test(e.textContent)),
    chipOn: document.getElementById('statVehiclesBtn').classList.contains('on'),
  };
});
ok(invVeh.visible, 'panneau « véhicules » ouvert au clic sur le compteur');
ok(/véhicule/.test(invVeh.titre || ''), `titre : « ${invVeh.titre} »`);
ok(invVeh.lignes > 10, `véhicules listés (${invVeh.lignes})`);
ok(invVeh.avecPosition, 'chaque véhicule affiche ses coordonnées');
ok(invVeh.chipOn, 'le compteur est marqué actif');
await page.screenshot({ path: shot('inventaire-vehicules') });
console.log(`     capture : ${shot('inventaire-vehicules')}`);

// --- 2. Cliquer un véhicule de la liste → fiche + itinéraire --------------
const clic = await page.evaluate(() => {
  const li = document.querySelector('li.inv');
  if (!li) return null;
  li.click();
  return li.textContent.replace(/\s+/g, ' ').slice(0, 60);
});
await page.waitForTimeout(2000);
const apresClic = await page.evaluate(() => ({
  fiche: !document.getElementById('detail').classList.contains('hidden'),
  itiner: document.querySelectorAll('.leaflet-overlay-pane path').length,
  selection: !!document.querySelector('.pill.sel'),
}));
ok(!!clic, `véhicule cliqué dans la liste (${clic})`);
ok(apresClic.fiche, 'fiche véhicule ouverte');
ok(apresClic.selection, 'pastille du véhicule mise en évidence');
ok(apresClic.itiner > 0, `itinéraire tracé sur la carte (${apresClic.itiner} tracés)`);

// --- 3. Compteur « lignes » → toutes les lignes, avec véhicules -----------
await page.click('#statLinesBtn');
await page.waitForTimeout(800);
const invLignes = await page.evaluate(() => {
  const box = document.getElementById('inventory');
  return {
    titre: box.querySelector('h3')?.textContent,
    lignes: box.querySelectorAll('li.inv').length,
    tags: [...box.querySelectorAll('.tagline')].map((t) => t.textContent.replace(/\s+/g, ' ')),
  };
});
ok(/Toutes les lignes/.test(invLignes.titre || ''), `titre : « ${invLignes.titre} »`);
ok(invLignes.tags.length >= 2, `répartition par mode : ${invLignes.tags.join(' · ')}`);
await page.screenshot({ path: shot('inventaire-lignes') });
console.log(`     capture : ${shot('inventaire-lignes')}`);

// --- 4. Clic sur une ligne de la liste de gauche → ses véhicules ----------
await page.click('#invClose');
await page.waitForTimeout(300);
await page.click('#lineList li.line-item b'); // le nom court, jamais le bouton favori
await page.waitForTimeout(1500);
const invLigne = await page.evaluate(() => {
  const box = document.getElementById('inventory');
  const noms = [...box.querySelectorAll('li.inv b')].map((b) => b.textContent);
  return {
    titre: box.querySelector('h3')?.textContent,
    lignes: noms.length,
    filtre: state.filterLine,
    memeLigne: noms.length > 0 && noms.every((n) => n === noms[0]),
  };
});
ok(invLigne.titre && /Ligne/.test(invLigne.titre), `panneau de la ligne : « ${invLigne.titre} »`);
ok(invLigne.memeLigne, 'tous les véhicules listés sont de la même ligne');
ok(invLigne.filtre != null, 'la ligne est filtrée sur la carte');
console.log(`     capture à venir : ${shot('inventaire-ligne')}`);
await page.screenshot({ path: shot('inventaire-ligne') });

// --- 5. Zoom au-delà du zoom natif : plus de « map data not available » ---
await page.click('#invClose');
await page.evaluate(() => map.setView([43.6047, 1.4442], 12, { animate: false }));
await page.waitForTimeout(1500);
const avantZoom = await page.evaluate(() => ({
  fond: state.baseId,
  natif: providerList()[baseIdx]?.max_native_zoom,
}));
await page.evaluate(() => map.setView([43.6047, 1.4442], 19, { animate: false }));
await page.waitForTimeout(4000);
const apresZoom = await page.evaluate(() => ({
  fond: state.baseId,
  zoom: map.getZoom(),
  tuilesChargees: document.querySelectorAll('.leaflet-tile-loaded').length,
  erreurTuile: document.querySelectorAll('.leaflet-tile-error').length,
}));
ok(apresZoom.tuilesChargees > 0, `des tuiles chargées au z${apresZoom.zoom} (${apresZoom.tuilesChargees})`);
ok(apresZoom.erreurTuile < apresZoom.tuilesChargees / 2, `peu de tuiles en erreur (${apresZoom.erreurTuile})`);
ok(apresZoom.fond !== avantZoom.fond || (apresZoom.zoom <= (avantZoom.natif ?? 19)),
  `fond adapté au zoom (${avantZoom.fond}@z${avantZoom.natif} → ${apresZoom.fond} au z${apresZoom.zoom})`);
await page.screenshot({ path: shot('zoom-19') });
console.log(`     capture : ${shot('zoom-19')}`);

if (errors.length) { console.log('erreurs JS :', errors.slice(0, 4)); fails.push('erreurs JS'); }
await browser.close();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout est vert');
process.exit(fails.length ? 1 : 0);
