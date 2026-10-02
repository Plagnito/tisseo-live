// Connexion et accord des assistants, AVEC un service worker aux commandes.
//
// Les autres tests navigateur bloquent les service workers : ils ne peuvent
// donc pas voir ce qui s'est produit en production le 02/10/2026. Un navigateur
// resté sur un ANCIEN service worker (le CDN servait encore l'ancien sw.js)
// interceptait la navigation vers la connexion, prenait la redirection vers
// Atlas pour une panne, et servait la page d'accueil à la place — sans styles,
// puisqu'elle n'était pas à son adresse.
//
// Deux navigateurs sont donc joués : l'un tenu par le service worker d'avant
// les comptes (test/fixtures/sw-v11.js, servi par un relais à la place du
// vrai), l'autre par le service worker actuel. Dans les deux, « Se connecter »
// doit mener chez Atlas, et un assistant doit atteindre l'écran d'accord.
//   node test/e2e-compte-sw.mjs
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
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

// --- le banc : faux Atlas, serveur, et un relais qui peut servir l'ancien sw.js ---
const fa = creerFauxAtlas();
const portAtlas = await new Promise((r) => { const l = fa.serveur.listen(0, '127.0.0.1', () => r(l.address().port)); });
const port = await portLibre();
const serveur = spawn(process.execPath, ['server.mjs'], {
  cwd: racine, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ATLAS_URL: `http://127.0.0.1:${portAtlas}`, TISSEO_DATA_USER: 'memoire' },
});
let journal = '';
serveur.stdout.on('data', (d) => { journal += d; });
serveur.stderr.on('data', (d) => { journal += d; });
const ANCIEN_SW = readFileSync(join(racine, 'test', 'fixtures', 'sw-v11.js'));
function relais(ancien) {
  // L'en-tête Host est transmis tel quel : le serveur se voit à l'adresse du
  // relais, et ses redirections y reviennent.
  const s = http.createServer((req, res) => {
    if (ancien && /^\/sw\.js(\?|$)/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(ANCIEN_SW);
    }
    const p = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, base: `http://127.0.0.1:${s.address().port}` })));
}
const relaisAncien = await relais(true);
const relaisActuel = await relais(false);
const arreter = () => { for (const x of [() => serveur.kill(), () => fa.serveur.close(), () => relaisAncien.s.close(), () => relaisActuel.s.close()]) { try { x(); } catch { /* */ } } };
process.on('exit', arreter);
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* pas encore */ }
  if (i > 80 || serveur.exitCode != null) { console.error(journal); throw new Error('le serveur de test ne démarre pas'); }
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();

