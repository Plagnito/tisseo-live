'use strict';

/*
 * Tisséo Live — superviseur & mise à jour automatique sur le Raspberry Pi.
 * Calqué sur celui d'Atlas Coffre (atlas-coffre/updater/supervisor.cjs), dont il
 * reprend les leçons payées sur le Pi ; sans étape de build ici.
 *
 * RÔLE :
 *   1. Lance server.mjs et le redémarre s'il s'arrête.
 *   2. Interroge GitHub (git fetch) ; sur nouveau commit → reset --hard,
 *      npm install, redémarre.
 *   3. Si la nouvelle version plante en boucle, OU ne répond pas sur
 *      /api/health dans la minute → retour à la version précédente.
 *
 * Config (.env à la racine, git-ignoré) : PORT, UPDATE_ENABLED, UPDATE_BRANCH,
 * UPDATE_INTERVAL_MIN. Le dépôt DOIT être cloné en SSH (clé de déploiement) :
 * en HTTPS, rien ne casse, l'app cesse seulement de se mettre à jour.
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_FILE = path.join(__dirname, 'supervisor.log');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function log(msg) {
  const line = `[${new Date().toISOString()}] [tisseo-updater] ${msg}`;
  console.log(line);
  try {
    // Journal borné : le Pi tourne des mois sans surveillance.
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2_000_000) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* */ }
}
function loadEnv() {
  try {
    if (!fs.existsSync(ENV_FILE)) return;
    for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('='); if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { log(`lecture .env impossible : ${e.message}`); }
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { history: [] }; } }
function writeState(patch) { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2)); } catch (e) { log(`écriture state impossible : ${e.message}`); } }

loadEnv();

function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
// La branche par défaut est CELLE DU CLONE (leçon Coffre : `main` en dur sur un
// dépôt en `master` = aucune mise à jour, jamais, en silence).
function brancheDuClone() { try { const b = git(['rev-parse', '--abbrev-ref', 'HEAD']); return b !== 'HEAD' ? b : ''; } catch { return ''; } }

const CFG = {
  enabled: String(process.env.UPDATE_ENABLED || 'true') !== 'false',
  branch: (process.env.UPDATE_BRANCH || brancheDuClone() || 'main').trim(),
  intervalMin: Math.max(1, Number(process.env.UPDATE_INTERVAL_MIN) || 15),
  port: Number(process.env.PORT) || 3127,
};

function npmInstall() {
  try {
    log('npm install --omit=dev…');
    execFileSync(NPM, ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', env: process.env });
    return true;
  } catch (e) { log(`npm install échoué : ${e.message}`); return false; }
}

let child = null, intentionalStop = false, startedAt = 0, fastCrashes = 0, restartTimer = null;
function startApp() {
  if (child) return;
  intentionalStop = false; startedAt = Date.now();
  log(`▶ démarrage de server.mjs (port ${CFG.port})…`);
  child = spawn(process.execPath, ['--no-warnings', 'server.mjs'], { cwd: ROOT, stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    const ranMs = Date.now() - startedAt; child = null;
    if (intentionalStop) return;
    log(`serveur arrêté (code=${code} signal=${signal}, après ${Math.round(ranMs / 1000)} s)`);
    if (ranMs < 20_000) { if (++fastCrashes >= 3) { rollback('plante au démarrage'); return; } } else fastCrashes = 0;
    const delay = Math.min(30_000, 2000 * Math.max(1, fastCrashes));
    restartTimer = setTimeout(startApp, delay);
  });
  child.on('error', (err) => log(`erreur de lancement : ${err.message}`));
  writeState({ appPid: child.pid, appStartedAt: new Date().toISOString() });
}
function stopApp() {
  return new Promise((resolve) => {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (!child) return resolve();
    intentionalStop = true; const c = child;
    const killTimer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } }, 6000);
    c.once('exit', () => { clearTimeout(killTimer); resolve(); });
    try { c.kill(); } catch { resolve(); }
  });
}

