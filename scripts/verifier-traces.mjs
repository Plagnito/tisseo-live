// Contrôle qualité : chaque arrêt doit être proche du tracé de sa ligne.
// C'est le seul test qui dit si le « tracé » suit vraiment la route — le
// GTFS statique contient des shapes qu'on n'a pas pu comparer à un fond de
// carte ici, mais les arrêts, eux, sont une vérité terrain.
import fs from 'node:fs';
import { snapToShape } from '../lib/core.mjs';

const routes = JSON.parse(fs.readFileSync('data/routes.json', 'utf8'));
const stops = JSON.parse(fs.readFileSync('data/stops.json', 'utf8'));
const variants = JSON.parse(fs.readFileSync('data/route_variants.json', 'utf8'));

const rapples = [];
let worstGlobal = { d: 0, id: '', route: '' };
for (const r of routes) {
  const list = variants[r.route_id] || [];
  if (!list.length) continue;
  const ds = [];
  for (const v of list) {
    if (!Array.isArray(v.shape) || v.shape.length < 2) continue;
    for (const id of v.stops) {
      const s = stops[id];
      if (!s || s.lat == null || s.lon == null) continue;
      const hit = snapToShape(s.lat, s.lon, v.shape);
      if (!hit) continue;
      const d = Math.sqrt(hit.d2);
      ds.push({ d, id, nom: s.n, dir: v.dir });
      if (d > worstGlobal.d) worstGlobal = { d, id: `${r.short_name} ${s.n}`, route: r.route_id };
    }
  }
  if (!ds.length) continue;
  ds.sort((a, b) => b.d - a.d);
  const bad = ds.filter((x) => x.d > 100);
  if (bad.length) {
    rapples.push({ ligne: r.short_name, id: r.route_id, total: ds.length, loin: bad.length, pire: ds[0] });
  }
}

console.log(`lignes avec au moins un arrêt à plus de 100 m du tracé : ${rapples.length} / ${routes.length}`);
for (const x of rapples.slice(0, 15)) {
  console.log(`  ${x.ligne} (${x.id}) : ${x.loin}/${x.total} arrêts hors tracé, pire ${Math.round(x.pire.d)} m — ${x.pire.nom}`);
}
console.log(`pire global : ${Math.round(worstGlobal.d)} m sur « ${worstGlobal.id} »`);