async function parcours(quoi, BASE, versionAttendue) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); // service workers PERMIS
  const page = await ctx.newPage();
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push(e.message));
  await page.goto(`${BASE}/?compte=1`, { waitUntil: 'domcontentloaded' });
  // On attend que le service worker tienne la page, puis on recharge : c'est
  // l'état d'un visiteur qui revient, pas celui d'une première visite.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const caches = await page.evaluate(async () => (await caches.keys()).join(','));
  ok(caches.includes(versionAttendue), `${quoi} : la page est tenue par le service worker attendu (${caches})`);

  // --- les ANCIENNES adresses : un onglet resté ouvert, l'application Android 1.2.0 ---
  const vieux = await ctx.newPage();
  await vieux.goto(`${BASE}/auth/connexion?retour=%2F%3Fcompte%3D1`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  let vieuxOk = true;
  try { await vieux.waitForURL((u) => u.port === String(portAtlas), { timeout: 8000 }); } catch { vieuxOk = false; }
  ok(vieuxOk, `${quoi} : l’ancienne adresse de connexion mène encore chez Atlas${vieuxOk ? '' : ` — resté sur ${vieux.url().replace(BASE, '')}, « ${await vieux.title()} »`}`);
  await vieux.close();

  // --- se connecter ------------------------------------------------------------
  await page.locator('#compteCorps a', { hasText: 'Se connecter avec Atlas' }).click();
  let chezAtlas = true;
  try { await page.waitForURL((u) => u.port === String(portAtlas), { timeout: 8000 }); } catch { chezAtlas = false; }
  ok(chezAtlas, `${quoi} : « Se connecter avec Atlas » mène chez Atlas${chezAtlas ? '' : ` — resté sur ${page.url().replace(BASE, '')}, titre « ${await page.title()} »`}`);
  if (!chezAtlas) { await ctx.close(); return; }
  await page.locator('a', { hasText: 'Plagnito' }).click();
  let revenu = true;
  try { await page.locator('.cpt-qui', { hasText: 'Plagnito' }).waitFor({ timeout: 10000 }); } catch { revenu = false; }
  ok(revenu, `${quoi} : le retour d’Atlas ouvre la session${revenu ? '' : ` — arrivé sur ${page.url().replace(BASE, '')}`}`);
  ok(new URL(page.url()).pathname === '/' && await page.evaluate(() => getComputedStyle(document.body).marginTop === '0px' && document.styleSheets.length > 1), `${quoi} : et la page d’arrivée est la carte, avec ses styles`);

  // --- un assistant demande l'accord, dans ce même navigateur ----------------------
  const decouverte = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  const retourAssistant = `http://127.0.0.1:${portAtlas}/retour-assistant`;
  const client = await (await fetch(decouverte.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Assistant de test', redirect_uris: [retourAssistant], token_endpoint_auth_method: 'none' }) })).json();
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: retourAssistant, state: 'etat-test', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', scope: 'tisseo' });
  const onglet = await ctx.newPage();
  await onglet.goto(`${decouverte.authorization_endpoint}?${q}`, { waitUntil: 'domcontentloaded' });
  let accord = true;
  try { await onglet.locator('h1', { hasText: 'Autoriser cet assistant' }).waitFor({ timeout: 8000 }); } catch { accord = false; }
  ok(accord, `${quoi} : l’adresse d’autorisation annoncée affiche l’écran d’accord${accord ? '' : ` — affiché : « ${await onglet.title()} » à ${onglet.url().replace(BASE, '')}`}`);
  if (accord) {
    const versAssistant = onglet.waitForRequest((r) => r.url().startsWith(retourAssistant), { timeout: 8000 }).catch(() => null);
    await onglet.locator('button', { hasText: 'Autoriser' }).click();
    const r = await versAssistant;
    const u = r ? new URL(r.url()) : null;
    ok(Boolean(u?.searchParams.get('code')) && u.searchParams.get('state') === 'etat-test', `${quoi} : « Autoriser » renvoie un code à l’assistant${u ? '' : ` — resté sur ${onglet.url()} « ${(await onglet.locator('body').innerText().catch(() => '')).slice(0, 160)} »`}`);
  }

  // Un assistant qui a mémorisé l'ANCIENNE adresse d'autorisation (connecteur créé avant le correctif).
  const q2 = new URLSearchParams({ ...Object.fromEntries(q), state: 'ancien' });
  const tard = await ctx.newPage();
  await tard.goto(`${BASE}/oauth/authorize?${q2}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  let tardOk = true;
  try { await tard.locator('h1', { hasText: 'Autoriser cet assistant' }).waitFor({ timeout: 8000 }); } catch { tardOk = false; }
  ok(tardOk, `${quoi} : l’ancienne adresse d’autorisation affiche encore l’écran d’accord${tardOk ? '' : ` — « ${await tard.title()} » à ${tard.url().replace(BASE, '')}`}`);
  await tard.close();

  // --- et une session déjà ouverte n'empêche pas de se reconnecter ---------------
  await page.goto(`${BASE}/?compte=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('.cpt-qui', { hasText: 'Plagnito' }).waitFor({ timeout: 10000 });
  ok(erreurs.length === 0, `${quoi} : aucune erreur de script${erreurs.length ? ' — ' + erreurs.join(' | ') : ''}`);
  await ctx.close();
}

await parcours('ancien service worker', relaisAncien.base, 'tisseo-live-v11');
const actuel = /const CACHE = '([^']+)'/.exec(readFileSync(join(racine, 'public', 'sw.js'), 'utf8'))[1];
await parcours('service worker actuel', relaisActuel.base, actuel);

await browser.close();
arreter();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout passe.');
process.exit(fails.length ? 1 : 0);
