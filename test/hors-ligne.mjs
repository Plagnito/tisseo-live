// Le mode hors ligne tient-il vraiment la route ?
// On charge la page, on coupe le réseau, on recharge : si la carte et ses
// tracés sont toujours là, le cache du service worker fonctionne.
//
// Ce test a une raison d'être : la fonction était annoncée, écrite, et
// vérifiée à la seule lecture du code. En réalité /api/network n'était demandé
// qu'en mode tracés — donc, avec de bonnes tuiles, le cache de secours ne
// contenait rien et la coupure de réseau laissait une carte vide.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch { /* plus loin */ }
  const cache = join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  for (const dir of readdirSync(cache)) {
    const p = join(cache, dir, 'node_modules', 'playwright');
    if (existsSync(p)) return createRequire(import.meta.url)(p);
  }
  throw new Error('playwright introuvable dans le cache npx');
}

const { chromium } = loadPlaywright();
const URL = process.env.URL || 'http://localhost:4127/';
const b = await chromium.launch();
const ctx = await b.newContext();
const page = await ctx.newPage();

// 1. première visite : le service worker s'installe et remplit son cache
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15000);
const avant = await page.evaluate(async () => {
  const nom = await navigator.serviceWorker.getRegistration();
  const c = await caches.open('tisseo-geo-v1').catch(() => null);
  const cles = c ? (await c.keys()).map((r) => new URL(r.url).pathname) : [];
  return {
    sw: nom ? (nom.active ? 'actif' : 'installé') : 'AUCUN',
    cache: cles.length,
    entrees: cles.slice(0, 4),
  };
});
console.log('en ligne      :', JSON.stringify(avant));
const echecs = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) echecs.push(m); };

ok(avant.sw === 'actif', `service worker actif (${avant.sw})`);
ok(avant.cache > 0, `géométrie du réseau en cache (${avant.cache} entrée(s) : ${avant.entrees.join(', ')})`);

// 2. plus de réseau du tout
await ctx.setOffline(true);
console.log('reseau         : coupe');
await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('goto:', e.message.slice(0, 60)));
await page.waitForTimeout(18000);

const horsLigne = await page.evaluate(() => ({
  titre: document.title,
  carte: !!document.getElementById('map'),
  tracés: document.querySelectorAll('.leaflet-overlay-pane path').length,
  vehicules: document.querySelectorAll('.leaflet-marker-icon').length,
  bandeau: document.getElementById('liveText')?.textContent?.trim(),
  compteurLignes: document.getElementById('statLines')?.textContent?.trim(),
  banniere: document.getElementById('errorBox')?.textContent?.trim()
    || document.querySelector('.error, #error, [class*=error]')?.textContent?.trim() || '',
}));
console.log('hors ligne    :', JSON.stringify(horsLigne));
ok(horsLigne.carte, 'la page elle-même est servie hors ligne');
ok(horsLigne.tracés > 100, `le réseau est dessiné hors ligne (${horsLigne.tracés} tracés)`);
ok(horsLigne.vehicules === 0, 'aucun véhicule inventé hors ligne');
ok(!/\d{6,}\s*s/.test(horsLigne.bandeau || ''),
  `le bandeau ne montre pas un âge absurde (« ${horsLigne.bandeau} »)`);
ok(!/failed to fetch|NetworkError/i.test(horsLigne.banniere || ''),
  `pas de message technique en anglais dans l'interface (« ${(horsLigne.banniere || '').slice(0, 60)} »)`);

await page.screenshot({ path: join(process.env.TEMP || '.', 'tisseo-hors-ligne.png') });
console.log('  capture     :', join(process.env.TEMP || '.', 'tisseo-hors-ligne.png'));
await b.close();
console.log(echecs.length ? `\n${echecs.length} échec(s)` : '\nTout est vert');
process.exit(echecs.length ? 1 : 0);
