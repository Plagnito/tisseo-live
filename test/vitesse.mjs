// Vérification manuelle de la vitesse mesurée dans l'inventaire.
// À lancer avec un serveur forcé à une heure de trafic, sinon tous les
// véhicules sont à l'arrêt et le test ne prouve rien :
//   $env:TISSEO_NOW="<epoch 10h00>" ; npm start ; node test/vitesse.mjs
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
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://localhost:4127/');
await p.waitForTimeout(12000);
await p.click('#statVehiclesBtn');
await p.waitForTimeout(1200);
const lire = () => p.evaluate(() => [...document.querySelectorAll('li.inv .spd')].map((e) => e.textContent.trim()));

const nums = (a) => a.map((s) => (s.match(/^(\d+) km\/h$/) ? Number(s.match(/^(\d+) km\/h$/)[1]) : 0));

const r = await lire();
console.log('exemples            :', JSON.stringify(r.slice(0, 10)));
const v1 = nums(r);
console.log('chiffrees           :', r.filter((s) => /km\/h/.test(s)).length, '/', r.length);
console.log('a l\'arret           :', r.filter((s) => s.includes('arrêt')).length);
console.log('max                 :', Math.max(...v1), 'km/h');
console.log('impossibles (>120)  :', v1.filter((v) => v > 120).length);

await p.waitForTimeout(40000);
const r2 = await lire();
const v2 = nums(r2);
console.log('change en direct ?  :', JSON.stringify(r) !== JSON.stringify(r2));
console.log('exemples 40 s apres :', JSON.stringify(r2.slice(0, 6)));
console.log('max apres           :', Math.max(...v2), 'km/h');
console.log('impossibles (>120)  :', v2.filter((v) => v > 120).length);
await b.close();
