import { haversineM } from './core.mjs';
import { CITY_CATEGORIES, cityCatalog, normalizeAgenda, safeUrl } from './city.mjs';
import { facts, openingState, deduplicateEvents, slimEvent } from './city-explore.mjs';
import { worldPoint } from './city-context.mjs';
export const TOULOUSE = { id: 'fr:31555', name: 'Toulouse', lat: 43.6047, lon: 1.4442, country: 'France', country_code: 'FR', timezone: 'Europe/Paris', transport: 'tisseo' };
const UA = 'VillePromenade/1.1 (https://tisseo.plagnito.com/)';
const OSM_SOURCE = { label: 'OpenStreetMap · contributeurs', url: 'https://www.openstreetmap.org/copyright', license: 'ODbL' };
const EXPORT_TYPES={parking:'parking-area',culture:'cinema',visits:'historic',food:'food-service',parks:'playground',sports:'sport-facility',libraries:'library',services:'public-service',water:'drinking-water'};
function exportDataset(profile,category){const country={FR:'france',AU:'australia',NZ:'new-zealand'}[profile.country_code];return country&&EXPORT_TYPES[category]?`osm-${country}-${EXPORT_TYPES[category]}`:null;}
function exportSource(dataset){return {label:`OpenStreetMap · export Huwise${dataset.endsWith('playground')?' · aires de jeux':dataset.endsWith('cinema')?' · cinémas':''}`,url:`https://public.opendatasoft.com/explore/dataset/${dataset}/`,license:'ODbL'};}
const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
export function frenchProfile(r) {
  const p = worldPoint(r.centre?.coordinates?.[1], r.centre?.coordinates?.[0]);
  if (!p || !/^[\dAB]{5}$/.test(r.code || '') || !clean(r.nom)) return null;
  return { ...p, id: `fr:${r.code}`, name: clean(r.nom), country: 'France', country_code: 'FR', region: clean(r.departement?.nom || r.codeDepartement), transport: r.code === '31555' ? 'tisseo' : 'osm', timezone: p.lat > 40 && p.lat < 52 && p.lon > -6 && p.lon < 11 ? 'Europe/Paris' : null };
}
export function photonProfile(f) {
  const p = worldPoint(f.geometry?.coordinates?.[1], f.geometry?.coordinates?.[0]), tags = f.properties || {};
  if (!p || !clean(tags.name || tags.city)) return null;
  return { ...p, id: `geo:${p.lat.toFixed(4)}:${p.lon.toFixed(4)}`, name: clean(tags.name || tags.city), country: clean(tags.country), country_code: clean(tags.countrycode).toUpperCase(), region: clean(tags.state), transport: 'osm', timezone: null };
}
export function osmCategories(t) {
  const ids = [];
  if (t.amenity === 'bicycle_rental') ids.push('bikes');
  if (t.amenity === 'parking') ids.push('parking');
  if (['museum','gallery'].includes(t.tourism) || ['theatre','cinema','arts_centre','community_centre'].includes(t.amenity)) ids.push('culture');
  if (t.historic || ['attraction','artwork'].includes(t.tourism)) ids.push('visits');
  if (['restaurant','cafe','fast_food','bar','pub','food_court','ice_cream'].includes(t.amenity)) ids.push('food');
  if (['park','garden','playground'].includes(t.leisure)) ids.push('parks');
  if (t.amenity === 'marketplace') ids.push('markets');
  if (['sports_centre','pitch','stadium','swimming_pool'].includes(t.leisure)) ids.push('sports');
  if (t.amenity === 'library') ids.push('libraries');
  if (['townhall','post_office'].includes(t.amenity)) ids.push('services');
  if (t.amenity === 'drinking_water') ids.push('water');
  if (t.amenity === 'toilets' && !['private','no','customers'].includes(t.access)) ids.push('toilets');
  if (t.highway === 'construction' || t.landuse === 'construction') ids.push('works');
  if (t.highway === 'bus_stop' || t.public_transport === 'platform' || ['station','tram_stop','halt','subway_entrance'].includes(t.railway)) ids.push('stops');
  return ['private','no'].includes(t.access) ? [] : ids;
}
export function normalizeCityOsm(category, element, profile) {
  const p = worldPoint(element.lat ?? element.center?.lat, element.lon ?? element.center?.lon), t = element.tags || {};
  if (!p || haversineM(profile.lat,profile.lon,p.lat,p.lon)>6000 || !['node','way','relation'].includes(element.type) || !Number.isFinite(Number(element.id))) return null;
  const fallback = { water: 'Point d’eau potable', toilets: 'Toilettes', stops: 'Arrêt de transport', bikes: 'Station vélo', parking: 'Parking', works: 'Chantier référencé' };
  if(['private','no'].includes(t.access))return null;const name = clean(t['name:fr'] || t.name || fallback[category]); if (!name) return null;
  const fields = Object.entries({ 'Horaires déclarés': t.opening_hours, 'Accès PMR déclaré': t.wheelchair, 'Accès': t.access, 'Payant': t.fee, 'Cuisine': t.cuisine, 'Réseau': t.network, 'Opérateur': t.operator }).filter(([,v]) => v).map(([label,value]) => ({label,value:clean(value)}));
  return { ...p, ...facts(t), category, id: `${profile.id}:${category}:osm:${element.type}:${element.id}`, city_id: profile.id, city: profile.name, name, subtitle: clean(t.amenity || t.tourism || t.leisure || t.railway || category), address: clean([t['addr:housenumber'],t['addr:street']].filter(Boolean).join(' ')), url: safeUrl(t.website || t['contact:website']), phone: clean(t.phone || t['contact:phone']), description: clean(t.description || (category === 'bikes' ? 'Station référencée. Disponibilités en direct non fournies par cette source.' : category === 'works' ? 'Chantier référencé dans OSM ; sa présence actuelle est à vérifier.' : '')), details: fields, source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`, source_label: OSM_SOURCE.label, source_license: 'ODbL', bikes: null, docks: null, reported_at: null, opening_state: profile.timezone === 'Europe/Paris' ? openingState(t.opening_hours) : 'unknown' };
}
export function normalizeCityExport(category,row,profile,dataset){
  const url=safeUrl(row.meta_osm_url),match=url?.match(/^https:\/\/(?:www\.)?openstreetmap\.org\/(node|way|relation)\/(\d+)\/?$/);if(!match)return null;
  const tags={...row,name:row.name||({parks:'Aire de jeux',water:'Point d’eau potable',parking:'Parking'}[category]),amenity:row.type||category,leisure:category==='parks'?'playground':row.leisure,website:row.website,opening_hours:row.opening_hours};
  const place=normalizeCityOsm(category,{type:match[1],id:Number(match[2]),lat:row.meta_geo_point?.lat,lon:row.meta_geo_point?.lon,tags},profile);
  return place?{...place,source_label:exportSource(dataset).label,source_url:url,description:category==='parks'?'Aire de jeux référencée dans OSM. Cet export ne recense pas tous les parcs et jardins.':category==='culture'?'Cinéma référencé dans OSM. Cet export ne recense pas tous les équipements culturels.':place.description}:null;
}
export function profileCatalog(profile) {
  if (profile.transport === 'tisseo') return { ...cityCatalog(), profile };
  return { city: profile.name, profile, categories: [...CITY_CATEGORIES.map((c) => ({ ...c, label: c.id === 'bikes' ? 'Stations vélo' : c.id==='parks'?'Parcs & aires de jeux':c.label, live: false, source: c.id === 'events' ? { label:'OpenAgenda · agenda public', url:'https://public.opendatasoft.com/explore/dataset/evenements-publics-openagenda/', license:'Licence Ouverte' } : exportDataset(profile,c.id)?exportSource(exportDataset(profile,c.id)):OSM_SOURCE })), { id:'stops', label:'Arrêts de transports', group:'mobility', icon:'pin', color:'#79a9f4', source:OSM_SOURCE }], notice: 'Lieux OSM dans un rayon de 6 km du centre choisi, couverture partielle. L’agenda dépend des publications OpenAgenda. Les disponibilités vélo et les passages en direct dépendent des sources de chaque réseau.' };
}
// Sélecteurs OSM de chaque catégorie (voir osmCategories, qui fait le tri inverse).
const OSM_SELECTORS = {
  bikes: ['[amenity=bicycle_rental]'],
  parking: ['[amenity=parking]'],
  culture: ['[amenity~"^(theatre|cinema|arts_centre|community_centre)$"]', '[tourism~"^(museum|gallery)$"]'],
  visits: ['[tourism~"^(attraction|artwork)$"]', '[historic]'],
  food: ['[amenity~"^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream)$"]'],
  parks: ['[leisure~"^(park|garden|playground)$"]'],
  markets: ['[amenity=marketplace]'],
  sports: ['[leisure~"^(sports_centre|pitch|stadium|swimming_pool)$"]'],
  libraries: ['[amenity=library]'],
  services: ['[amenity~"^(townhall|post_office)$"]'],
  water: ['[amenity=drinking_water]'],
  toilets: ['[amenity=toilets]'],
  works: ['[highway=construction]', '[landuse=construction]'],
  stops: ['[highway=bus_stop]', '[public_transport=platform]', '[railway~"^(station|tram_stop|halt|subway_entrance)$"]'],
};
// Les lieux de chaque catégorie de chaque ville visitée sont gardés six heures :
// une quinzaine d'entrées par ville.
const CACHE_MAX = 320;
export function createCityDirectory({ fetcher = fetch, now = Date.now, exportsEnabled = true, osmGapMs = 1200, photonUrl = process.env.CITY_GEOCODER_URL || 'https://photon.komoot.io', overpassUrls = [process.env.CITY_OVERPASS_URL || 'https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter'] } = {}) {
  const profiles = new Map([[TOULOUSE.id, TOULOUSE]]), cache = new Map(), pending = new Map(); let geoQueue = Promise.resolve(), lastGeo = 0;
  async function json(url, { timeoutMs = 20_000, ...options } = {}) { const r = await fetcher(url,{...options,signal:AbortSignal.timeout(timeoutMs),headers:{'User-Agent':UA,Accept:'application/json',...options.headers}});if(!r.ok)throw new Error(`Source HTTP ${r.status}`);return r.json(); }
  // errorTtl : durée pendant laquelle un échec est retenu sans réessayer.
  async function memo(key,ttl,load,errorTtl=60000){const hit=cache.get(key);if(hit&&now()<hit.until){if(hit.error)throw hit.error;return hit.value;}if(pending.has(key))return pending.get(key);const task=(async()=>{try{const value=await load();cache.set(key,{value,until:now()+ttl});return value;}catch(error){if(hit?.value){const value=key.startsWith('osm:')||key.startsWith('events:')?{...hit.value,status:'stale'}:hit.value;cache.set(key,{value,until:now()+errorTtl});return value;}cache.set(key,{error,until:now()+errorTtl});throw error;}finally{pending.delete(key);while(cache.size>CACHE_MAX)cache.delete(cache.keys().next().value);}})();pending.set(key,task);return task;}
  function remember(profile){if(profile){profiles.set(profile.id,profile);while(profiles.size>128){const key=profiles.keys().next().value;if(key===TOULOUSE.id){profiles.delete(key);profiles.set(key,TOULOUSE);}else profiles.delete(key);}}return profile;}
  function photon(path){const task=geoQueue.then(async()=>{const wait=1000-(now()-lastGeo);if(wait>0)await new Promise(r=>setTimeout(r,wait));lastGeo=now();return json(photonUrl+path);});geoQueue=task.catch(()=>{});return task;}
  async function search(q){q=clean(q).slice(0,80);if(q.length<2)return [];return memo('search:'+q.toLowerCase(),86400000,async()=>{let french=[];try{const rows=await json('https://geo.api.gouv.fr/communes?'+new URLSearchParams({nom:q,boost:'population',limit:'8',fields:'nom,code,centre,departement,codeDepartement'}));french=Array.isArray(rows)?rows.map(frenchProfile).filter(Boolean):[];}catch{}if(french.some(p=>p.name.localeCompare(q,'fr',{sensitivity:'base'})===0))return french.map(remember);let global=[];try{const result=await photon('/api/?'+new URLSearchParams({q,layer:'city',limit:'8',lang:'fr'}));global=(result.features||[]).map(photonProfile).filter(Boolean);}catch(error){if(!french.length)throw error;}return [...global,...french].filter((p,i,list)=>list.findIndex(x=>x.name===p.name&&Math.abs(x.lat-p.lat)<.05&&Math.abs(x.lon-p.lon)<.05)===i).slice(0,8).map(remember);});}
  async function detect(lat,lon){const point=worldPoint(lat,lon);if(!point)throw new RangeError('Coordonnées invalides');return memo(`detect:${point.lat.toFixed(2)},${point.lon.toFixed(2)}`,86400000,async()=>{let rows=[];try{rows=await json('https://geo.api.gouv.fr/communes?'+new URLSearchParams({...point,fields:'nom,code,centre,departement,codeDepartement'}));}catch{}if(Array.isArray(rows)&&rows.length){const profile=frenchProfile(rows[0]);if(profile)return remember(profile);}const result=await photon('/reverse?'+new URLSearchParams({...point,layer:'city',limit:'1',radius:'40',lang:'fr'}));const profile=photonProfile(result.features?.[0]);if(!profile)throw new Error('Ville non identifiée');return remember(profile);});}
  async function get(id=TOULOUSE.id){if(profiles.has(id))return profiles.get(id);if(/^fr:[\dAB]{5}$/.test(id)){return memo('profile:'+id,86400000,async()=>{const r=await json('https://geo.api.gouv.fr/communes/'+id.slice(3)+'?fields=nom,code,centre,departement,codeDepartement');const profile=frenchProfile(r);if(!profile)throw new Error('Ville inconnue');return remember(profile);});}if(/^geo:-?\d{1,2}\.\d{4}:-?\d{1,3}\.\d{4}$/.test(id)){const [,lat,lon]=id.split(':');return detect(lat,lon);}throw new RangeError('Ville inconnue');}
  // Une requête Overpass PAR CATÉGORIE, et une seule à la fois.
  //
  // Avant, une requête unique demandait les dix-sept thèmes d'un coup. Sur une
  // ville dense elle n'aboutissait jamais (Paris : « Query timed out » après
  // 26 s, mesuré le 02/10/2026) et emportait avec elle les cinq catégories qui
  // n'ont pas d'autre source. Découpée, chaque catégorie réussit ou échoue
  // seule, en quelques secondes. La file évite de se faire refuser pour excès
  // de requêtes simultanées (HTTP 429), et un serveur qui vient d'échouer est
  // laissé de côté deux minutes plutôt que réessayé à chaque catégorie.
  let osmQueue=Promise.resolve(),osmLast=0;const osmDown=new Map();
  async function osm(profile,category){return memo('osm:'+profile.id+':'+category,6*3600000,()=>{const task=osmQueue.then(async()=>{const wait=osmGapMs-(Date.now()-osmLast);if(wait>0)await new Promise(r=>setTimeout(r,wait));const dy=6/111,dx=6/(111*Math.cos(profile.lat*Math.PI/180)),west=profile.lon-dx,east=profile.lon+dx;
      const ranges=west < -180 ? [[west+360,180],[-180,east]] : east > 180 ? [[west,180],[-180,east-360]] : [[west,east]];
      const boxes=ranges.map(([w,e])=>`${profile.lat-dy},${w},${profile.lat+dy},${e}`);
      const selectors=OSM_SELECTORS[category];if(!selectors)throw new RangeError('Catégorie inconnue');
      const query='[out:json][timeout:20];('+selectors.map(selector=>boxes.map(box=>`nwr(${box})${selector};`).join('')).join('')+');out center 900;';
      for(const url of overpassUrls){if(now()<(osmDown.get(url)||0))continue;try{const response=await json(url,{method:'POST',timeoutMs:25_000,headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:query}).toString()});if(!Array.isArray(response.elements)||response.remark)throw new Error('Réponse OSM incomplète');return {elements:[...new Map(response.elements.map(e=>[e.type+':'+e.id,e])).values()],status:'ok',fetched_at:new Date(now()).toISOString(),truncated:response.elements.length>=900};}catch(error){osmDown.set(url,now()+120_000);console.warn('OSM source:',new URL(url).hostname,category,error.message,error.cause?.code||'');}}throw new Error('Lieux OSM momentanément indisponibles');});
      osmQueue=task.then(()=>{osmLast=Date.now();},()=>{osmLast=Date.now();});return task;},180_000);}
  async function events(profile){return memo('events:'+profile.id,20*60000,async()=>{const day=new Date(now()-86400000).toISOString().slice(0,10);const where=profile.id.startsWith('fr:')?`location_insee="${profile.id.slice(3)}"`:`location_city="${profile.name.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;const url='https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/exports/json?'+new URLSearchParams({where:`${where} AND lastdate_end >= "${day}"`,limit:'3000'});const rows=await json(url);if(!Array.isArray(rows))throw new Error('Agenda indisponible');const parser=(r)=>worldPoint(r.geo_point?.lat,r.geo_point?.lon);return {places:deduplicateEvents(rows.map(r=>normalizeAgenda(r,day,parser)).filter(Boolean).map(p=>({...p,city_id:profile.id,id:profile.id+':'+p.id}))).map(p=>slimEvent(p)),status:'ok',fetched_at:new Date(now()).toISOString()};});}
  async function exported(profile,category){const dataset=exportDataset(profile,category);return memo('export:'+profile.id+':'+category,6*3600000,async()=>{
    const query=new URLSearchParams({where:`within_distance(meta_geo_point,geom'POINT(${profile.lon} ${profile.lat})',6 km)`,limit:'700'});
    const rows=await json(`https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/${dataset}/exports/json?${query}`);if(!Array.isArray(rows))throw new Error('Export OSM indisponible');
    return {category,source:exportSource(dataset),status:'ok',fetched_at:new Date(now()).toISOString(),places:rows.map(row=>normalizeCityExport(category,row,profile,dataset)).filter(Boolean),message:category==='parks'?'Aires de jeux référencées · cet export ne couvre pas tous les parcs.':category==='culture'?'Cinémas référencés · cet export ne couvre pas tous les lieux culturels.':'Export OSM partiel dans un rayon de 6 km.'};
  });}
  async function places(profile,category){const source=profileCatalog(profile).categories.find(c=>c.id===category)?.source;if(!source)throw new RangeError('Catégorie inconnue');try{if(category==='events')return {...await events(profile),category,source};if(exportsEnabled&&exportDataset(profile,category)){try{return await exported(profile,category);}catch{}}const data=await osm(profile,category);const all=data.elements.filter(e=>osmCategories(e.tags||{}).includes(category)).map(e=>normalizeCityOsm(category,e,profile)).filter(Boolean);return {category,source:OSM_SOURCE,status:data.status,fetched_at:data.fetched_at,places:all.slice(0,700),message:data.status==='stale'?'Source indisponible · dernières données conservées.':all.length>700||data.truncated?'Couverture partielle · extraction limitée.':undefined};}catch{return {category,source,status:'unavailable',fetched_at:null,places:[],message:'Source momentanément indisponible. Réessaie dans une minute.'};}}
  return {search,detect,get,places};
}
