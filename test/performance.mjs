// Performance aux heures de pointe.
//
// Mesuré à 10 h : 415 véhicules, 6 images/s, fluide. Mais personne n'a mesuré
// l'heure de pointe du matin (7 h 30), où le réseau est deux fois plus dense,
// ni ce qui se passe quand l'utilisateur zoome à 40 et dézoome à 10.
//
// On mesure ce qui peut casser : le nombre d'images par seconde pendant que la
// carte bouge, la mémoire des pastilles, et le temps de réaction d'un clic.
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
const TMP = process.env.TEMP || '.';

const echecs = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) echecs.push(m); };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, locale: 'fr-FR' });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(16000);

const vehicules = await page.evaluate(() => Number(document.getElementById('statVehicles')?.textContent) || 0);
const reste = await page.evaluate(() => document.querySelectorAll('.leaflet-marker-icon').length);
console.log(`flotte affichée : ${vehicules} véhicules, ${reste} icônes à l'écran\n`);

// --- 1. Fluidité pendant un déplacement de carte -------------------------
async function mesurer(label, actions) {
  const r = await page.evaluate(async (mode) => {
    // `map` est un const de script classique : il vit dans la portée lexicale
    // globale, pas sur window. On le récupère par son identifiant, avec un
    // repli sur window pour rester robuste si le code change.
    const m = (typeof map !== 'undefined' && map) ? map : (window.map || null);
    let images = 0;
    let enMvt = true;
    const boucle = () => { images++; if (enMvt) requestAnimationFrame(boucle); };
    requestAnimationFrame(boucle);
    const t0 = performance.now();
    if (mode === 'zoom-out') {
      for (let i = 0; i < 12; i++) { m?.setZoom(m.getZoom() - 1); await new Promise((r) => setTimeout(r, 220)); }
    } else if (mode === 'zoom-in') {
      for (let i = 0; i < 10; i++) { m?.setZoom(m.getZoom() + 1); await new Promise((r) => setTimeout(r, 220)); }
    } else {
      const c = m.getCenter();
      for (let i = 0; i < 14; i++) {
        m.panTo({ lat: c.lat + (i % 2 ? 0.004 : -0.004), lng: c.lng + (i % 2 ? 0.006 : -0.006) });
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    enMvt = false;
    const duree = performance.now() - t0;
    return { images, duree, fps: images / (duree / 1000) };
  }, actions);
  console.log(`  ${label} : ${r.fps.toFixed(1)} im/s sur ${r.duree.toFixed(0)} ms`);
  return r;
}

console.log('fluidité :');
const depl = await mesurer('déplacement latéral', 'pan');
ok(depl.fps > 20, `déplacement fluide (${depl.fps.toFixed(1)} im/s, seuil 20)`);
const zoomOut = await mesurer('dézoom', 'zoom-out');
ok(zoomOut.fps > 20, `dézoom fluide (${zoomOut.fps.toFixed(1)} im/s, seuil 20)`);
const zoomIn = await mesurer('zoom', 'zoom-in');
ok(zoomIn.fps > 20, `zoom fluide (${zoomIn.fps.toFixed(1)} im/s, seuil 20)`);

// --- 1 bis. Le vrai pire cas : beaucoup de pastilles DÉGROUPÉES ---------
// À z12, les 425 véhicules sont regroupés en ~25 pastilles : l'animation est
// triviale. Le coût réel apparaît quand les 400 sont à l'écran et que chacune
// est repositionnée à chaque image.
const serre = await page.evaluate(async () => {
  const m = (typeof map !== 'undefined' && map) ? map : window.map;
  m.setView([43.6047, 1.4442], 15);
  await new Promise((r) => setTimeout(r, 3000));
  const icones = document.querySelectorAll('.leaflet-marker-icon').length;
  let images = 0;
  let actif = true;
  const boucle = () => { images++; if (actif) requestAnimationFrame(boucle); };
  requestAnimationFrame(boucle);
  const t0 = performance.now();
  for (let i = 0; i < 12; i++) {
    m.panBy([i % 2 ? 120 : -120, 0]);
    await new Promise((r) => setTimeout(r, 200));
  }
  actif = false;
  const duree = performance.now() - t0;
  return { icones, fps: images / (duree / 1000) };
});
console.log(`  pire cas (z15, ${serre.icones} pastilles dégroupées) : ${serre.fps.toFixed(1)} im/s`);
ok(serre.icones > 30, `le test mesure bien un cas chargé (${serre.icones} pastilles à l'écran)`);
ok(serre.fps > 20, `fluide même avec ${serre.icones} pastilles animées (${serre.fps.toFixed(1)} im/s, seuil 20)`);

// --- 2. Réaction d'un clic sur un véhicule -------------------------------
console.log('\nréactivité :');
const t = await page.evaluate(async () => {
  const avant = performance.now();
  document.getElementById('btnAllLines')?.click();
  await new Promise((r) => setTimeout(r, 600));
  const lignes = document.querySelectorAll('li.inv').length;
  return { ms: performance.now() - avant, lignes };
});
ok(t.ms < 2500, `ouverture de l'inventaire en ${Math.round(t.ms)} ms (${t.lignes} lignes)`);

const clic = await page.evaluate(async () => {
  const li = document.querySelector('li.inv');
  if (!li) return { ms: -1, fiche: false };
  const attendreFiche = () => {
    const d = document.getElementById('detail');
    return d && d.textContent.trim().length > 10;
  };
  const avant = performance.now();
  li.click();
  // On mesure le temps MIS POUR OUVRIR la fiche, pas le temps d'attente.
  for (let i = 0; i < 60 && !attendreFiche(); i++) await new Promise((r) => setTimeout(r, 50));
  return { ms: performance.now() - avant, fiche: attendreFiche() };
});
ok(clic.fiche && clic.ms < 2000, `fiche véhicule ouverte en ${Math.round(clic.ms)} ms`);

// --- 3. Mémoire des marqueurs -------------------------------------------
const mem = await page.evaluate(() => ({
  icones: document.querySelectorAll('.leaflet-marker-icon').length,
  noeuds: document.querySelectorAll('*').length,
}));
console.log(`\nDOM : ${mem.icones} icônes, ${mem.noeuds} nœuds au total`);
ok(mem.noeuds < 60000, `le DOM reste raisonnable (${mem.noeuds} nœuds)`);

// --- 4. Une actualisation de flux en charge ------------------------------
const maj = await page.evaluate(async () => {
  const avant = performance.now();
  const r = await fetch('/api/vehicles');
  // La taille se lit dans l'en-tête : relire le corps après .json() échoue.
  const octets = Number(r.headers.get('content-length')) || 0;
  const j = await r.json();
  return { ms: performance.now() - avant, octets, n: j.vehicles.length };
});
console.log(`API /api/vehicles : ${maj.ms.toFixed(0)} ms, ${(maj.octets / 1024).toFixed(0) || '?'} Ko, ${maj.n} véhicules`);
ok(maj.ms < 1500, `réponse de l'API sous 1,5 s (${maj.ms.toFixed(0)} ms)`);

await page.screenshot({ path: join(TMP, 'tisseo-perf.png') });
await b.close();
console.log(echecs.length ? `\n${echecs.length} échec(s)` : '\nTout est vert');
process.exit(echecs.length ? 1 : 0);
