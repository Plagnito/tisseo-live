// Vérification manuelle des prochains passages : sources, doublons, couverture.
// (renommer en verify.mjs — le préfixe _ le gardait hors du radar)
const API = process.env.API || 'http://localhost:3127';
const fmt = (t) => new Date(t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

async function get(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

const stops = process.argv.slice(2);
if (!stops.length) stops.push('stop_point:SP_1912', 'stop_point:SP_1572', 'stop_point:SP_793');

for (const id of stops) {
  const j = await get('/api/departures?stop_id=' + encodeURIComponent(id));
  const deps = j.departures || [];
  const src = deps.reduce((m, d) => ((m[d.source] = (m[d.source] || 0) + 1), m), {});
  console.log(`\n${j.stop?.name ?? id} (${id}) points=${j.stop?.points} n=${deps.length} src=${JSON.stringify(src)} degraded=${!!j.degraded}`);
  for (const d of deps.slice(0, 6)) {
    console.log(`   ${d.line.padEnd(4)} ${d.source.padEnd(4)} -> ${d.destination} @ ${fmt(d.time)} ${d.vehicle ? 'veh=' + d.vehicle : ''}`);
  }
  // doublons suspects : même ligne à moins de 180 s d'écart
  const dups = [];
  for (let i = 1; i < deps.length; i++) {
    if (deps[i].line === deps[i - 1].line && deps[i].time - deps[i - 1].time < 180) {
      dups.push(`${deps[i - 1].line}@${fmt(deps[i - 1].time)}(${deps[i - 1].source}) + ${deps[i].line}@${fmt(deps[i].time)}(${deps[i].source})`);
    }
  }
  if (dups.length) console.log('   ⚠ doublons:', dups.join(' | '));
}

// trajets de régression (les points acceptent un nom d'arrêt)
const journeys = [
  ['purpan', 'capitole'], ['borderouge', 'ramonville'],
  ['universite paul sabatier', 'oncopole'], ['jean jaurès', 'gare matabiau'],
];
for (const [a, b] of journeys) {
  try {
    const j = await get(`/api/journey?from=${encodeURIComponent(a)}&to=${encodeURIComponent(b)}`);
    const legs = (j.legs || []).map((l) => `${l.kind}:${l.line || l.mode || ''}${l.real ? '(rt)' : ''}`).join(' + ');
    console.log(`\nJourney ${a} -> ${b} : ${j.duration_min ?? j.duration ?? '?'} min | ${legs}`);
  } catch (e) {
    console.log(`\nJourney ${a}->${b}: ERREUR ${e.message}`);
  }
}
