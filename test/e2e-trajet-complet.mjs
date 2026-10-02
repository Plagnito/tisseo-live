// Le planificateur d'itinéraire, dans un vrai navigateur.
//
// Ce que ce test garde :
//   - on CHOISIT son départ et son arrivée dans des suggestions (arrêts,
//     adresses, lieux), au clavier comme au doigt, et c'est le lieu choisi qui
//     part au serveur — pas un texte à re-deviner ;
//   - TOUT le trajet est dessiné d'un coup : la marche depuis l'adresse, chaque
//     ligne sur son tronçon, la correspondance, les repères A et B ;
//   - une étape se met en avant sans effacer le reste ;
//   - l'heure de départ choisie est envoyée ; une erreur du serveur est dite
//     telle quelle ; un arrêt non desservi (perturbation) est signalé.
//
// Les réponses du serveur (suggestions, trajet, passages) sont interceptées :
// le test ne dépend ni du géocodeur ni du calculateur piéton, et vérifie le
// navigateur, pas le réseau. Le calcul lui-même est couvert par `npm test`.
//
// Autonome : lance son propre serveur sur un port libre.
//   node test/e2e-trajet-complet.mjs
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

// --- ce que le serveur « répond » ----------------------------------------------------
const ADRESSE = { label: '12 Rue du Test 31000 Toulouse', type: 'address', kind: 'housenumber', lat: 43.6, lon: 1.44 };
const ARRET = { id: 'stop_point:SP_TEST', name: 'Capitole', lat: 43.61, lon: 1.46, lines: ['A', 'L1'] };
const T0 = Math.floor(Date.now() / 1000) + 300;
const TRAJET = {
  depart_at: T0, arrive_at: T0 + 1080, duration_s: 1080, transfers: 1, estimates: 1,
  origin: { label: ADRESSE.label, lat: ADRESSE.lat, lon: ADRESSE.lon }, destination: { label: 'Capitole' },
  from: { stop_id: 's1', name: 'Arrêt Un' }, to: { stop_id: 's3', name: 'Capitole' },
  legs: [
    { type: 'walk', access: true, seconds: 300, from: ADRESSE.label, to: 'Arrêt Un', distance_m: 380, path: [[43.6, 1.44], [43.601, 1.4405], [43.602, 1.442]] },
    { type: 'ride', route_id: 'r1', line: 'L1', mode: 'Bus', color: 'ff6600', text_color: 'ffffff', from: 'Arrêt Un', from_id: 's1', to: 'Arrêt Deux', to_id: 's2',
      depart: T0 + 300, arrive: T0 + 720, seconds: 420, real: true, transfer_s: 240, headsign: 'Terminus Est', distance_m: 1900,
      stops: [{ id: 's1', name: 'Arrêt Un', lat: 43.602, lon: 1.442 }, { id: 'sx', name: 'Entre Deux', lat: 43.604, lon: 1.447 }, { id: 's2', name: 'Arrêt Deux', lat: 43.606, lon: 1.452 }],
      path: [[43.602, 1.442], [43.603, 1.445], [43.604, 1.447], [43.605, 1.45], [43.606, 1.452]] },
    { type: 'walk', seconds: 60, from: 'Arrêt Deux', to: 'Arrêt Deux', distance_m: 40, path_estimated: true, path: [[43.606, 1.452], [43.6062, 1.4523]] },
    { type: 'ride', route_id: 'rA', line: 'A', mode: 'Métro', color: 'db001b', text_color: 'ffffff', from: 'Arrêt Deux', from_id: 's2b', to: 'Capitole', to_id: 's3',
      depart: T0 + 840, arrive: T0 + 1080, seconds: 240, real: false, scheduled: true, transfer_s: 120, headsign: 'Balma-Gramont', distance_m: 1100,
      stops: [{ id: 's2b', name: 'Arrêt Deux', lat: 43.6062, lon: 1.4523 }, { id: 's3', name: 'Capitole', lat: 43.61, lon: 1.46 }],
      path: [[43.6062, 1.4523], [43.608, 1.456], [43.61, 1.46]] },
  ],
  disruptions: [{ line: 'L9', route_id: 'r9', title: 'Déviation ligne L9', kind: 'arret', stops: ['Jean Jaurès'] }],
  bounds: [[43.6, 1.44], [43.61, 1.46]], distance_m: 3420, walk_m: 420,
};
const TOUS = TRAJET.legs.flatMap((l) => l.path);

