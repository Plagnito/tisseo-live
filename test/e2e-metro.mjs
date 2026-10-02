// Vérifie que les rames de métro théoriques s'affichent, se déplacent le long
// du tracé et sont bien signalées comme théoriques.
//
// Le métro n'a AUCUNE rame théorique après minuit : ce test démarre donc sa
// propre instance du serveur avec TISSEO_NOW forcé à 10h00 (heure de pointe
// du matin), sinon il dépendrait de l'heure de la machine.
// Lancement : node test/e2e-metro.mjs
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3131;
// 10h00 aujourd'hui : le métro roule, le flux RT aussi.
const d = new Date();
const REPLAY = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0).getTime() / 1000);
const URL = `http://localhost:${PORT}/`;

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
const shot = (n) => join(process.env.TEMP || '.', `tisseo-${n}.png`);

const fails = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails.push(m); };

// --- serveur dédié, horloge forcée -----------------------------------------
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TISSEO_NOW: String(REPLAY) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stderr = [];
child.stderr.on('data', (b) => stderr.push(String(b)));
const stop = () => { try { child.kill(); } catch { /* déjà mort */ } };
process.on('exit', stop);

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(URL + 'api/health');
      if (r.ok) return true;
    } catch { /* pas encore levé */ }
  }
  return false;
}
if (!await waitReady()) {
  console.error('le serveur de test n\'a pas démarré :\n' + stderr.join(''));
  process.exit(1);
}
console.log(`serveur de test sur le port ${PORT}, horloge forcée à ${new Date(REPLAY * 1000).toLocaleString('fr-FR')}\n`);

// --- 1. L'API renvoie bien des rames théoriques -----------------------------
const api = await (await fetch(URL + 'api/vehicles')).json();
const theo = api.vehicles.filter((v) => v.theoretical);
ok(theo.length > 0, `rames théoriques dans /api/vehicles (${theo.length})`);
// Le Téléo n'a pas plus de position temps réel que le métro : ses cabines sont théoriques aussi.
ok(theo.every((v) => v.mode === 'Métro' || v.mode === 'Téléo'), `elles sont toutes du métro ou du Téléo (${[...new Set(theo.map((v) => v.mode))].join(', ')})`);
ok(theo.filter((v) => v.on_route).length / theo.length > 0.9,
  `poser sur le tracé (${theo.filter((v) => v.on_route).length}/${theo.length} ; le reste n'a pas de tracé exploitable)`);
ok(theo.every((v) => v.remaining?.length), 'chacune liste ses arrêts restants');
ok(new Set(theo.map((v) => v.id)).size === theo.length, 'identifiants uniques');
ok(theo.every((v) => v.lat > 43.5 && v.lat < 43.7), 'coordonnées dans la région toulousaine');
ok(theo.every((v) => v.depart < v.arrivee), 'aucune course à l’envers dans le temps');
ok(api.vehicles.some((v) => !v.theoretical), 'les véhicules temps réel sont toujours là');
ok(new Set(theo.map((v) => v.route_id)).size >= 2, 'les deux lignes de métro roulent');

