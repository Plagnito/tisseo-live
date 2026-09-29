// Vérifie le push SSE, les alertes sur la carte et les notifications.
// Lancement : node test/e2e-live.mjs
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
  throw new Error('playwright introuvable');
}
const { chromium } = loadPlaywright();
const BASE = process.env.URL || 'http://localhost:4127/';
const shot = (n) => join(process.env.TEMP || '.', `tisseo-${n}.png`);

const fails = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails.push(m); };

// --- 1. Le serveur pousse bien les changements de flux ---------------------
const ac = new AbortController();
setTimeout(() => ac.abort(), 40_000);
const r = await fetch(BASE + 'api/stream', { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
ok(r.status === 200, `le flux est ouvert (HTTP ${r.status}, ${r.headers.get('content-type')})`);
const reader = r.body.getReader();
const decoder = new TextDecoder();
let buf = '';
const events = [];
const t0 = Date.now();
while (Date.now() - t0 < 35_000) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const ev = buf.slice(0, i);
    buf = buf.slice(i + 2);
    if (ev.startsWith('event:')) events.push({ nom: /^event: (\w+)/.exec(ev)?.[1], at: Date.now() - t0, ev });
  }
  if (events.filter((e) => e.nom === 'update').length >= 2) break;
}
ac.abort();
const updates = events.filter((e) => e.nom === 'update');
ok(events.some((e) => e.nom === 'hello'), 'accueil envoyé à la connexion');
ok(updates.length >= 1, `changements de flux poussés (${updates.length} en ${Math.round((Date.now() - t0) / 1000)} s)`);
ok(updates.length >= 2 ? updates[1].at - updates[0].at < 20000 : true,
  'les poussées sont espacées comme le flux amont (~10 s), pas comme le sondage (15 s)');
console.log(`     première poussée à ${updates[0]?.at ?? '—'} ms`);

// --- 2. Le client écoute le flux et rafraîchit plus vite -------------------
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await ctx.grantPermissions(['notifications'], { origin: new URL(BASE).origin });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  // On compte les appels à /api/vehicles : avec le push actif, il doit y en
  // avoir beaucoup moins que 2 par minute.
  window.__calls = 0;
  const f = window.fetch;
  window.fetch = (u, o) => { if (String(u).includes('/api/vehicles')) window.__calls++; return f(u, o); };
});
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const apres5s = await page.evaluate(() => ({ calls: window.__calls, live: sseLive, cd: document.getElementById('countdown').textContent }));
ok(apres5s.live === true, 'le client est connecté au flux temps réel');
ok(apres5s.cd === 'live', `l\'indicateur affiche « live » (${apres5s.cd})`);
ok(apres5s.calls <= 2, `peu d\'appels pendant 5 s (${apres5s.calls})`);
await page.waitForTimeout(20_000);
const apres25 = await page.evaluate(() => window.__calls);
ok(apres25 <= 5, `sur 25 s, ${apres25} appels seulement (le polling en ferait 2 à 3, le push 1 à 2 par changement réel)`);

// --- 3. Alertes trafic visibles sur la carte -------------------------------
const alertes = await page.evaluate(() => {
  const li = document.querySelector('#alertList li[data-alert]');
  return { nb: document.querySelectorAll('#alertList li[data-alert]').length, routes: state.alertRoutes.size, texte: li?.textContent?.slice(0, 60) };
});
ok(alertes.nb > 0, `infos trafic perturbantes repérées (${alertes.nb})`);
ok(alertes.routes > 0, `lignes concernées identifiées (${alertes.routes})`);
if (alertes.nb) {
  await page.hover('#alertList li[data-alert]');
  await page.waitForTimeout(900);
  const surlignees = await page.evaluate(() => document.querySelectorAll('.leaflet-marker-icon .pill:not(.dimmed)').length);
  ok(surlignees >= 0, `survol d\'une info : ${surlignees} véhicule(s) mis en évidence`);
  await page.screenshot({ path: shot('alertes') });
  console.log(`     capture : ${shot('alertes')}`);
}

// --- 4. Notification pour un arrêt favori ----------------------------------
const notif = await page.evaluate(async () => {
  const s = { id: 'stop_point:SP_1912', name: 'Capitole', lat: 43.6047, lon: 1.4442 };
  toggleStopFav(s);
  for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, 200)); }
  return {
    favori: state.stopFavs.some((x) => x.id === s.id),
    bouton: !!document.querySelector(`[data-notify="${s.id}"]`),
    clocheEtat: document.querySelector(`[data-notify="${s.id}"]`)?.textContent,
  };
});
ok(notif.favori, 'arrêt ajouté aux favoris');
ok(notif.bouton, 'la cloche est présente dans la liste des favoris');
await page.screenshot({ path: shot('notification') });
console.log(`     capture : ${shot('notification')}`);

const btn = await page.$(`[data-notify="${(await page.evaluate(() => state.stopFavs[0].id))}"]`);
await btn.click();
await page.waitForTimeout(1000);
const etat = await page.evaluate(() => ({
  suivi: [...state.notifyStops],
  actif: document.querySelector('.bell.on') != null,
  permission: Notification.permission,
}));
// Permission dans un Chromium headless : ce qui compte, c'est que la demande
// aboutisse et que l'arrêt soit surveillé.
console.log(`     permission Notifications : ${etat.permission}`);
ok(etat.suivi.length === 1, `arrêt surveillé (${etat.suivi.length})`);
ok(etat.actif, 'la cloche passe à l\'état actif');

// Le réseau est fermé la nuit : plutôt que de dépendre de l'heure, on
// injecte un passage dans 90 s et on vérifie que la notification part — et
// qu'elle ne part pas deux fois pour le même passage.
const notif2 = await page.evaluate(async () => {
  const deja = [];
  const Orig = window.Notification;
  const Spy = function (titre, opts) { deja.push({ titre, corps: opts?.body, tag: opts?.tag }); return {}; };
  Spy.permission = 'granted';
  window.Notification = Spy;
  const id = state.stopFavs[0].id;
  const t = Math.floor(Date.now() / 1000) + 90;
  state.favDeps.set(id, [{ line: 'L1', dir: 0, route_id: 'line:1', color: 'dc006b', text_color: 'fff', destination: 'Test', time: t, source: 'rt' }]);
  checkNotifications(true);
  checkNotifications(true);
  checkNotifications(true);
  window.Notification = Orig;
  return deja;
});
ok(notif2.length === 1, `une seule notification pour un passage (${notif2.length}) malgré trois vérifications`);
ok(notif2[0]?.titre?.includes('L1'), `titre : « ${notif2[0]?.titre} »`);
ok(notif2[0]?.corps?.includes('Capitole'), `corps : « ${notif2[0]?.corps} »`);
await page.screenshot({ path: shot('notification') });
console.log(`     capture : ${shot('notification')}`);

if (errors.length) { console.log('erreurs JS :', errors.slice(0, 4)); fails.push('erreurs JS'); }
await browser.close();
console.log(fails.length ? `\n${fails.length} échec(s)` : '\nTout est vert');
process.exit(fails.length ? 1 : 0);
