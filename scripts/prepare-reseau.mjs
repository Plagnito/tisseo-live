// Prépare le GTFS statique d'un réseau : télécharge, lit, écrit <sortie>/net.json.
//   node scripts/prepare-reseau.mjs <sortie> <url> [<url>…]
// Lancé en processus à part par lib/reseaux/instance.mjs : dézipper et lire un
// GTFS de métropole prend plusieurs secondes et des centaines de mégaoctets,
// que le serveur ne doit ni attendre ni garder.
import AdmZip from 'adm-zip';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { buildNetwork } from '../lib/reseaux/gtfs.mjs';
import { buildPlan } from '../lib/reseaux/plan.mjs';
import { publicUrl } from '../lib/reseaux/instance.mjs';

// --plan : prépare les HORAIRES (plan.json, pour les itinéraires) au lieu des
// lignes et arrêts (net.json, pour la carte en direct).
const args = process.argv.slice(2);
const plan = args[0] === '--plan';
if (plan) args.shift();
const [out, ...urls] = args;
if (!out || !urls.length) { console.error('usage : prepare-reseau.mjs [--plan] <sortie> <url>…'); process.exit(2); }
const MAX = 400 * 1024 * 1024; // garde-fou : aucune archive urbaine n'approche cette taille
const MAX_FICHIER = 400 * 1024 * 1024; // au-delà, un fichier dézippé ne tiendrait pas dans une chaîne : il n'est pas lu
const LUS = new Set(['routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt', 'calendar.txt', 'calendar_dates.txt']);
// stop_times.txt et shapes.txt se lisent ligne à ligne, sans jamais former une
// seule chaîne (190 Mo à Bordeaux).
const MAX_LIGNES = 1500 * 1024 * 1024;
function* lignes(buf) {
  let s = 0;
  while (s < buf.length) {
    let e = buf.indexOf(10, s);
    if (e < 0) e = buf.length;
    yield buf.toString('utf8', s, e > s && buf[e - 1] === 13 ? e - 1 : e);
    s = e + 1;
  }
}

// Redirections suivies à la main : chaque adresse est revérifiée (ni la
// machine, ni le réseau local).
async function telecharger(adresse) {
  let u = publicUrl(adresse);
  for (let saut = 0; u && saut < 6; saut++) {
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(180_000), headers: { 'User-Agent': 'TisseoLive/1.5 (https://tisseo.plagnito.com)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = publicUrl(new URL(res.headers.get('location'), u).href); continue; }
    return res;
  }
  throw new Error('adresse refusée');
}

const feeds = [];
for (const url of urls) {
  let res;
  try { res = await telecharger(url); } catch (e) { console.error(`${e.message} ${url}`); continue; }
  if (!res.ok) { console.error(`HTTP ${res.status} ${url}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX) { console.error(`archive trop grosse (${buf.length} o) ${url}`); continue; }
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { console.error(`archive illisible ${url} : ${e.message}`); continue; }
  // Certaines archives rangent leurs fichiers dans un sous-dossier.
  const entries = new Map(zip.getEntries().filter((e) => !e.isDirectory).map((e) => [e.entryName.split('/').pop().toLowerCase(), e]));
  feeds.push({
    read: (name) => { const e = entries.get(name); return e && LUS.has(name) && e.header.size <= MAX_FICHIER ? e.getData().toString('utf8') : null; },
    lines: (name) => { const e = entries.get(name); return e && e.header.size <= MAX_LIGNES ? lignes(e.getData()) : null; },
  });
}
if (!feeds.length) { console.error('aucune archive lisible'); process.exit(1); }

const net = plan ? buildPlan(feeds) : buildNetwork(feeds);
if (!net.routes.length) { console.error(plan ? 'aucune ligne en circulation dans les horaires publiés' : 'aucune ligne dans le GTFS'); process.exit(1); }
net.sources = urls;
const nom = plan ? 'plan.json' : 'net.json';
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${nom}.tmp`), JSON.stringify(net));
renameSync(join(out, `${nom}.tmp`), join(out, nom));
console.log(JSON.stringify(net.counts));
