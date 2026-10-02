import test from 'node:test';
import assert from 'node:assert/strict';
import {createCityDirectory,frenchProfile,photonProfile,normalizeCityOsm,normalizeCityExport,osmCategories,profileCatalog,TOULOUSE} from '../lib/cities.mjs';
const lyon={nom:'Lyon',code:'69123',centre:{coordinates:[4.8357,45.764]},departement:{nom:'Rhône'}};
const response=value=>({ok:true,json:async()=>value});
test('Les profils utilisent le centre géographique et limitent Tisséo à Toulouse',()=>{
  const profile=frenchProfile(lyon);assert.equal(profile.lat,45.764);assert.equal(profile.transport,'osm');assert.equal(profile.timezone,'Europe/Paris');assert.equal(frenchProfile({...lyon,centre:{coordinates:[4,95]}}),null);
  assert.equal(profileCatalog(TOULOUSE).categories.length,14);const catalog=profileCatalog(profile);assert.equal(catalog.categories.length,15);assert(catalog.categories.every(c=>!c.live));assert(catalog.categories.some(c=>c.id==='stops'));
  assert.equal(photonProfile({geometry:{coordinates:[13.4,52.5]},properties:{name:'Berlin',countrycode:'de'}}).country_code,'DE');
});
test('Un lieu OSM hors Toulouse conserve sa ville et les données inconnues',()=>{
  const p=normalizeCityOsm('bikes',{type:'node',id:7,lat:45.76,lon:4.83,tags:{amenity:'bicycle_rental',name:'Station',website:'javascript:bad'}},frenchProfile(lyon));assert.equal(p.city_id,'fr:69123');assert.equal(p.bikes,null);assert.equal(p.url,null);assert.equal(p.opening_state,'unknown');
  assert.deepEqual(osmCategories({amenity:'toilets',access:'customers'}),[]);assert.deepEqual(osmCategories({highway:'bus_stop'}),['stops']);
});
test('Les exports OSM couvrent les arrondissements et indiquent leur portée partielle',async()=>{
  const row={name:null,meta_geo_point:{lat:45.76,lon:4.83},meta_osm_url:'https://www.openstreetmap.org/node/10',meta_code_com:'69383',access:'yes'};
  const profile=frenchProfile(lyon),place=normalizeCityExport('parks',row,profile,'osm-france-playground');assert.equal(place.name,'Aire de jeux');assert.match(place.description,/ne recense pas tous les parcs/);assert.equal(normalizeCityExport('parks',{...row,access:'private'},profile,'osm-france-playground'),null);
  let calls=0;const directory=createCityDirectory({fetcher:async url=>{calls++;assert.match(decodeURIComponent(url),/within_distance/);return response([row]);}});
  const data=await directory.places(profile,'parks');assert.equal(data.status,'ok');assert.equal(data.places[0].city_id,profile.id);assert.match(data.source.label,/aires de jeux/);await directory.places(profile,'parks');assert.equal(calls,1);
});
test('Recherche, détection et extraction par catégorie restent séparées par ville',async()=>{
  let osm=0,enVol=0,maxEnVol=0;const requetes=[];const directory=createCityDirectory({exportsEnabled:false,osmGapMs:0,fetcher:async(url,options)=>{if(options?.method==='POST'){osm++;requetes.push(decodeURIComponent(options.body));enVol++;maxEnVol=Math.max(maxEnVol,enVol);await new Promise(r=>setTimeout(r,5));enVol--;return response({elements:[{type:'node',id:1,lat:45.76,lon:4.83,tags:{name:'Parc Lyon',leisure:'park'}}]});}return response(url.includes('/communes/69123')?lyon:[lyon]);}});
  assert.equal((await directory.search('Lyon'))[0].id,'fr:69123');const profile=await directory.detect(45.76,4.83);assert.equal(profile.name,'Lyon');const [a,b]=await Promise.all([directory.places(profile,'parks'),directory.places(profile,'culture')]);assert.equal(osm,2,'une requête par catégorie');assert.equal(maxEnVol,1,'jamais deux requêtes OSM à la fois');assert.ok(requetes.some(q=>q.includes('leisure')&&!q.includes('bus_stop')&&!q.includes('theatre')),'la requête des parcs ne demande que les parcs');assert.equal(a.places[0].name,'Parc Lyon');assert.equal(b.places.length,0);await directory.places(profile,'parks');assert.equal(osm,2,'une catégorie déjà lue n’est pas redemandée');assert.equal((await directory.get()).name,'Toulouse');await assert.rejects(directory.get('invalid'),RangeError);
});
test('Recherche internationale utilise Photon et ne transforme pas un cache de liste en objet',async()=>{
  let time=2000,fail=false;const directory=createCityDirectory({exportsEnabled:false,now:()=>time,fetcher:async url=>{if(url.includes('geo.api'))return response([]);if(fail)throw new Error('offline');return response({features:[{geometry:{coordinates:[13.4,52.5]},properties:{name:'Berlin',country:'Allemagne'}}]});}});
  const first=await directory.search('Berlin');assert.equal(first[0].name,'Berlin');time+=86400001;fail=true;assert.deepEqual(await directory.search('Berlin'),first);
});
test('Une panne OSM est annoncée et les anciennes données ne deviennent pas des données fraîches',async()=>{
  let time=0,fail=false;const directory=createCityDirectory({exportsEnabled:false,osmGapMs:0,now:()=>time,overpassUrls:['test:osm'],fetcher:async()=>{if(fail)throw new Error('offline');return response({elements:[{type:'node',id:1,lat:45.76,lon:4.83,tags:{name:'Parc',leisure:'park'}}]});}});const profile=frenchProfile(lyon);const first=await directory.places(profile,'parks');time=6*3600000+1;fail=true;const old=await directory.places(profile,'parks');assert.equal(old.status,'stale');assert.equal(old.fetched_at,first.fetched_at);assert.equal(old.places.length,1);
});
