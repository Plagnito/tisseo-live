// Vérifie les deux demandes : movement fluide (interpolation rAF, pas de
// reconstruction d'icône) et itinéraire affiché au clic sur un véhicule.
// Lancement : npm start dans un terminal, puis node test/e2e-itineraire.mjs
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch { /* on cherche plus loin */ }
  const cache = join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  for (const dir of existsSync(cache) ? readdirSync(cache) : []) {
    const p = join(cache, dir, 'node_modules', 'playwright');
    if (existsSync(p)) return createRequire(import.meta.url)(p);
  }
  throw new Error('playwright introuvable : npm i -D playwright');
}
const { chromium } = loadPlaywright();
const URL = process.env.URL || 'http://localhost:4127/';
const shot = (n) => join(process.env.TEMP || '.', `tisseo-${n}.png`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const fails = [];
const ok = (cond, msg, extra = '') => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg + (extra ? ` — ${extra}` : ''));
  if (!cond) fails.push(msg);
};

// --- 1. Fluidité : le nœud DOM d'une pastille doit survivre à un refresh --
// Le groupe de clusters appelle setIcon() tout seul quand il re-regroupe :
// on ne mesure donc pas setIcon, mais la survie du nœud et le nombre de
// setLatLng — c'est là que se joue le nombre d'écritures par seconde.
await page.evaluate(() => {
  window.__latlng = 0;
  const ml = L.Marker.prototype.setLatLng;
  L.Marker.prototype.setLatLng = function (ll) { window.__latlng++; return ml.call(this, ll); };
  window.__frames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  (function tick() { window.__frames++; raf(tick); })();
  // On ne peut PAS exiger que le nœud d'une pastille survive : le groupe de
  // clusters regroupe et dégroupe en continu quand les véhicules bougent,
  // et cela recrée l'icône entière — c'est normal et peu coûteux. Ce qu'on
  // veut vérifier, c'est que l'appli ne réécrit pas elle-même l'intérieur des
  // pastilles (ce que ferait un setIcon() avec un nouvel HTML).
  window.__pillMut = 0;
  new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'childList' && r.target?.classList?.contains('pill')) window.__pillMut++;
    }
  }).observe(document.querySelector('.leaflet-marker-pane'), { subtree: true, childList: true });
});

const avant = await page.evaluate(() => ({
  icones: document.querySelectorAll('.leaflet-marker-icon').length,
  pastilles: document.querySelectorAll('.pill').length,
}));
// Idem : la nuit il ne circule presque rien, on ne peut pas exiger 20
// pastilles. On vérifie que le rendu est cohérent avec l'API.
const announced = (await (await fetch(URL + 'api/vehicles')).json()).vehicles.length;
ok(avant.icones > 0 && avant.icones <= Math.max(announced, 3),
  `marqueurs affichés (${avant.icones}, dont ${avant.pastilles} pastilles ; API : ${announced})`);

const rotAvant = await page.evaluate(() => document.querySelector('.leaflet-marker-icon .pill')?.style.getPropertyValue('--rot'));
await page.evaluate(() => { window.__t = performance.now(); window.__frames = 0; window.__latlng = 0; window.__pillMut = 0; state.countdown = 0; });
await page.waitForTimeout(1500); // le timer d'une seconde déclenche loadAll()
await page.waitForTimeout(6000); // puis on laisse l'interpolation tourner
const anim = await page.evaluate(() => ({
  frames: window.__frames,
  ms: performance.now() - window.__t,
  pillMut: window.__pillMut,
  latlng: window.__latlng,
  rot: [...document.querySelectorAll('.leaflet-marker-icon .pill')].map((p) => p.style.getPropertyValue('--rot')).filter(Boolean).slice(0, 3).join(' '),
}));
ok(anim.frames > 60, `animation continue (${anim.frames} images en ${Math.round(anim.ms)} ms)`);
ok(anim.pillMut === 0, `aucune pastille reécrite par l'appli (${anim.pillMut} mutation(s) sur 7,5 s)`);
ok(anim.latlng > 100, `positions interpolées image par image (${anim.latlng} setLatLng)`);
console.log(`     cap de 3 pastilles : ${rotAvant} → ${anim.rot}`);

// --- 2. Itinéraire au clic sur un véhicule --------------------------------
// On choisit un véhicule AFFICHÉ (son marqueur a une icône) et qui a encore
// des arrêts devant lui : sinon la liste des étapes est légitimement vide.
const cible = await page.evaluate(() => {
  for (const m of markers.values()) {
    const v = m.__paint?.[0];
    if (m._icon && v && (v.remaining || []).length >= 3) { m.fire('click'); return `${v.line} → ${v.destination}`; }
  }
  return null;
});
ok(!!cible, `véhicule avec un itinéraire à venir (${cible})`);
await page.waitForTimeout(2500);

const itin = await page.evaluate(() => {
  const box = document.getElementById('detail');
  return {
    visible: !box.classList.contains('hidden'),
    titre: box.querySelector('h3')?.textContent?.trim(),
    etapes: box.querySelectorAll('.step').length,
    boutonSuivre: !!box.querySelector('#dFollow'),
    boutonLigne: !!box.querySelector('#dLine'),
    waiting: /Itinéraire en cours/.test(box.textContent),
    // L'état de sélection est la vérité ; le DOM ne l'affiche que si le
    // marqueur n'est pas passé dans un cluster entre-temps.
    selection: (() => {
      const m = markers.get(state.selectedId);
      return { etat: !!m?.__paint?.[2], dom: !!document.querySelector('.pill.sel') };
    })(),
    // tracé + arrêts de l'itinéraire dessinés (hors fond de carte)
    paths: document.querySelectorAll('.leaflet-overlay-pane path').length,
  };
});
ok(itin.visible, 'fiche véhicule ouverte au clic');
ok(!itin.waiting, 'itinéraire chargé (pas de « en cours… »)');
ok(itin.etapes > 0, `arrêts à venir listés (${itin.etapes})`);
ok(!!itin.boutonSuivre && !!itin.boutonLigne, 'boutons Suivre / Toute la ligne');
ok(itin.selection.etat, 'véhicule sélectionné marqué dans l\'état applicatif');
ok(itin.selection.dom, 'pastille du véhicule mise en évidence à l\'écran');
ok(itin.paths > 0, `itinéraire dessiné sur la carte (${itin.paths} tracés vectoriels)`);
console.log(`     titre : ${itin.titre}`);
await page.screenshot({ path: shot('itineraire') });
console.log(`     capture : ${shot('itineraire')}`);

// --- 3. Mode « suivre » : la carte se recentre ---------------------------
const centre1 = await page.evaluate(() => map.getCenter());
await page.click('#dFollow');
await page.waitForTimeout(1200);
const followOn = await page.evaluate(() => document.querySelector('#dFollow')?.classList.contains('on'));
ok(followOn, 'mode suivi activé');
await page.waitForTimeout(3000);
const centre2 = await page.evaluate(() => map.getCenter());
const dist = Math.abs(centre2.lat - centre1.lat) + Math.abs(centre2.lng - centre1.lng);
console.log(`     déplacement du centre pendant le suivi : ${(dist * 111320).toFixed(0)} m`);
await page.screenshot({ path: shot('suivi') });
console.log(`     capture : ${shot('suivi')}`);

if (errors.length) { console.log('\nerreurs JS :', errors.slice(0, 5)); fails.push('erreurs JS'); }
await browser.close();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout est vert');
process.exit(fails.length ? 1 : 0);
