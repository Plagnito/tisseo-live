// L'application dans Firefox et WebKit.
//
// Tout le travail du projet n'a été vérifié que dans Chromium. Or l'application
// repose sur des choses qui varient d'un moteur à l'autre : les Tuiles, le
// service worker, EventSource (SSE), le Notification API, requestAnimationFrame
// et les modules ES importés par le pont vers lib/. Un écart se voit surtout
// au moment où l'on n'est pas devant.
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

const pw = loadPlaywright();
const URL = process.env.URL || 'http://localhost:4127/';
const TMP = process.env.TEMP || '.';
const MOTEURS = ['chromium', 'firefox', 'webkit'];
const echecs = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) echecs.push(m); };

for (const nom of MOTEURS) {
  const type = pw[nom];
  if (!type) { ok(false, `${nom} : inconnu de Playwright`); continue; }
  console.log(`\n=== ${nom} ===`);
  let navigateur;
  try {
    navigateur = await type.launch();
  } catch (e) {
    ok(false, `${nom} : lancement impossible (${String(e.message).slice(0, 90)})`);
    continue;
  }
  const ctx = await navigateur.newContext({ viewport: { width: 1280, height: 800 }, locale: 'fr-FR' });
  const page = await ctx.newPage();
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push(String(e.message).slice(0, 120)));
  page.on('console', (m) => { if (m.type() === 'error') erreurs.push('console: ' + m.text().slice(0, 100)); });

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(15000);

    const m = await page.evaluate(() => ({
      leaflet: typeof window.L !== 'undefined',
      cluster: typeof window.L?.markerClusterGroup === 'function',
      pontM: typeof window.M?.predict === 'function' && typeof window.M?.observedSpeed === 'function',
      pontIT: typeof window.IT?.pickVariantForVehicle === 'function',
      sse: typeof window.EventSource === 'function',
      sw: 'serviceWorker' in navigator,
      pastilles: document.querySelectorAll('.leaflet-marker-icon').length,
      tuiles: document.querySelectorAll('.leaflet-tile-loaded').length,
      bandeau: document.getElementById('liveText')?.textContent?.trim(),
      compteurs: document.getElementById('statVehicles')?.textContent?.trim(),
    }));

    ok(m.leaflet, 'Leaflet chargé');
    ok(m.cluster, 'le regroupement de marqueurs est disponible');
    ok(m.pontM, 'lib/motion.mjs importé par le navigateur (pont ES)');
    ok(m.pontIT, 'lib/itinerary.mjs importé par le navigateur (pont ES)');
    ok(m.sse, 'EventSource disponible');
    ok(m.pastilles > 0, `des véhicules affichés (${m.pastilles})`);
    ok(m.tuiles > 0, `des tuiles chargées (${m.tuiles})`);
    ok(/direct|attente|dégrad/i.test(m.bandeau || ''), `bandeau temps réel cohérent (« ${m.bandeau} »)`);

    // Le push SSE : c'est le point le plus susceptible de varier d'un moteur à
    // l'autre. On ne compare PAS le nombre de véhicules — il change à chaque
    // actualisation du réseau, c'est même la preuve que ça marche. Ce qu'on
    // vérifie : la connexion reste ouverte (bouton « live ») et l'âge des
    // données reste faible sans aucune action de l'utilisateur.
    await page.waitForTimeout(22000);
    const push = await page.evaluate(() => {
      const t = document.getElementById('liveText')?.textContent || '';
      const age = /il y a (\d+)\s*s/.exec(t);
      return {
        bouton: document.getElementById('countdown')?.textContent?.trim(),
        age: age ? Number(age[1]) : null,
        bandeau: t.trim(),
      };
    });
    ok(push.bouton === 'live', `la connexion push reste ouverte (bouton « ${push.bouton} »)`);
    ok(push.age !== null && push.age <= 30,
      `les données vieillissent toutes seules, sans rafraîchissement manuel (« ${push.bandeau} »)`);

    // Service worker et hors ligne.
    const sw = await page.evaluate(async () => {
      const r = await navigator.serviceWorker?.getRegistration?.();
      return r ? (r.active ? 'actif' : 'installé') : 'AUCUN';
    });
    ok(sw !== 'AUCUN', `service worker ${sw}`);

    // Les erreurs liées à la coupure réseau sont ATTENDUES : on ne compte que
    // celles survenues tant qu'on était en ligne, sinon le test échouerait
    // précisément parce que le hors ligne fonctionne.
    const erreursEnLigne = erreurs.filter((e) => !/ERR_INTERNET_DISCONNECTED|internal error|interrupted|establish a connection/i.test(e));
    ok(erreursEnLigne.length === 0, `aucune erreur JavaScript en ligne${erreursEnLigne.length ? ` : ${erreursEnLigne.slice(0, 2).join(' | ')}` : ''}`);

    await ctx.setOffline(true);
    await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(15000);
    const horsLigne = await page.evaluate(() => ({
      tracés: document.querySelectorAll('.leaflet-overlay-pane path').length,
      carte: !!document.getElementById('map'),
    }));
    ok(horsLigne.carte, 'la page est servie hors ligne');
    ok(horsLigne.tracés > 100, `le réseau est dessiné hors ligne (${horsLigne.tracés} tracés)`);
    await ctx.setOffline(false);

    // Un clic réel, pour vérifier que les événements pointeur fonctionnent.
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(14000);
    await page.click('#statVehiclesBtn');
    await page.waitForTimeout(1200);
    const inv = await page.evaluate(() => ({
      visible: !document.getElementById('inventory').classList.contains('hidden'),
      lignes: document.querySelectorAll('li.inv').length,
      vitesses: [...document.querySelectorAll('li.inv .spd')].filter((e) => e.textContent.trim()).length,
    }));
    ok(inv.visible && inv.lignes > 5, `inventaire ouvert au clic (${inv.lignes} lignes)`);
    ok(inv.vitesses > 0, `vitesse mesurée affichée (${inv.vitesses} lignes)`);

    await page.screenshot({ path: join(TMP, `tisseo-${nom}.png`) });
    const finales = erreurs.filter((e) => !/ERR_INTERNET_DISCONNECTED|internal error|interrupted|establish a connection/i.test(e));
    if (finales.length) ok(false, `erreurs JavaScript en fin de parcours : ${finales.slice(0, 2).join(' | ')}`);
  } catch (e) {
    ok(false, `${nom} : ${String(e.message).slice(0, 140)}`);
  } finally {
    await navigateur.close();
  }
}

console.log(echecs.length ? `\n${echecs.length} échec(s)` : '\nTout est vert');
process.exit(echecs.length ? 1 : 0);
