// Vérifie un serveur MCP Tisséo Live EN MARCHE, comme le ferait ChatGPT :
// poignée de main, liste des outils, puis un appel réel de chaque outil.
//
//   node scripts/verifier-mcp.mjs                       # http://localhost:3127/mcp
//   node scripts/verifier-mcp.mjs https://…/mcp         # un déploiement
//   node scripts/verifier-mcp.mjs <url> --bavard        # affiche les réponses
//
// Rend 0 si tout répond sans erreur d'outil, 1 sinon.
const url = process.argv.find((a) => /^https?:\/\//.test(a)) ?? 'http://localhost:3127/mcp';
const bavard = process.argv.includes('--bavard');
let id = 0;

async function rpc(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status} : ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  if (j.error) throw new Error(`${method} → ${j.error.message}`);
  return j.result;
}

const CAS = [
  ['etat_du_reseau', {}],
  ['lignes', { mode: 'tram' }],
  ['ligne', { ligne: 'T1' }],
  ['vehicules', { limite: 3 }],
  ['vehicules', { ligne: 'L1' }],
  ['vehicules', { autour_de: 'Jean Jaurès', rayon_m: 1500 }],
  ['rechercher_lieu', { recherche: 'aéroport de Blagnac' }],
  ['prochains_passages', { arret: 'Capitole', nombre: 5 }],
  ['prochains_passages', { arret: 'Jean Jaurès', ligne: 'B', nombre: 4 }],
  ['arrets_proches', { lieu: 'Cité de l\'Espace', nombre: 3 }],
  ['itineraire', { depart: 'Gare Matabiau', arrivee: 'aéroport de Blagnac' }],
  ['itineraire', { depart: '12 rue Alsace-Lorraine', arrivee: 'Université Paul Sabatier', heure_depart: '8h15' }],
  ['perturbations', { ligne: 'A' }],
  ['perturbations', { recherche: 'travaux' }],
  ['vehicules', { mode: 'metro' }],
  ['arret', { arret: 'Jean Jaurès' }],
  ['horaires', { arret: 'Capitole', ligne: 'A', jour: 'samedi' }],
  ['horaires', { arret: 'Jean Jaurès', jour: 'demain', detail: false }],
  ['ligne', { ligne: 'B', avec_arrets: false }],
  ['itineraire', { depart: 'Capitole', arrivee: 'Université Paul Sabatier', arriver_avant: '9h00', options: 3 }],
  ['itineraire', { depart: 'Gare Matabiau', arrivee: 'Basso Cambo', heure_depart: '17:30', sans_modes: ['bus'] }],
  ['accessibles_depuis', { lieu: 'Capitole', minutes: 15, limite: 5 }],
  ['tarifs', {}],
  ['tarifs', { ligne: 'AERO' }],
  ['search', { query: 'Jean Jaurès' }],
  ['fetch', { id: 'ligne:line:61' }],
];

let echecs = 0;
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verifier-mcp', version: '1' } });
console.log(`✓ initialize : ${init.serverInfo.title} ${init.serverInfo.version} (protocole ${init.protocolVersion})`);
const { tools } = await rpc('tools/list');
console.log(`✓ tools/list : ${tools.map((t) => t.name).join(', ')}`);

// Un premier véhicule réel, pour tester « vehicule ».
const v0 = (await rpc('tools/call', { name: 'vehicules', arguments: { limite: 1 } })).structuredContent?.vehicules?.[0];
if (v0) CAS.push(['vehicule', { ligne: v0.ligne, vehicule_id: v0.vehicule_id, points_trace: 3 }]);

for (const [name, args] of CAS) {
  const t = Date.now();
  try {
    const r = await rpc('tools/call', { name, arguments: args });
    const ms = Date.now() - t;
    if (r.isError) {
      echecs++;
      console.log(`✗ ${name} ${JSON.stringify(args)} → ${r.content[0].text}`);
      continue;
    }
    const s = r.structuredContent;
    const resume = s.total ?? s.passages?.length ?? s.etapes?.length ?? s.arrets?.length ?? s.lignes?.length ?? '';
    const extra = name === 'itineraire' ? ` ${s.depart.nom} → ${s.arrivee.nom}, ${s.duree_min} min, ${s.etapes.filter((e) => e.type === 'trajet').map((e) => e.ligne).join(' + ')}` : '';
    console.log(`✓ ${name} ${JSON.stringify(args)} (${ms} ms) ${resume}${extra}`);
    if (bavard) console.log(JSON.stringify(s, null, 1).slice(0, 3000));
  } catch (err) {
    echecs++;
    console.log(`✗ ${name} → ${err.message}`);
  }
}
console.log(echecs ? `\n${echecs} échec(s).` : '\nTout répond.');
process.exit(echecs ? 1 : 0);