// --- 2. Cohérence entre deux appels ---------------------------------------
// L'horloge est volontairement figée à 10h00 : on ne peut donc PAS vérifier
// ici que les rames avancent (c'est fait par les tests unitaires de
// runToVehicle, qui interrogent la même course à des instants différents).
// On vérifie en revanche que l'ensemble est stable et cohérent.
const theo2 = (await (await fetch(URL + 'api/vehicles')).json()).vehicles.filter((v) => v.theoretical);
ok(new Set(theo2.map((v) => v.id)).size === theo2.length, 'aucun identifiant dupliqué au second appel');
const idsTheo = new Set(theo.map((v) => v.id));
ok(theo2.every((v) => idsTheo.has(v.id)), 'même jeu de rames d\'un appel à l\'autre');
// Cohérence géométrique : la position doit être proche du tracé de sa ligne.
const ecarts = [];
for (const v of theo) {
  const det = (await (await fetch(URL + `api/route-detail?route_id=${encodeURIComponent(v.route_id)}`)).json());
  const shape = det.variants.flatMap((x) => x.shape);
  let best = Infinity;
  for (let i = 0; i + 1 < shape.length; i++) {
    const kx = 111320 * Math.cos(v.lat * Math.PI / 180), ky = 110540;
    const ax = shape[i][1] * kx, ay = shape[i][0] * ky, bx = shape[i + 1][1] * kx, by = shape[i + 1][0] * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? (((v.lon * kx - ax) * dx + (v.lat * ky - ay) * dy) / l2) : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(v.lon * kx - (ax + t * dx), v.lat * ky - (ay + t * dy));
    if (d < best) best = d;
  }
  ecarts.push(best);
}
ok(Math.max(...ecarts) < 120, `toutes les rames sont sur leur ligne (max ${Math.round(Math.max(...ecarts))} m)`);

// --- 3. L'interface les affiche et les signale ------------------------------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

await page.click('#modes button[data-mode="metro"]');
await page.waitForTimeout(1200);
// Les 51 rames sont réparties sur tout le réseau : à l'échelle de la ville
// elles sont regroupées en bulles (c'est le comportement attendu du
// clustering). Pour cliquer dessus comme le ferait l'utilisateur, on zoome
// sur une rame.
const cibleZoom = await page.evaluate(() => {
  const v = visibleVehicles().find((x) => x.theoretical);
  if (!v) return null;
  map.setView([v.lat, v.lon], 15, { animate: false });
  return `${v.line} → ${v.destination}`;
});
await page.waitForTimeout(2500);
const vueMetro = await page.evaluate(() => ({
  theoriques: document.querySelectorAll('.leaflet-marker-icon .pill.theo').length,
  autres: document.querySelectorAll('.leaflet-marker-icon .pill:not(.theo)').length,
  compteur: document.getElementById('statVehicles')?.textContent,
}));
ok(!!cibleZoom, `ramage cadrée (${cibleZoom})`);
ok(vueMetro.theoriques > 0, `pastilles théoriques à l'écran (${vueMetro.theoriques})`);
ok(vueMetro.autres === 0, `le filtre métro masque les bus (${vueMetro.autres})`);
console.log(`     compteur « véhicules » : ${vueMetro.compteur}`);
await page.screenshot({ path: shot('metro') });
console.log(`     capture : ${shot('metro')}`);

// Fiche véhicule : le bandeau « théorique » doit être là.
const clic = await page.evaluate(() => {
  const m = [...markers.values()].find((x) => x.__paint?.[0]?.theoretical && x._icon);
  if (!m) return null;
  m.fire('click');
  return m.__paint[0].line;
});
await page.waitForTimeout(2000);
ok(!!clic, `fiche ouverte sur une rame de métro (${clic})`);
const fiche = await page.evaluate(() => {
  const box = document.getElementById('detail');
  return {
    visible: !box.classList.contains('hidden'),
    tag: !!box.querySelector('.theo-tag'),
    etapes: box.querySelectorAll('.step').length,
    position: box.querySelector('dl dd')?.textContent?.trim(),
  };
});
ok(fiche.visible, 'fiche du véhicule ouverte');
ok(fiche.tag, 'bandeau « théorique » affiché');
ok(fiche.etapes > 0, `arrêts restants listés (${fiche.etapes})`);
ok(/sur le tracé/.test(fiche.position || ''), `position annoncée comme sur le tracé (« ${fiche.position} »)`);
await page.screenshot({ path: shot('metro-fiche') });
console.log(`     capture : ${shot('metro-fiche')}`);

if (errors.length) { console.log('erreurs JS :', errors.slice(0, 3)); fails.push('erreurs JS'); }
await browser.close();
stop();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout est vert');
process.exit(fails.length ? 1 : 0);
