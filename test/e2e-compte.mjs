// Compte, dans un vrai navigateur : connexion Atlas, trajets enregistrés et
// planifiés, partage d'un trajet et d'une position entre deux personnes.
//
// Ce que les tests unitaires ne voient pas : le panneau est-il dessiné, les
// boutons font-ils ce qu'ils disent, la position partie d'un navigateur
// arrive-t-elle sur la carte d'un autre, et s'arrête-t-elle vraiment.
//
// Autonome : lance son propre faux Atlas et son propre serveur (comptes en
// mémoire), sur des ports libres. Ne touche ni au serveur de développement ni à
// data-user/.
//   node test/e2e-compte.mjs
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { creerFauxAtlas } from '../scripts/banc-atlas.mjs';

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

// --- le banc -------------------------------------------------------------------
const fa = creerFauxAtlas();
const portAtlas = await new Promise((r) => { const l = fa.serveur.listen(0, '127.0.0.1', () => r(l.address().port)); });
const port = await portLibre();
const BASE = `http://127.0.0.1:${port}`;
const serveur = spawn(process.execPath, ['server.mjs'], {
  cwd: racine, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ATLAS_URL: `http://127.0.0.1:${portAtlas}`, TISSEO_DATA_USER: 'memoire' },
});
let journal = '';
serveur.stdout.on('data', (d) => { journal += d; });
serveur.stderr.on('data', (d) => { journal += d; });
const arreter = () => { try { serveur.kill(); } catch { /* */ } try { fa.serveur.close(); } catch { /* */ } };
process.on('exit', arreter);
for (let i = 0; ; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* pas encore */ }
  if (i > 80 || serveur.exitCode != null) { console.error(journal); throw new Error('le serveur de test ne démarre pas'); }
  await new Promise((r) => setTimeout(r, 250));
}
ok(/Comptes : mémoire seule/.test(journal), 'le serveur de test garde ses comptes en mémoire (rien sur le disque)');

