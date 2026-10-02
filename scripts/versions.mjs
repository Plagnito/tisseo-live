// La chaîne de version des fichiers servis au navigateur (« ?v=… »).
//
// Pourquoi elle compte : le CDN garde les .js et .css PAR ADRESSE, des heures
// durant, quels que soient les en-têtes de cache de l'origine (constaté le
// 02/10/2026 : sw.js servi « HIT » 23 s après un « no-store », et l'ancien
// service worker encore servi huit heures après un déploiement). Un fichier
// modifié sans changer d'adresse n'atteint donc pas les navigateurs. La seule
// chose qui le fasse arriver est une adresse neuve : relever la version.
//
//   node scripts/versions.mjs            vérifie (code 1 si quelque chose cloche)
//   node scripts/versions.mjs --ecrire   enregistre l'état courant APRÈS avoir relevé la version
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERROU = join(racine, 'versions.lock.json');
const lire = (f) => readFileSync(join(racine, 'public', f), 'utf8');
// Fins de ligne normalisées : git peut les convertir d'une machine à l'autre.
const empreinte = (f) => createHash('sha256').update(lire(f).replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

export function etat() {
  const index = lire('index.html');
  const versionnes = [...index.matchAll(/(?:src|href)="([\w./-]+\.(?:js|css))\?v=([\w.-]+)"/g)].map((m) => ({ fichier: m[1], version: m[2] }));
  const sw = lire('sw.js');
  const dansSw = [...sw.matchAll(/'\.\/([\w./-]+\.(?:js|css))\?v=([\w.-]+)'/g)].map((m) => ({ fichier: m[1], version: m[2] }));
  const enregistrement = /serviceWorker\.register\('sw\.js\?v=([\w.-]+)'/.exec(lire('app.js'))?.[1] ?? null;
  const versions = new Set([...versionnes, ...dansSw].map((x) => x.version));
  if (enregistrement) versions.add(enregistrement);
  const fichiers = [...new Set([...versionnes.map((x) => x.fichier), 'sw.js'])].sort();
  return {
    version: versions.size === 1 ? [...versions][0] : null,
    versions: [...versions],
    enregistrement,
    manquentAuSw: versionnes.filter((x) => !dansSw.some((y) => y.fichier === x.fichier)).map((x) => x.fichier),
    empreintes: Object.fromEntries(fichiers.map((f) => [f, empreinte(f)])),
  };
}

/** Rend la liste des défauts (vide = tout va bien). */
export function verifier() {
  const e = etat();
  const defauts = [];
  if (!e.version) defauts.push(`plusieurs versions coexistent (${e.versions.join(', ')}) : index.html, sw.js et l'enregistrement du service worker dans app.js doivent porter la même.`);
  if (!e.enregistrement) defauts.push('app.js n’enregistre plus le service worker sous une adresse versionnée.');
  if (e.manquentAuSw.length) defauts.push(`absents du précache de sw.js : ${e.manquentAuSw.join(', ')}.`);
  let verrou = null;
  try { verrou = JSON.parse(readFileSync(VERROU, 'utf8')); } catch { defauts.push('versions.lock.json absent ou illisible : lance « node scripts/versions.mjs --ecrire ».'); }
  if (verrou && e.version) {
    const changes = Object.keys(e.empreintes).filter((f) => verrou.empreintes?.[f] !== e.empreintes[f]);
    if (changes.length && verrou.version === e.version) {
      defauts.push(`modifié(s) sans relever la version « ${e.version} » : ${changes.join(', ')}. Le CDN continuera de servir l'ancienne copie. Relève la version partout (index.html, sw.js, app.js), puis « node scripts/versions.mjs --ecrire ».`);
    } else if (changes.length || verrou.version !== e.version) {
      defauts.push('version relevée mais verrou pas à jour : lance « node scripts/versions.mjs --ecrire ».');
    }
  }
  return defauts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--ecrire')) {
    const e = etat();
    if (!e.version) { console.error(`Versions incohérentes : ${e.versions.join(', ')}`); process.exit(1); }
    writeFileSync(VERROU, JSON.stringify({ version: e.version, empreintes: e.empreintes }, null, 2) + '\n');
    console.log(`Verrou écrit pour la version ${e.version} (${Object.keys(e.empreintes).length} fichiers).`);
  } else {
    const d = verifier();
    for (const x of d) console.error('✖ ' + x);
    if (!d.length) console.log(`Version ${etat().version} : cohérente, et rien n’a changé sans elle.`);
    process.exit(d.length ? 1 : 0);
  }
}