async function healthy(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${CFG.port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* pas encore */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function rollback(why) {
  const st = readState();
  log(`⚠ nouvelle version défaillante (${why}).`);
  fastCrashes = 0;
  if (st.previousSha && st.currentSha && st.previousSha !== st.currentSha) {
    log(`↩ retour à ${st.previousSha.slice(0, 8)}…`);
    try {
      await stopApp();
      git(['reset', '--hard', st.previousSha]);
      npmInstall();
      writeState({ currentSha: st.previousSha, previousSha: null, rolledBackFrom: st.currentSha, statut: 'rollback', lastDeploy: new Date().toISOString() });
    } catch (e) { log(`rollback impossible : ${e.message}`); }
  } else log('pas de version précédente connue — nouvelle tentative dans 30 s.');
  restartTimer = setTimeout(startApp, 30_000);
}

let busy = false;
async function checkForUpdate() {
  if (busy || !CFG.enabled) return;
  busy = true;
  try {
    git(['fetch', '--quiet', 'origin', CFG.branch]);
    const local = git(['rev-parse', 'HEAD']);
    const remote = git(['rev-parse', `origin/${CFG.branch}`]);
    writeState({ lastCheck: new Date().toISOString(), currentSha: local, latestSha: remote, branch: CFG.branch, statut: local === remote ? 'à jour' : 'mise à jour disponible' });
    if (local !== remote) {
      log(`🚀 déploiement de ${remote.slice(0, 8)}…`);
      git(['reset', '--hard', `origin/${CFG.branch}`]);
      let message = ''; try { message = git(['log', '-1', '--pretty=%s']); } catch { /* */ }
      npmInstall();
      const history = [{ sha: remote, message, at: new Date().toISOString() }, ...(readState().history || [])].slice(0, 20);
      writeState({ currentSha: remote, previousSha: local, statut: 'déployé', lastDeploy: new Date().toISOString(), history });
      await stopApp(); fastCrashes = 0; startApp();
      if (await healthy()) log('✅ déploiement terminé, /api/health répond.');
      else await rollback('/api/health muet après 60 s');
    }
  } catch (e) {
    const m = String(e.message || '');
    const cause = /could not read Username|Permission denied|Authentication failed|host key/i.test(m) ? 'authentification'
      : /couldn't find remote ref/i.test(m) ? 'branche-absente'
        : /could not resolve host|network is unreachable|timed out/i.test(m) ? 'reseau' : 'autre';
    log(`échec vérification (${cause}) : ${m.split('\n')[0]}`);
    if (cause === 'authentification') log('   ↳ le dépôt doit être cloné en SSH avec la clé de déploiement (voir tisseo-live.service).');
    writeState({ statut: 'erreur', cause, lastError: m.slice(0, 300), lastCheck: new Date().toISOString() });
  }
  busy = false;
}

// --- Rafraîchissement du GTFS statique ---------------------------------
// Les horaires théoriques (seule source pour le métro) couvrent une fenêtre
// d'environ un mois. Sans rafraîchissement, ils EXPIRENT en silence. On
// régénère data-live/ (hors git) quand il manque, a plus d'une semaine, ou
// expire dans moins de 14 jours. Si le serveur ne redémarre pas sainement avec
// les nouvelles données, on les retire : il retombe sur data/ (versionné).
const LIVE = path.join(ROOT, 'data-live');
const DAY = 86_400_000;
function scheduleEnd(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8'));
    const last = [...new Set(s.patterns.flat())].sort().pop();
    return last ? new Date(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8)).getTime() : 0;
  } catch { return 0; }
}
function gtfsNeedsRefresh() {
  const file = path.join(LIVE, 'schedules.json');
  if (!fs.existsSync(file)) return 'data-live absent';
  if (Date.now() - fs.statSync(file).mtimeMs > 7 * DAY) return 'plus d\'une semaine';
  if (scheduleEnd(LIVE) - Date.now() < 14 * DAY) return 'fenêtre d\'horaires bientôt close';
  return null;
}
let gtfsBusy = false;
async function refreshGtfs() {
  if (gtfsBusy || busy) return;
  const why = gtfsNeedsRefresh();
  if (!why) return;
  gtfsBusy = true;
  log(`rafraîchissement du GTFS (${why})…`);
  try {
    execFileSync(process.execPath, ['scripts/prepare-gtfs.mjs'], {
      cwd: ROOT, stdio: 'inherit', timeout: 10 * 60_000, env: { ...process.env, GTFS_OUT: 'data-live' },
    });
    const fin = scheduleEnd(LIVE);
    // Date LOCALE : toISOString() la passerait en UTC, soit la veille.
    const jusquau = fin ? new Date(fin).toLocaleDateString('sv-SE') : null;
    log(`GTFS à jour, horaires jusqu'au ${jusquau ?? '?'} — redémarrage.`);
    writeState({ gtfsRefreshedAt: new Date().toISOString(), gtfsUntil: jusquau });
    await stopApp(); fastCrashes = 0; startApp();
    if (!(await healthy())) {
      log('⚠ le serveur ne répond pas avec le nouveau GTFS : retour aux données du dépôt.');
      fs.rmSync(LIVE, { recursive: true, force: true });
      await stopApp(); startApp();
    }
  } catch (e) {
    log(`rafraîchissement GTFS échoué (données actuelles conservées) : ${String(e.message).split('\n')[0]}`);
    writeState({ gtfsError: String(e.message).slice(0, 300), gtfsErrorAt: new Date().toISOString() });
  }
  gtfsBusy = false;
}

log('superviseur Tisséo Live démarré.');
writeState({ supervisorStartedAt: new Date().toISOString(), enabled: CFG.enabled, branch: CFG.branch, intervalMin: CFG.intervalMin });
startApp();
if (CFG.enabled) {
  setTimeout(() => checkForUpdate().catch(() => {}), 8000);
  setInterval(() => checkForUpdate().catch(() => {}), CFG.intervalMin * 60_000);
  log(`mises à jour auto actives (origin/${CFG.branch}, toutes les ${CFG.intervalMin} min).`);
} else log('mises à jour désactivées : supervision seule.');
if (String(process.env.GTFS_REFRESH || 'true') !== 'false') {
  setTimeout(() => refreshGtfs().catch(() => {}), 60_000);
  setInterval(() => refreshGtfs().catch(() => {}), 6 * 3600_000);
}

function shutdown() { log('arrêt du superviseur…'); stopApp().finally(() => process.exit(0)); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('SIGHUP', shutdown);
process.on('uncaughtException', (e) => log(`exception (ignorée) : ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log(`rejet non géré (ignoré) : ${e && (e.stack || e.message)}`));