// --- le banc -------------------------------------------------------------------
const port = await portLibre();
const BASE = `http://127.0.0.1:${port}`;
const serveur = spawn(process.execPath, ['server.mjs'], { cwd: racine, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TISSEO_DATA_USER: 'memoire' } });
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
const erreurs = [];
async function ouvrir(options) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...options });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erreurs.push(e.message));
  const demandes = { suggest: [], journey: [] };
  let reponseTrajet = TRAJET;
  const json = (route, corps, status = 200) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(corps) });
  await page.route('**/api/places/suggest**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q');
    demandes.suggest.push(q);
    return json(route, /capit/i.test(q) ? { q, stops: [ARRET], places: [{ label: 'Place du Capitole 31000 Toulouse', type: 'address', kind: 'street', lat: 43.6044, lon: 1.4433 }] } : { q, stops: [], places: [ADRESSE, { label: 'Musée du Test, Toulouse', type: 'poi', kind: 'musée', lat: 43.59, lon: 1.43 }] });
  });
  await page.route('**/api/journey**', (route) => {
    demandes.journey.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    return json(route, reponseTrajet, reponseTrajet.error ? 400 : 200);
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof askJourney === 'function' && document.getElementById('jFromSuggest'), null, { timeout: 20_000 });
  return { ctx, page, demandes, repondre: (r) => { reponseTrajet = r; } };
}
const dessin = (page) => page.evaluate((tous) => {
  const b = map.getBounds();
  return {
    traces: document.querySelectorAll('.leaflet-overlay-pane path.journey').length,
    marche: document.querySelectorAll('.leaflet-overlay-pane path.journey.walk').length,
    bouts: [...document.querySelectorAll('.jend')].map((e) => e.textContent).join(''),
    toutVisible: tous.every(([la, lo]) => b.contains([la, lo])),
    zoom: map.getZoom(),
  };
}, TOUS);

