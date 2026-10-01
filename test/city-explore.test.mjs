import test from 'node:test';
import assert from 'node:assert/strict';
import { openingState, facts, eventOnDay, eventTonight, deduplicateEvents, inPolygon, walkingBand } from '../lib/city-explore.mjs';
import { normalizeAgenda, normalizeBikes } from '../lib/city.mjs';
import { createCityContext, cityPoint, decodePolyline } from '../lib/city-context.mjs';

test('Horaires : état parisien, fermeture, nuit et syntaxe inconnue', () => {
  const at = Date.parse('2026-10-01T12:00:00Z'); // jeudi 14 h
  assert.equal(openingState('Mo-Fr 09:00-18:00', at), 'open');
  assert.equal(openingState('Mo-Fr 09:00-12:00,14:30-18:00', at), 'closed');
  assert.equal(openingState('24/7', at), 'open');
  assert.equal(openingState('Mo-Fr 09:00-18:00; Th off', at), 'closed');
  assert.equal(openingState('We 22:00-02:00', Date.parse('2026-09-30T23:00:00Z')), 'open');
  for (const hours of ['', 'PH off', 'sur rendez-vous', 'Mo-Fr 09:00-28:00']) assert.equal(openingState(hours, at), 'unknown');
});
test('Filtres : absence de renseignement ne vaut pas oui', () => {
  assert.equal(facts().wheelchair, 'unknown'); assert.equal(facts().free_access, null);
  assert.equal(facts({ vegetarian: 'no' }).vegetarian, false);
  assert.equal(facts({ 'diet:vegetarian': 'yes', wheelchair: 'yes', fee: 'no' }).vegetarian, true);
});
test('Vélos : stations fantômes sans nom exclues, date négative inconnue', () => {
  const stations=[{station_id:'1',name:'Capitole',lat:43.604,lon:1.444},{station_id:'2',name:'',lat:43.604,lon:1.444}];
  const ps=normalizeBikes({data:{stations}},{data:{stations:[{station_id:'1',last_reported:-62135596800}]}});
  assert.equal(ps.length,1);assert.equal(ps[0].reported_at,null);
});
test('Agenda : créneaux réels, pas de disponibilité entre deux séances', () => {
  const p = normalizeAgenda({ uid: '1', title_fr: 'Concert gratuit', location_coordinates: { lat:43.604,lon:1.444 }, timings: JSON.stringify([{ begin:'2026-10-01T19:00:00+02:00',end:'2026-10-01T21:00:00+02:00' },{ begin:'2026-10-03T19:00:00+02:00',end:'2026-10-03T21:00:00+02:00' }]) }, '2026-10-01');
  assert.deepEqual(p.tags,['free','concert']); assert.equal(eventOnDay(p,'2026-10-02'),false); assert.equal(eventOnDay(p,'2026-10-03'),true);
  assert.equal(normalizeAgenda({ title_fr:'Sans créneau',location_coordinates:{lat:43.604,lon:1.444} }),null);
});
test('Agenda : doublons inter-sources fusionnés, dates distinctes conservées', () => {
  const p = { name:'Concert',lat:43.604,lon:1.444,start_date:'2026-10-01',end_date:'2026-10-01',tags:['concert'],source_url:'https://example.org/a' };
  assert.equal(deduplicateEvents([p,{...p,source_url:'https://example.org/b'}]).length,1);
  assert.equal(deduplicateEvents([p,{...p,start_date:'2026-10-02'}]).length,2);
});
test('Agenda : annulation exclue, reprogrammation conservée et soirées après minuit', () => {
  const r={uid:'2',title_fr:'Concert',location_coordinates:{lat:43.604,lon:1.444},timings:[{begin:'2026-10-01T21:00:00+02:00',end:'2026-10-02T01:00:00+02:00'}]};
  assert.equal(normalizeAgenda({...r,status:'{"id":6}'},'2026-10-01'),null);
  const p=normalizeAgenda({...r,status:'{"id":2}'},'2026-10-01');assert.ok(p);
  assert.equal(eventTonight(p,'2026-10-01',Date.parse('2026-10-01T18:00:00Z')),true);
  assert.equal(eventTonight(p,'2026-10-02',Date.parse('2026-10-02T18:00:00Z')),false);
});
test('Marche : contours, trous de polygone et multi-polygones', () => {
  const square = [[1,43],[2,43],[2,44],[1,44],[1,43]],hole=[[1.4,43.4],[1.6,43.4],[1.6,43.6],[1.4,43.6],[1.4,43.4]];
  assert.equal(inPolygon(1.5,43.5,{type:'Polygon',coordinates:[square,hole]}),false);
  assert.equal(inPolygon(1.2,43.2,{type:'MultiPolygon',coordinates:[[square]]}),true);
  assert.equal(walkingBand({lon:1.2,lat:43.2},[5,10,15].map(contour=>({geometry:{type:'Polygon',coordinates:[square]},properties:{contour}}))),5);
  assert.equal(walkingBand({lon:3,lat:43.2},[]),null);
});
test('API piéton : coordonnées locales exigées, aucun tracé fictif en panne', async () => {
  assert.equal(cityPoint('',null),null); assert.equal(cityPoint(48.8,2.3),null);
  let calls=0; const service=createCityContext({fetcher:async()=>{calls++;throw new Error('offline');}});
  await assert.rejects(service.isochrone({lat:43.604,lon:1.444}));
  await assert.rejects(service.isochrone({lat:43.604,lon:1.444}));assert.equal(calls,1);
  await assert.rejects(service.walk({lat:43.4,lon:1.1},{lat:43.8,lon:1.8}),RangeError);
  assert.throws(()=>decodePolyline('_'));
});
test('API piéton : cache partagé et demande explicite piétonne', async () => {
  let calls=0;const s=createCityContext({fetcher:async(url,opts)=>{calls++;assert.equal(JSON.parse(opts.body).costing,'pedestrian');return {ok:true,json:async()=>({features:[5,10,15].map(contour=>({properties:{contour},geometry:{type:'Polygon',coordinates:[[[1,43],[2,43],[2,44],[1,43]]]}}))})};}});
  const [a,b]=await Promise.all([s.isochrone({lat:43.604,lon:1.444}),s.isochrone({lat:43.604,lon:1.444})]);assert.equal(calls,1);assert.deepEqual(a,b);
});