const browser = await chromium.launch();
const erreurs = [];
async function personne(nom, geo) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, serviceWorkers: 'block',
    ...(geo ? { geolocation: { latitude: geo[0], longitude: geo[1], accuracy: 14 }, permissions: ['geolocation'] } : {}),
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erreurs.push(`${nom} : ${e.message}`));
  await page.goto(`${BASE}/?compte=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('#compteCorps a', { hasText: 'Se connecter avec Atlas' }).click();
  await page.locator('a', { hasText: nom }).click();
  await page.waitForURL(`${BASE}/?compte=1`);
  await page.locator('.cpt-qui', { hasText: nom }).waitFor();
  return { ctx, page };
}
const texte = (page, sel) => page.locator(sel).innerText();

// --- 1. connexion ----------------------------------------------------------------
const anonyme = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
await anonyme.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await anonyme.locator('#compte > summary').click();
ok(/Se connecter avec Atlas/.test(await texte(anonyme, '#compteCorps')), 'sans session : le panneau propose la connexion');
await anonyme.locator('#planner > summary').click();
ok(await anonyme.locator('#jGo').isVisible(), 'et l’itinéraire reste utilisable sans compte');
await anonyme.close();

const A = await personne('Plagnito', [43.6045, 1.4440]);
ok(/Connecté : Plagnito/.test(await texte(A.page, '#compteCorps')), 'Plagnito est connecté par le (faux) Atlas, et revient sur le panneau ouvert');
ok(!(await A.ctx.cookies()).some((c) => c.name === 'tisseo_session' && !c.httpOnly), 'le cookie de session est fermé aux scripts');

// --- 2. enregistrer un trajet depuis l'itinéraire ----------------------------------
await A.page.locator('#planner > summary').click();
await A.page.fill('#jFrom', 'capitole');
await A.page.fill('#jTo', 'arenes');
await A.page.click('#jGo');
await A.page.locator('#jResults .cpt-apres [data-apres="enregistrer"]').click({ timeout: 20000 });
await A.page.locator('#compteCorps .cpt-item', { hasText: 'Capitole → Arènes' }).waitFor();
ok(true, 'un itinéraire calculé s’enregistre, sous les noms que le serveur a compris (« Capitole → Arènes »)');
await A.page.locator('#jResults [data-apres="enregistrer"]').click();
await A.page.waitForTimeout(600);
ok(await A.page.locator('#compteCorps .cpt-item [data-action="calculer"]').count() === 1, 'l’enregistrer deux fois ne le duplique pas');

// --- 3. calculer depuis la liste --------------------------------------------------
await A.page.fill('#jFrom', ''); await A.page.fill('#jTo', '');
await A.page.locator('#compteCorps [data-action="calculer"]').click();
await A.page.locator('#jResults .jhead').waitFor({ timeout: 20000 });
ok(await A.page.inputValue('#jFrom') === 'Capitole' && await A.page.inputValue('#jTo') === 'Arènes', '« Calculer » remplit l’itinéraire et le lance');
await A.page.waitForFunction(() => document.querySelectorAll('path.journey').length > 0, null, { timeout: 15000 });
ok(true, 'le trajet est dessiné sur la carte');
await A.page.locator('#compteCorps .cpt-item small', { hasText: '1×' }).waitFor();
ok(true, 'l’utilisation est comptée (« 1× »)');

// --- 4. planifier -------------------------------------------------------------------
await A.page.locator('#compteCorps [data-action="planifier"]').click();
await A.page.selectOption('#cptForm select[name="mode"]', 'arriver');
await A.page.fill('#cptForm input[name="heure"]', '08:15');
await A.page.check('#cptForm input[name="rythme"][value="jours"]');
await A.page.locator('#cptForm [data-action="valider"]').click();
const plan = A.page.locator('#compteCorps .cpt-item', { hasText: 'arriver avant 08:15 · en semaine' });
await plan.waitFor();
ok(true, 'trajet planifié : « arriver avant 08:15 · en semaine »');
await plan.locator('[data-action="itineraire"]').click();
await plan.locator('.cpt-calcul ol li').first().waitFor({ timeout: 20000 });
const calcul = await plan.locator('.cpt-calcul').innerText();
ok(/départ \d\d:\d\d → arrivée \d\d:\d\d/.test(calcul) && /Prendre|Marcher/.test(calcul), 'son itinéraire est calculé pour la prochaine occurrence, étape par étape');
ok(/théorique|temps réel/.test(calcul), 'et dit d’où viennent ses horaires');

// --- 5. partager un trajet -----------------------------------------------------------
await A.page.locator('#compteCorps .cpt-item', { hasText: 'Capitole → Arènes' }).first().locator('[data-action="partager"]').click();
await A.page.locator('#cptForm input[name="amis"]').first().waitFor();
ok(await A.page.locator('#cptForm .cpt-amis label').allInnerTexts().then((l) => l.map((x) => x.trim()).join() === 'Bruno,Kiri'), 'les amis proposés sont les contacts Atlas (Bruno, Kiri)');
await A.page.locator('#cptForm [data-action="valider"]').click();
await A.page.locator('#cptForm .cpt-erreur', { hasText: 'au moins un ami' }).waitFor();
ok(true, 'sans ami coché : l’erreur est dite, rien ne part');
await A.page.check('#cptForm input[name="amis"][value="2"]');
await A.page.fill('#cptForm input[name="message"]', 'On se retrouve aux Arènes ?');
await A.page.locator('#cptForm [data-action="valider"]').click();
await A.page.locator('#compteCorps .cpt-item', { hasText: '→ Bruno' }).waitFor();
ok(fa.invitations.some((i) => i.type === 'itineraire' && i.vers.pseudo === 'Bruno'), 'trajet partagé avec Bruno, annoncé dans Atlas Contacts');

// --- 6. partager sa position ----------------------------------------------------------
await A.page.locator('#compteCorps [data-action="position"]').click();
await A.page.locator('#cptForm input[name="amis"][value="2"]').check();
ok(!(await A.page.isChecked('#cptForm input[name="assistants"]')), 'l’accès des assistants à la position est décoché par défaut');
await A.page.selectOption('#cptForm select[name="duree"]', '900');
await A.page.locator('#cptForm [data-action="valider"]').click();
await A.page.locator('#cptEmission', { hasText: 'Dernière position envoyée' }).waitFor({ timeout: 15000 });
ok(true, 'position partagée : la page dit quand elle a envoyé la dernière');

const B = await personne('Bruno');
const recus = await B.page.locator('#compteCorps .cpt-liste').first().innerText();
ok(/Plagnito/.test(recus) && /On se retrouve aux Arènes/.test(recus) && /Position en direct/.test(recus), 'Bruno voit le trajet (avec le mot) et le partage de position');
await B.page.locator('[data-action="suivre"]').click();
await B.page.locator('.leaflet-tooltip', { hasText: 'Plagnito · il y a' }).waitFor({ timeout: 15000 });
ok(await B.page.locator('path.cpt-ami').count() === 1, 'la position de Plagnito est sur la carte de Bruno, avec son âge');
const centre = await B.page.evaluate(() => { const c = map.getCenter(); return [c.lat, c.lng]; });
ok(Math.abs(centre[0] - 43.6045) < 0.01 && Math.abs(centre[1] - 1.444) < 0.01, 'et la carte s’est centrée dessus');
const K = await personne('Kiri');
ok(!/Plagnito/.test(await texte(K.page, '#compteCorps')), 'Kiri, à qui rien n’a été partagé, ne voit rien');
await K.ctx.close();

// --- 7. un trajet reçu se calcule et se garde --------------------------------------------
await B.page.locator('[data-action="voir-partage"]').click();
await B.page.locator('#jResults .jhead').waitFor({ timeout: 20000 });
ok(await B.page.inputValue('#jTo') === 'Arènes', 'Bruno calcule le trajet reçu');
await B.page.locator('[data-action="garder-partage"]').click();
await B.page.locator('#compteCorps .cpt-item [data-action="calculer"]').waitFor();
ok(true, 'et le garde dans ses propres trajets');

// --- 8. arrêter : par le bouton, puis par la fermeture de la page -------------------------
const partagesDeBruno = async () => (await (await B.ctx.request.get(`${BASE}/api/compte/partages`)).json()).recus.filter((p) => p.type === 'position').length;
ok(await partagesDeBruno() === 1, 'avant l’arrêt : un partage de position côté Bruno');
A.page.once('dialog', (d) => d.accept());
await A.page.locator('#compteCorps [data-action="arreter-partage"]', { hasText: 'Arrêter le partage' }).click();
await A.page.waitForFunction(() => !document.getElementById('cptEmission'));
ok(await partagesDeBruno() === 0, '« Arrêter le partage » : Bruno ne voit plus la position');
await B.page.locator('#toast', { hasText: 'terminé' }).waitFor({ timeout: 25000 });
ok(await B.page.locator('path.cpt-ami').count() === 0, 'chez Bruno, le point disparaît de la carte et la fin est annoncée');

await A.page.locator('#compteCorps [data-action="position"]').click();
await A.page.locator('#cptForm input[name="amis"][value="2"]').check();
await A.page.locator('#cptForm [data-action="valider"]').click();
await A.page.locator('#cptEmission', { hasText: 'Dernière position envoyée' }).waitFor({ timeout: 15000 });
ok(await partagesDeBruno() === 1, 'nouveau partage de position en cours');
await A.page.close({ runBeforeUnload: true });
let reste = 1;
for (let i = 0; i < 20 && reste; i++) { await new Promise((r) => setTimeout(r, 300)); reste = await partagesDeBruno(); }
ok(reste === 0, 'fermer la page qui envoyait la position arrête le partage');

// --- 9. téléphone ---------------------------------------------------------------------------
const tel = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: 'block', storageState: await B.ctx.storageState() });
const pt = await tel.newPage();
pt.on('pageerror', (e) => erreurs.push(`téléphone : ${e.message}`));
await pt.goto(`${BASE}/?compte=1`, { waitUntil: 'domcontentloaded' });
await pt.locator('.cpt-qui', { hasText: 'Bruno' }).waitFor();
const mesures = await pt.evaluate(() => ({
  ouvert: document.getElementById('sidebar').classList.contains('open'),
  petit: Math.min(...[...document.querySelectorAll('#compteCorps .mini')].map((b) => b.offsetHeight)),
  deborde: document.documentElement.scrollWidth > innerWidth,
  horsPanneau: [...document.querySelectorAll('#compteCorps *')].some((e) => e.getBoundingClientRect().right > document.getElementById('compteCorps').getBoundingClientRect().right + 1),
}));
ok(mesures.ouvert, 'à 360 px, « ?compte=1 » ouvre le panneau latéral');
ok(mesures.petit >= 44, `les boutons du compte font au moins 44 px de haut (${mesures.petit})`);
ok(!mesures.deborde && !mesures.horsPanneau, 'rien ne déborde du panneau');
await pt.screenshot({ path: join(process.env.TEMP || '.', 'tisseo-compte-telephone.png') });

ok(erreurs.length === 0, `aucune erreur de script${erreurs.length ? ' — ' + erreurs.join(' | ') : ''}`);
await B.page.screenshot({ path: join(process.env.TEMP || '.', 'tisseo-compte.png') });
await browser.close();
arreter();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout passe.');
process.exit(fails.length ? 1 : 0);