// ================================ ordinateur ================================
{
  const { ctx, page, demandes, repondre } = await ouvrir({ viewport: { width: 1366, height: 820 }, geolocation: { latitude: 43.6045, longitude: 1.444 }, permissions: ['geolocation'] });
  await page.locator('#planner > summary').click();

  // --- 1. suggestions ---------------------------------------------------------------
  await page.locator('#jFrom').click();
  await page.locator('#jFromSuggest li').first().waitFor({ timeout: 5000 });
  ok(/Ma position/.test(await page.locator('#jFromSuggest').innerText()), 'champ vide : « Ma position » est proposée d\'emblée');
  await page.locator('#jFrom').pressSequentially('12 rue du te', { delay: 15 });
  await page.locator('#jFromSuggest li', { hasText: '12 Rue du Test' }).waitFor({ timeout: 5000 });
  const propose = (await page.locator('#jFromSuggest li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
  ok(propose.length === 2 && /Adresse/.test(propose[0]) && /Lieu/.test(propose[1]), `les suggestions disent ce qu'elles sont (${propose.join(' | ')})`);
  ok(demandes.suggest.at(-1) === '12 rue du te' && demandes.suggest.length <= 4, `la saisie est regroupée avant d'interroger le serveur (${demandes.suggest.length} appel(s) pour 12 touches)`);
  await page.keyboard.press('ArrowDown');
  ok(await page.locator('#jFromSuggest li.on').count() === 1, 'les flèches parcourent la liste');
  await page.keyboard.press('Enter');
  ok(await page.inputValue('#jFrom') === ADRESSE.label, 'Entrée choisit la suggestion');
  ok(demandes.journey.length === 0, 'choisir un départ ne lance pas de calcul (il manque l\'arrivée)');
  ok(await page.evaluate(() => document.activeElement?.id) === 'jTo', 'et le curseur passe à l\'arrivée');

  await page.locator('#jTo').pressSequentially('capit', { delay: 15 });
  await page.locator('#jToSuggest li', { hasText: 'Capitole' }).first().waitFor({ timeout: 5000 });
  ok(/Arrêt · A, L1/.test((await page.locator('#jToSuggest li').first().innerText()).replace(/\s+/g, ' ')), 'un arrêt montre ses lignes');
  await page.locator('#jToSuggest li').first().click();

  // --- 2. le trajet demandé est celui qu'on a choisi --------------------------------------
  await page.locator('#jResults .jhead').waitFor({ timeout: 8000 });
  const d = demandes.journey.at(-1);
  ok(d.from_lat === String(ADRESSE.lat) && d.from_lon === String(ADRESSE.lon) && d.from_label === ADRESSE.label && !('from' in d), `l'adresse choisie part avec ses coordonnées (${JSON.stringify(d).slice(0, 110)}…)`);
  ok(d.to_stop === ARRET.id && !('to' in d), 'l\'arrêt choisi part avec son identifiant');
  ok(!('at' in d), 'sans heure choisie : départ maintenant');

  // --- 3. les étapes -----------------------------------------------------------------
  await page.waitForTimeout(1200);
  const txt = await page.evaluate(() => ({
    od: document.querySelector('#jResults .jod')?.innerText.replace(/\s+/g, ' '),
    duree: document.querySelector('#jResults .jhead b')?.textContent,
    sous: document.querySelector('#jResults .jhead span')?.textContent.replace(/\s+/g, ' '),
    etapes: [...document.querySelectorAll('#jResults li.jleg')].map((li) => li.innerText.replace(/\s+/g, ' ')),
    lignes: document.querySelectorAll('#jResults li.jleg b .dline').length,
    alertes: document.querySelector('#jResults .jwarn')?.innerText.replace(/\s+/g, ' ') || '',
  }));
  ok(txt.od.includes('12 Rue du Test') && txt.od.includes('Capitole'), `ce qui a été compris est rappelé (${txt.od})`);
  ok(txt.duree === '18 min' && /départ/.test(txt.sous) && /arrivée/.test(txt.sous) && /1 correspondance/.test(txt.sous) && /420 m à pied/.test(txt.sous), `résumé : ${txt.duree}, ${txt.sous}`);
  ok(txt.etapes.length === 4 && txt.lignes === 2, `quatre étapes, deux lignes (${txt.etapes.length}, ${txt.lignes})`);
  ok(/5 min à pied/.test(txt.etapes[0]) && /380 m/.test(txt.etapes[0]), `la marche dit sa durée et sa distance (${txt.etapes[0]})`);
  ok(/temps réel/.test(txt.etapes[1]) && !/correspondance/.test(txt.etapes[1]), 'le premier véhicule n\'est pas une « correspondance »');
  ok(/2 arrêts · direction Terminus Est/.test(txt.etapes[1]), 'le nombre d\'arrêts et la direction sont dits');
  ok(/Correspondance/.test(txt.etapes[2]), 'le changement de quai est une correspondance');
  ok(/horaire théorique/.test(txt.etapes[3]) && /\+2 min de correspondance/.test(txt.etapes[3]), 'le second véhicule porte l\'attente de correspondance, et sa provenance');
  ok(/L9 perturbée/.test(txt.alertes), `une perturbation prise en compte est signalée (${txt.alertes.slice(0, 80)})`);
  await page.locator('#jResults li.jleg.ride .jstops summary').first().click();
  ok(/Entre Deux/.test(await page.locator('#jResults li.jleg.ride .jstops').first().innerText()), 'la liste des arrêts traversés se déplie');

  // --- 4. tout le trajet sur la carte ---------------------------------------------------
  const carte = await dessin(page);
  ok(carte.marche === 2, `les deux marches sont dessinées en pointillés (${carte.marche})`);
  ok(carte.traces >= 2 * 2 + 2 * 3 + 5, `chaque ligne a son tronçon et ses arrêts (${carte.traces} tracés)`);
  ok(carte.bouts === 'AB', `les repères A et B sont posés (${carte.bouts})`);
  ok(carte.toutVisible, 'la carte cadre le trajet ENTIER, de l\'adresse à l\'arrivée');

  // --- 5. mettre une étape en avant -------------------------------------------------------
  await page.locator('#jResults li.jleg.ride').nth(1).locator('.jstop').first().click();
  await page.waitForTimeout(1300);
  const etape = await dessin(page);
  ok(etape.traces === carte.traces && etape.bouts === 'AB', `une étape mise en avant n'efface pas le reste (${etape.traces} tracés)`);
  ok(etape.zoom > carte.zoom, `et la carte s'en rapproche (zoom ${carte.zoom} → ${etape.zoom})`);
  const pale = await page.evaluate(() => [...document.querySelectorAll('.leaflet-overlay-pane path.journey.walk')].every((p) => Number(p.getAttribute('stroke-opacity')) < 1));
  ok(pale, 'les autres étapes pâlissent');
  await page.locator('#jShowAll').click();
  await page.waitForTimeout(1300);
  ok((await dessin(page)).toutVisible, '« Voir tout le trajet » recadre sur l\'ensemble');

  // --- 6. heure de départ, inversion, saisie libre -----------------------------------------
  await page.fill('#jAt', '2026-10-05T08:30');
  await page.locator('#jGo').click();
  await page.waitForTimeout(500);
  const attendu = String(Math.floor(new Date('2026-10-05T08:30').getTime() / 1000));
  ok(demandes.journey.at(-1).at === attendu, `l'heure de départ choisie est envoyée (${demandes.journey.at(-1).at})`);
  await page.locator('#jSwap').click();
  await page.waitForTimeout(500);
  const inv = demandes.journey.at(-1);
  ok(inv.from_stop === ARRET.id && inv.to_lat === String(ADRESSE.lat), 'inverser garde les lieux choisis, de l\'autre côté');
  await page.fill('#jFrom', 'Capitole nord');
  await page.locator('#jFromSuggest li').first().waitFor({ timeout: 5000 });
  // La liste est encore ouverte : le clic sur « Calculer » doit quand même
  // atteindre le bouton (la liste ne se referme qu'une fois le geste fini).
  const n = demandes.journey.length;
  await page.locator('#jGo').click();
  await page.waitForTimeout(600);
  ok(demandes.journey.length === n + 1, 'cliquer « Calculer » pendant que des suggestions sont affichées lance bien le calcul');
  ok(await page.locator('#jFromSuggest').evaluate((e) => e.classList.contains('hidden')), 'et la liste se referme ensuite');
  const libre = demandes.journey.at(-1);
  ok(libre.from === 'Capitole nord' && !('from_stop' in libre), 'un texte retouché n\'est plus le lieu choisi : il est envoyé tel quel');

  // --- 7. erreur dite telle quelle, puis fermeture --------------------------------------------
  repondre({ error: '« Paris Gare de Lyon » semble désigner un lieu hors du réseau Tisséo.', hint: 'Nom d’arrêt, adresse ou coordonnées.' });
  await page.fill('#jTo', 'Paris Gare de Lyon');
  await page.locator('#jGo').click();
  // « Calcul en cours… » porte aussi la classe .jerr : on attend la RÉPONSE.
  await page.locator('#jResults .jerr:not(.jwait)').waitFor({ timeout: 5000 });
  const err = await page.locator('#jResults .jerr').innerText();
  ok(/hors du réseau Tisséo/.test(err) && (await dessin(page)).traces === 0, `le refus du serveur est affiché, et l'ancien tracé retiré (${err.slice(0, 60)}…)`);
  repondre(TRAJET);
  await page.locator('#jGo').click();
  await page.locator('#jResults .jhead').waitFor({ timeout: 5000 });
  await page.locator('#jClose').click();
  await page.waitForTimeout(300);
  ok((await dessin(page)).traces === 0 && await page.locator('#jResults').innerHTML() === '', 'fermer efface les étapes et le tracé');

  // --- 8. « Ma position » ---------------------------------------------------------------------
  await page.fill('#jFrom', '');
  await page.locator('#jFrom').click();
  await page.locator('#jFromSuggest li', { hasText: 'Ma position' }).click();
  await page.waitForFunction(() => document.getElementById('jFrom').value === 'Ma position', null, { timeout: 8000 });
  await page.fill('#jTo', 'Capitole');
  await page.locator('#jGo').click();
  await page.waitForTimeout(500);
  const pos = demandes.journey.at(-1);
  ok(pos.from_lat === '43.6045' && pos.from_lon === '1.444' && pos.to === 'Capitole', `« Ma position » envoie la position du navigateur (${pos.from_lat}, ${pos.from_lon})`);

  // --- 9. arrêt non desservi (perturbation) dans la fiche d'un arrêt ------------------------------
  await page.route('**/api/stops/search**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ q: 'palais', count: 1, stops: [{ id: 'stop_point:PJ', name: 'Palais de Justice', lat: 43.5928, lon: 1.444, served: true, lines: ['T1'] }] }) }));
  await page.route('**/api/departures**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rt_timestamp: T0, stops: [], stop: { id: 'stop_point:PJ', name: 'Palais de Justice' }, departures: [], closed: [{ line: 'T1', route_id: 'line:68', title: 'Ligne T1 : arrêt partiel tram', url: 'https://www.tisseo.fr/' }] }) }));
  await page.fill('#search', 'palais');
  await page.locator('#stopResults li[data-stop]').first().click({ timeout: 8000 });
  await page.locator('#detail .stopclosed').waitFor({ timeout: 5000 });
  const ferme = (await page.locator('#detail').innerText()).replace(/\s+/g, ' ');
  ok(/T1 ne dessert pas cet arrêt en ce moment/.test(ferme) && /arrêt partiel tram/.test(ferme), `la fiche d'un arrêt dit quelle ligne ne le dessert pas, et pourquoi (${ferme.slice(0, 110)})`);
  await ctx.close();
}

// ================================ téléphone ================================
{
  const { ctx, page } = await ouvrir({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.locator('#sidebarToggle').click();
  await page.locator('#planner > summary').click();
  await page.locator('#jFrom').pressSequentially('12 rue', { delay: 15 });
  await page.locator('#jFromSuggest li').first().waitFor({ timeout: 5000 });
  const cible = await page.locator('#jFromSuggest li').first().boundingBox();
  ok(cible.height >= 44 && cible.x >= 0 && cible.x + cible.width <= 390, `au doigt, une suggestion fait ${Math.round(cible.height)} px de haut et tient dans l'écran`);
  await page.locator('#jFromSuggest li').first().tap();
  await page.locator('#jTo').pressSequentially('capit', { delay: 15 });
  await page.locator('#jToSuggest li').first().waitFor({ timeout: 5000 });
  await page.locator('#jToSuggest li').first().tap();
  await page.locator('#jResults .jhead').waitFor({ timeout: 8000 });
  await page.locator('#jShowAll').scrollIntoViewIfNeeded();
  await page.locator('#jShowAll').tap();
  await page.waitForTimeout(1400);
  const tel = await page.evaluate(() => ({ ouverte: document.getElementById('sidebar').classList.contains('open'), poignee: document.getElementById('sidebarToggleLabel').textContent }));
  const carte = await dessin(page);
  ok(!tel.ouverte && carte.toutVisible && carte.bouts === 'AB', '« Voir tout le trajet » referme la feuille et montre le trajet entier');
  ok(/18 min/.test(tel.poignee) && /étapes/.test(tel.poignee), `la poignée rappelle le trajet en cours (« ${tel.poignee} »)`);
  await page.locator('#sidebarToggle').tap();
  await page.waitForTimeout(400);
  ok(await page.locator('#jResults li.jleg').count() === 4, 'un appui sur la poignée retrouve les étapes');
  await ctx.close();
}

ok(erreurs.length === 0, `aucune erreur de script${erreurs.length ? ' — ' + erreurs.join(' | ') : ''}`);
await browser.close();
arreter();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout passe.');
process.exit(fails.length ? 1 : 0);
