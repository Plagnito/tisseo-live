/* Tisséo Live — frontend carte */
'use strict';

const REFRESH_S = 15;
const readJson = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const state = {
  vehicles: [],
  routes: [],
  alerts: [],
  // Lignes citées par au moins une info trafic non anodine : leurs véhicules
  // reçoivent un contour d'alerte sur la carte.
  alertRoutes: new Set(),
  alertHover: null, // lignes survolées dans la liste des infos trafic
  rtTimestamp: 0,
  filterLine: null, // route_id
  mode: 'all', // all | bus | tram | teleo
  query: '',
  selectedId: null, // clé véhicule
  selectedStop: null, // { id, name, lat, lon }
  stopDeps: [],
  stopResults: [], // résultats de /api/stops/search
  stopFavs: readJson('tisseo.live.stops', []), // [{ id, name, lat, lon }]
  notifyStops: new Set(readJson('tisseo.live.notify', [])), // arrêts à surveiller
  favDeps: new Map(), // stop_id -> départs (favoris)
  nearby: null, // { lat, lon, stops: [...] }
  routeDetail: new Map(), // route_id -> { variants }
  selVeh: null, // { key, routeId, variant, stops, track }
  follow: false, // la carte suit le véhicule sélectionné
  baseId: null, // fournisseur de fond de carte courant
  listView: null, // 'lignes' | 'vehicules' : panneau liste ouvert
  favs: new Set(readJson('tisseo.live.favs', [])),
  dark: true,
  countdown: REFRESH_S,
};

const $ = (id) => document.getElementById(id);
// Écrit dans le DOM seulement si le contenu a changé. Sans ça, le
// rafraîchissement toutes les 15 s détruit et recrée des dizaines de listes
// (alertes, lignes, fiche véhicule) alors que leur contenu est identique :
// le navigateur resélectionne, rescrolle et repeint tout pour rien.
function setHtml(el, html) {
  if (el.__last === html) return false;
  const keep = el.querySelector('.steps');
  const scroll = keep ? keep.scrollTop : 0;
  el.innerHTML = html;
  if (keep && scroll) { const s = el.querySelector('.steps'); if (s) s.scrollTop = scroll; }
  el.__last = html;
  return true;
}
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const modeKey = (m) => norm(m);
const vKey = (v) => `${v.route_id}|${v.id}`;
const routeById = new Map();

if (!window.L) {
  document.getElementById('liveText').textContent = 'moteur de carte introuvable';
  showFatal('Ni public/vendor/leaflet.js ni les CDN de secours n’ont répondu. '
    + 'La carte ne peut pas être affichée — les horaires temps réel restent dans /api/vehicles.');
  throw new Error('Leaflet introuvable');
}

const map = L.map('map', { zoomControl: false }).setView([43.6047, 1.4442], 12);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
map.attributionControl.setPrefix('Tisséo / Toulouse Métropole (ODbL)');

// --- fonds de carte -------------------------------------------------------
// La liste vient de /api/tiles : le serveur a réellement interrogé chaque
// fournisseur (HTTP, taille, dimensions 256×256, empreinte) et ne renvoie
// que ceux qui servent une vraie carte. Un fond « 200 OK » qui affiche un
// placeholder — ce que fait CARTO sans clé — est donc écarté d'emblée.
const TILE_FALLBACK = {
  dark: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
  light: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
};
let baseMode = 'dark', baseIdx = 0, tileErrors = 0, tileWindowStart = Date.now();
let baseLayer = null, labelLayer = null;
let tileSets = { dark: null, light: null };
// null = on essaie les tuiles, true = on renonce (mode tracés), false = choix manuel « tuiles ».
let vectorOnly = readJson('tisseo.live.vector', null);

// Chaîne de repli : d'abord le mode demandé, puis l'autre mode. Un fond
// sombre indisponible retombe donc sur une vraie carte claire plutôt que sur
// le mode tracés — c'est le fond, pas la géométrie, qui manque.
function providerList() {
  const other = baseMode === 'dark' ? 'light' : 'dark';
  const seen = new Set();
  const chain = [];
  for (const mode of [baseMode, other]) {
    for (const p of tileSets[mode] || []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      chain.push({ ...p, mode });
    }
  }
  for (const [i, url] of (TILE_FALLBACK[baseMode] || []).entries()) {
    const id = 'fallback-' + baseMode + i;
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push({ id, url, mode: baseMode });
  }
  return chain;
}

function setBaseLayer() {
  if (baseLayer && map.hasLayer(baseLayer)) map.removeLayer(baseLayer);
  if (labelLayer && map.hasLayer(labelLayer)) map.removeLayer(labelLayer);
  baseLayer = null;
  labelLayer = null;
  map.getContainer().classList.toggle('notiles', !!vectorOnly);
  if (vectorOnly) { updateMapButton(); return; }
  const list = providerList();
  if (baseIdx >= list.length) baseIdx = 0;
  const p = list[baseIdx];
  // maxNativeZoom : au-delà, Leaflet agrandit la dernière tuile native au
  // lieu d'en demander une de plus. Sans ça, le fond gris foncé d'Esri
  // servait son « map data not available » à partir du z17 — le z17 et le
  // z18 renvoyant le même fichier.
  baseLayer = L.tileLayer(p.url, {
    maxZoom: 21,
    maxNativeZoom: p.max_native_zoom ?? 19,
    attribution: p.attribution || '',
  });
  baseLayer.on('tileerror', onTileError);
  baseLayer.addTo(map);
  if (p.labels) {
    labelLayer = L.tileLayer(p.labels, { maxZoom: 21, maxNativeZoom: p.max_native_zoom ?? 19 });
    labelLayer.addTo(map);
  }
  state.dark = p.mode !== 'light';
  state.baseId = p.id;
}

// Au-delà du zoom natif du fond courant, on préfère un fournisseur qui a de
// vraies données à ce niveau — un fond clair net vaut mieux qu'un fond sombre
// agrandi jusqu'au pixel. Le choix est mémorisé pour revenir au fond
// d'origine quand on dézoome.
let deepProvider = null;
function adaptProviderToZoom() {
  if (vectorOnly || !baseLayer) return;
  const z = map.getZoom();
  const list = providerList();
  const cur = list[baseIdx];
  if (!cur || (cur.max_native_zoom ?? 19) >= z) {
    if (deepProvider) { const back = deepProvider; deepProvider = null; baseIdx = back; setBaseLayer(); }
    return;
  }
  const better = list.findIndex((p, i) => i !== baseIdx && (p.max_native_zoom ?? 19) >= z);
  if (better < 0) return;
  deepProvider = baseIdx;
  baseIdx = better;
  setBaseLayer();
  toast('Fond de carte remplacé par ' + list[baseIdx].label + ' (le précédent s\'arrête au zoom ' + (cur.max_native_zoom ?? 19) + ').');
}

// Toutes les tuiles ont échoué (adblocker, VPN, hors ligne) : on ne laisse
// pas un rectangle gris, on bascule sur le tracé vectoriel du réseau.
function onTileError() {
  const now = Date.now();
  if (now - tileWindowStart > 20000) { tileWindowStart = now; tileErrors = 0; }
  if (++tileErrors < 8) return;
  tileErrors = 0; tileWindowStart = now;
  if (baseIdx < providerList().length - 1) {
    baseIdx++;
    setBaseLayer();
    toast('Fond de carte de secours : ' + providerList()[baseIdx].label + '.');
  } else {
    setVectorOnly(true, 'Fond de carte injoignable — affichage des tracés du réseau.');
  }
}

async function loadTiles(force = false) {
  try {
    const r = await fetch('/api/tiles' + (force ? '?force=1' : ''));
    if (!r.ok) throw new Error('tiles ' + r.status);
    const j = await r.json();
    tileSets = { dark: j.dark || [], light: j.light || [] };
    if (!j.dark.length && !j.light.length) throw new Error('aucun fond servi');
    if (j.rejected?.length) console.info('Fonds de carte rejetés :', j.rejected);
    if (!vectorOnly) { baseIdx = 0; setBaseLayer(); }
    return j;
  } catch (e) {
    console.warn('Catalogue des fonds de carte indisponible, listes de secours :', e.message);
    if (!vectorOnly && !baseLayer) setBaseLayer();
    return null;
  }
}
setBaseLayer();

// Bascule tuiles ⇄ tracés. `reason` n'est affiché que lors d'un repli auto.
function setVectorOnly(on, reason) {
  vectorOnly = on;
  if (!on) { baseIdx = 0; tileErrors = 0; tileWindowStart = Date.now(); }
  try { localStorage.setItem('tisseo.live.vector', JSON.stringify(on)); } catch { /* mode privé */ }
  setBaseLayer();
  updateMapButton();
  if (on) {
    loadNetwork();
    if (reason) toast(reason + ' Réessayer : bouton 🗺.');
  } else {
    hideError();
    toast('Fond de carte réactivé.');
  }
}

// --- couches ---
const useCluster = typeof L.markerClusterGroup === 'function';
const markerLayer = useCluster
  ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 55, zoomToBoundsOnClick: true,
      iconCreateFunction: (c) => L.divIcon({ className: '', html: `<div class="cluster">${c.getChildCount()}</div>`, iconSize: [36, 36] }) })
  : L.layerGroup();
markerLayer.addTo(map);
// Tracé de TOUTES les lignes : chargé seulement en mode tracés, quand aucun
// fond de carte n'a pu être chargé. C'est le repli qui garantit qu'on voit
// quelque chose — le réseau entier, aux couleurs Tisséo — même sans tuiles.
const netLayer = L.layerGroup().addTo(map);
const netLines = [];
let netLoaded = false, netLoading = null;
const shapeLayer = L.layerGroup().addTo(map); // tracés + arrêts de la ligne sélectionnée
const vehLayer = L.layerGroup().addTo(map); // itinéraire + traînée du véhicule sélectionné
const geoLayer = L.layerGroup().addTo(map); // position utilisateur
const stopLayer = L.layerGroup().addTo(map); // arrêt sélectionné (recherche / favoris)
const markers = new Map();

// La pastille du véhicule sélectionné vit à part, hors du groupe de clusters :
// sinon un bus qui passe près d'un autre disparaît dans une bulle et on ne
// sait plus lequel on regarde. Panneau au-dessus, jamais regroupé.
const selPane = map.createPane('selPane');
selPane.style.zIndex = 650;
const selLayer = L.layerGroup().addTo(map);
let selMarker = null;

function netStyle(line, zoomBoost = 0) {
  const isSel = state.filterLine === line.route_id;
  const emphase = state.filterLine == null || isSel;
  const base = isSel ? 3.4 : 1.6;
  return {
    color: line.color,
    weight: vectorOnly ? base + zoomBoost : base,
    opacity: emphase ? (vectorOnly ? 0.92 : 0.3) : 0.12,
    lineCap: 'round',
    lineJoin: 'round',
  };
}

async function loadNetwork() {
  if (netLoaded) { paintNetwork(); return; }
  // Deux repli successifs (erreur de tuiles puis clic) ne doivent pas
  // charger le réseau deux fois.
  if (netLoading) return netLoading;
  netLoading = (async () => {
    try {
      const r = await fetch('/api/network');
      if (!r.ok) throw new Error('network ' + r.status);
      const j = await r.json();
      netLines.length = 0;
      for (const line of j.lines || []) {
        for (const shape of line.shapes) {
          const p = L.polyline(shape, netStyle(line));
          p.__line = line; // évite un search() sur 124 lignes à chaque repaint
          netLayer.addLayer(p);
        }
        netLines.push(line);
      }
      netLoaded = true;
      paintNetwork();
    } catch (e) {
      if (vectorOnly) toast('Tracés du réseau indisponibles : ' + e.message);
    } finally {
      netLoading = null;
    }
  })();
  return netLoading;
}

function paintNetwork() {
  if (!netLayer.getLayers().length) return;
  // Le trait s'épaissit avec le zoom : sans fond de carte, le réseau doit
  // rester lisible jusqu'au niveau rue.
  const boost = vectorOnly ? Math.max(0, map.getZoom() - 12) * 0.5 : 0;
  netLayer.eachLayer((l) => { if (l.__line) l.setStyle(netStyle(l.__line, boost)); });
}

function updateMapButton() {
  const b = $('btnMap');
  if (!b) return;
  b.classList.toggle('on', !!vectorOnly);
  b.title = vectorOnly ? 'Mode tracés : cliquer pour recharger le fond de carte' : 'Fond de carte : cliquer pour n’afficher que les tracés';
}

// Légende
const legend = L.control({ position: 'bottomright' });
legend.onAdd = function () {
  const d = L.DomUtil.create('div', 'legend');
  d.innerHTML = `<b>En circulation</b> <span class="pill mini" style="--c:#37c978;--tc:#fff">L1</span> ` +
    `<b>À l'arrêt</b> <span class="pill mini at_stop" style="--c:#f5a524;--tc:#fff">L1</span> ` +
    `<b>Théorique</b> <span class="pill mini theo" style="--c:#7b61ff;--tc:#fff">A</span> ` +
    `<b>Arrêt</b> <span class="stopdot"></span>`;
  return d;
};
legend.addTo(map);

// ---------- chargement ----------
async function loadAll() {
  try {
    const [vehRes, routesRes, alertsRes] = await Promise.all([
      fetch('/api/vehicles').then((r) => { if (!r.ok) throw new Error('vehicles ' + r.status); return r.json(); }),
      state.routes.length ? null : fetch('/api/routes').then((r) => { if (!r.ok) throw new Error('routes ' + r.status); return r.json(); }),
      fetch('/api/alerts').then((r) => { if (!r.ok) throw new Error('alerts ' + r.status); return r.json(); }),
    ]);
    if (routesRes) {
      state.routes = routesRes.routes;
      state.routes.forEach((r) => routeById.set(r.route_id, r));
    }
    state.vehicles = vehRes.vehicles;
    state.rtTimestamp = vehRes.rt_timestamp;
    state.alerts = alertsRes.alerts;
    hideError();
    if (state.selectedStop) await loadDepartures(state.selectedStop.id, true);
    if (state.stopFavs.length) await loadFavStops();
    if (state.nearby) await loadNearby(state.nearby.lat, state.nearby.lon, true);
    // L'itinéraire affiché suit le véhicule : il doit être redessiné avec les
    // nouvelles positions, sinon la traînée reste figée.
    renderAll(vehRes.stale);
    if (state.selectedId) await loadVehicleItinerary();
    checkNotifications();
  } catch (err) {
    showError('Données temps réel injoignables (' + err.message + '). Nouvel essai dans ' + REFRESH_S + ' s…');
  }
}

async function loadRouteDetail(routeId) {
  if (!state.routeDetail.has(routeId)) {
    const r = await fetch('/api/route-detail?route_id=' + encodeURIComponent(routeId));
    if (!r.ok) throw new Error('tracé ' + r.status);
    state.routeDetail.set(routeId, await r.json());
  }
  return state.routeDetail.get(routeId);
}

async function loadDepartures(stopId, silent) {
  try {
    const r = await fetch('/api/departures?stop_id=' + encodeURIComponent(stopId));
    if (!r.ok) throw new Error('départs ' + r.status);
    const j = await r.json();
    state.stopDeps = j.departures;
    state.rtTimestamp = j.rt_timestamp;
    if (!silent) renderDetail();
  } catch (e) { if (!silent) toast('Prochains passages indisponibles.'); }
}

async function loadNearby(lat, lon, silent) {
  try {
    const r = await fetch(`/api/nearby?lat=${lat}&lon=${lon}&n=6`);
    if (!r.ok) throw new Error('nearby ' + r.status);
    const j = await r.json();
    state.nearby = { lat, lon, stops: j.stops };
    if (!silent) renderDetail();
  } catch (e) { if (!silent) toast('Arrêts alentour indisponibles.'); }
}

// ---------- recherche / favoris d'arrêts ----------
function depHtml(d) {
  const theo = d.source === 'gtfs'
    ? '<span class="theo" title="Horaire théorique (GTFS) — pas de temps réel sur cette ligne">théo</span>' : '';
  return `<div class="dep"><span class="dline" style="background:#${d.color};color:#${d.text_color}">${escapeHtml(d.line)}</span>` +
    `<span class="ddest">→ ${escapeHtml(d.destination)}</span>` +
    `<span class="dtime">${relTime(d.time)}</span>${theo}</div>`;
}

async function searchStopsApi(q) {
  const query = (q || '').trim();
  const token = ++searchStopsApi._t;
  if (query.length < 2) { state.stopResults = []; renderStopResults(); return; }
  try {
    const r = await fetch('/api/stops/search?q=' + encodeURIComponent(query) + '&n=6');
    if (!r.ok) throw new Error('search ' + r.status);
    const j = await r.json();
    if (token !== searchStopsApi._t) return; // réponse périmée
    state.stopResults = j.stops || [];
  } catch (e) {
    if (token !== searchStopsApi._t) return;
    state.stopResults = [];
  }
  renderStopResults();
}
searchStopsApi._t = 0;

function renderStopResults() {
  const ul = $('stopResults');
  if (!state.stopResults.length) { setHtml(ul, ''); ul.classList.add('hidden'); return; }
  let html = '';
  for (const s of state.stopResults) {
    const fav = isStopFav(s.id);
    html += `<li class="line-item${state.selectedStop?.id === s.id ? ' sel' : ''}" data-stop="${escapeHtml(s.id)}">` +
      `<span class="stopdot"></span><span class="stopname">${escapeHtml(s.name)}</span>` +
      `<button class="fav ${fav ? 'on' : ''}" data-fav title="Arrêt favori">${fav ? '★' : '☆'}</button></li>`;
  }
  setHtml(ul, html);
  ul.classList.remove('hidden');
}

$('stopResults').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-stop]');
  if (!li) return;
  const s = state.stopResults.find((x) => x.id === li.dataset.stop);
  if (!s) return;
  if (e.target.closest('[data-fav]')) { e.stopPropagation(); toggleStopFav(s); }
  else focusStop(s);
});

// Ouvre un arrêt : repère sur la carte + prochains passages.
function focusStop(s) {
  state.selectedStop = { id: s.id, name: s.name, lat: s.lat, lon: s.lon };
  state.selectedId = null;
  state.nearby = null;
  stopLayer.clearLayers();
  L.circleMarker([s.lat, s.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#dc006b', fillOpacity: 1 })
    .bindTooltip(escapeHtml(s.name), { direction: 'top', className: 'bus-tip' })
    .addTo(stopLayer);
  map.flyTo([s.lat, s.lon], Math.max(map.getZoom(), 15), { duration: 0.7 });
  loadDepartures(s.id);
  renderStopResults();
  renderDetail();
}

const isStopFav = (id) => state.stopFavs.some((s) => s.id === id);

function toggleStopFav(s) {
  const i = state.stopFavs.findIndex((x) => x.id === s.id);
  if (i >= 0) state.stopFavs.splice(i, 1);
  else state.stopFavs.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon });
  localStorage.setItem('tisseo.live.stops', JSON.stringify(state.stopFavs));
  if (!state.stopFavs.length) state.favDeps.clear();
  renderStopResults();
  renderFavStops();
  renderDetail();
  if (i < 0) loadFavStops();
}

// Tous les favoris en une seule requête batch (/api/departures?stop_id=a,b).
async function loadFavStops() {
  if (!state.stopFavs.length) return;
  try {
    const ids = state.stopFavs.slice(0, 20).map((s) => encodeURIComponent(s.id)).join(',');
    const r = await fetch('/api/departures?stop_id=' + ids);
    if (!r.ok) throw new Error('départs ' + r.status);
    const j = await r.json();
    state.favDeps = new Map((j.stops || []).map((x) => [x.stop.id, x.departures]));
    renderFavStops();
  } catch (e) { /* on garde l'affichage précédent */ }
}

function renderFavStops() {
  $('favStopsCount').textContent = `(${state.stopFavs.length})`;
  $('favStopList').style.display = state.stopFavs.length ? '' : 'none';
  let html = '';
  for (const s of state.stopFavs) {
    const deps = state.favDeps.get(s.id) || [];
    html += `<li class="favstop${state.selectedStop?.id === s.id ? ' sel' : ''}" data-stop="${escapeHtml(s.id)}">` +
      `<div class="stopbody"><b>${escapeHtml(s.name)}</b>` +
      (deps.length ? deps.slice(0, 3).map(depHtml).join('') : '<div class="nodep">chargement…</div>') + '</div>' +
      `<button class="bell" data-notify="${escapeHtml(s.id)}" title="Être prévenu avant chaque passage">🔕</button>` +
      `<button class="fav on" data-unfav title="Retirer des favoris">★</button></li>`;
  }
  setHtml($('favStopList'), html);
}

// Délégation sur la liste des arrêts favoris (les horaires changent souvent :
// c'est le rendu le plus fréquent de la page).
$('favStopList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-stop]');
  if (!li) return;
  const s = state.stopFavs.find((x) => x.id === li.dataset.stop);
  if (!s) return;
  const bell = e.target.closest('[data-notify]');
  if (bell) {
    e.stopPropagation();
    if (state.notifyStops.has(s.id)) toggleNotify(false);
    else askNotify();
    return;
  }
  if (e.target.closest('[data-unfav]')) { e.stopPropagation(); toggleStopFav(s); }
  else focusStop(s);
});

function showError(msg, withBadge = true) {
  const el = $('error');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (withBadge) {
    $('liveText').textContent = 'hors ligne';
    $('liveBadge').className = 'live down';
  }
}
function hideError() { $('error').classList.add('hidden'); }
// Erreur bloquante (moteur de carte absent) : le bandeau reste affiché.
function showFatal(msg) {
  const el = $('error');
  el.textContent = msg;
  el.classList.remove('hidden');
  $('liveText').textContent = 'carte impossible';
  $('liveBadge').className = 'live down';
}
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

// ---------- filtres ----------
function visibleVehicles() {
  return state.vehicles.filter((v) => {
    if (state.filterLine && v.route_id !== state.filterLine) return false;
    if (state.mode !== 'all' && modeKey(v.mode) !== state.mode) return false;
    return true;
  });
}

// ---------- rendu ----------
// ---------- inventaire : toutes les lignes / tous les véhicules ----------
// Deux vues câblées sur les compteurs de l'en-tête et sur le bouton
// « Toutes les lignes » du panneau. Elles listent ce qui roule MAINTENANT,
// avec la position de chaque véhicule : c'est l'inverse de la carte, qui
// montre où mais cache combien.
const INVENTORY_PAGE = 80;

function openInventory(kind, routeId) {
  state.listView = { kind, routeId: routeId ?? null };
  $('statVehiclesBtn').classList.toggle('on', kind === 'vehicules');
  $('statLinesBtn').classList.toggle('on', kind === 'lignes');
  renderInventory();
}

function closeInventory() {
  state.listView = null;
  $('inventory').classList.add('hidden');
  $('statVehiclesBtn').classList.remove('on');
  $('statLinesBtn').classList.remove('on');
}

function vehicleRowHtml(v) {
  const speed = v.speed_kmh != null ? Math.round(v.speed_kmh) + ' km/h' : '';
  return `<li class="inv" data-veh="${escapeHtml(vKey(v))}">` +
    `<span class="past" style="background:#${v.color}"></span>` +
    `<b>${escapeHtml(v.line)}</b>` +
    `<span class="dest">→ ${escapeHtml(v.destination || '')}</span>` +
    `<small>${v.theoretical ? 'théorique · ' : ''}${escapeHtml(v.next_stop || v.at_stop || '')}</small>` +
    `<span class="pos" title="Position estimée">${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}</span>` +
    `<span class="spd">${speed}</span></li>`;
}

function renderInventory() {
  const box = $('inventory');
  const view = state.listView;
  if (!view) { box.classList.add('hidden'); return; }
  const vis = visibleVehicles();
  let items = vis;
  let title = '';
  if (view.kind === 'lignes') {
    if (view.routeId) {
      items = vis.filter((v) => v.route_id === view.routeId);
      const r = routeById.get(view.routeId);
      title = `Ligne ${r?.short_name ?? view.routeId} — ${items.length} véhicule${items.length > 1 ? 's' : ''}`;
    } else {
      // Toutes les lignes confondues, triées par ligne puis par destination.
      items = [...vis].sort((a, b) => a.line.localeCompare(b.line, 'fr') || a.destination.localeCompare(b.destination, 'fr'));
      const lines = new Set(vis.map((v) => v.route_id));
      title = `Toutes les lignes — ${lines.size} ligne${lines.size > 1 ? 's' : ''}, ${vis.length} véhicules`;
    }
  } else {
    items = [...vis].sort((a, b) => a.route_id.localeCompare(b.route_id) || a.line.localeCompare(b.line, 'fr'));
    title = `${vis.length} véhicule${vis.length > 1 ? 's' : ''} en service`;
  }
  const shown = items.slice(0, INVENTORY_PAGE);
  const byMode = {};
  for (const v of vis) byMode[v.mode] = (byMode[v.mode] || 0) + 1;
  const resume = Object.entries(byMode).map(([m, n]) => `<span class="tagline">${escapeHtml(m)} <b>${n}</b></span>`).join('');

  setHtml(box, `<button class="close" id="invClose" title="Fermer">✕</button>` +
    `<h3>${escapeHtml(title)}</h3><div class="invtags">${resume}</div>` +
    `<ul class="invlist">${shown.map(vehicleRowHtml).join('')}</ul>` +
    (items.length > shown.length
      ? `<div class="invmore">… et ${items.length - shown.length} autres (affinez avec les filtres à gauche).</div>`
      : ''));
  box.classList.remove('hidden');
  $('invClose').onclick = () => closeInventory();
  $('inventory').scrollTop = 0;
}

// Délégation : cliquer une ligne de l'inventaire sélectionne le véhicule,
// avec son itinéraire. C'est le même chemin qu'un clic sur la pastille.
$('inventory').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-veh]');
  if (!li) return;
  selectVehicle(li.dataset.veh);
  const m = markers.get(li.dataset.veh);
  if (m) map.panTo(m.getLatLng(), { animate: true, duration: 0.5 });
});

$('statVehiclesBtn').onclick = () => {
  if (state.listView?.kind === 'vehicules') closeInventory();
  else openInventory('vehicules');
};
$('statLinesBtn').onclick = () => {
  if (state.listView?.kind === 'lignes' && !state.listView.routeId) closeInventory();
  else openInventory('lignes');
};
$('btnAllLines').onclick = () => openInventory('lignes');

function renderAll(stale) {
  renderHeader(stale);
  renderMarkers();
  renderStopResults();
  renderFavStops();
  renderLineList();
  renderAlerts();
  renderDetail();
  renderInventory();
  $('btnCopyLink').classList.toggle('hidden', !state.filterLine);
}

function renderHeader(stale) {
  const age = Math.max(0, Math.floor(Date.now() / 1000) - state.rtTimestamp);
  const badge = $('liveBadge');
  $('liveText').textContent = stale ? `données dégradées (il y a ${age}s)` : age <= 60 ? `en direct (il y a ${age}s)` : `il y a ${age}s`;
  badge.className = 'live ' + (stale ? 'stale' : age <= 90 ? 'ok' : 'stale');
  $('statVehicles').textContent = visibleVehicles().length;
  $('statLines').textContent = new Set(state.vehicles.map((v) => v.route_id)).size;
  $('statAlerts').textContent = state.alerts.length;
}

// L'icône n'est JAMAIS regénérée une fois créée : la pastille se met à jour
// en CSS (variables --c/--tc/--rot). Un setIcon() recrée le nœud DOM, ce qui
// casse la transition, l'animation du halo et coûte cher avec 300 véhicules.
// PILL_HTML n'est donc qu'au tout premier affichage, et chaque nouvelle
// icône se peint dans createIcon() — le groupe de clusters en fabrique et en
// jette en permanence, notamment pendant l'animation.
const PILL_HTML = '<div class="pill"><span class="caret"></span><span class="lb"></span></div>';

class PillIcon extends L.DivIcon {
  createIcon() {
    // Leaflet positionne l'élément renvoyé : c'est le DIV enveloppant qu'il
    // faut lui rendre. La pastille, elle, est son premier enfant — la
    // la peindre y mettrait les classes et écraserait son contenu
    // (le caret disparaissait, le texte prenait toute la place).
    const wrap = L.DivIcon.prototype.createIcon.call(this);
    const p = this.options.marker?.__paint;
    if (p) paintPillEl(wrap.firstElementChild, ...p);
    return wrap;
  }
}

function paintPillEl(el, v, dimmed, selected, alertOn) {
  if (!el) return;
  el.classList.toggle('at_stop', v.status === 'at_stop');
  el.classList.toggle('dimmed', !!dimmed);
  el.classList.toggle('sel', !!selected);
  el.classList.toggle('moving', v.status === 'en_route' && v.bearing != null);
  // Véhicule théorique : on ne le présente jamais comme du temps réel.
  el.classList.toggle('theo', !!v.theoretical);
  // Ligne perturbée : contour d'alerte, pour voir d'un coup d'œil ce que
  // traversent les véhicules affectés par une info trafic.
  el.classList.toggle('alert', !!alertOn);
  el.style.setProperty('--c', '#' + v.color);
  el.style.setProperty('--tc', '#' + v.text_color);
  el.style.setProperty('--rot', (v.bearing ?? 0) + 'deg');
  const lb = el.lastElementChild;
  if (lb && lb.textContent !== v.line) lb.textContent = v.line;
}

function paintPill(m, v, dimmed, selected, alertOn) {
  m.__paint = [v, dimmed, selected, !!alertOn];
  const el = m._icon?.firstElementChild;
  if (el) paintPillEl(el, v, dimmed, selected, alertOn);
}

// --- mouvement continu, piloté par la vitesse mesurée -------------------
// Le flux amont arrive toutes les ~10 s. Interpoler entre deux points avec
// une durée fixe donnait un mouvement correct mais saccadé : à chaque
// nouvelle donnée, l'animation repartait de la position affichée, ce qui se
// voyait surtout quand deux actualisations se suivaient de près.
//
// On fait du routage à l'estime (dead reckoning) : à chaque point observé on
// mesure la vitesse réelle (distance / temps), on la lisse, et la pastille
// avance en continu à cette vitesse entre deux points. Une nouvelle mesure
// ne fait que corriger la trajectoire — plus de redémarrage visible.
const M_PER_DEG_LAT = 110540;
const FOLLOW_MS = 200; // rythme du recentrage en mode « suivre »
const SPEED_ALPHA = 0.35; // lissage exponentiel de la vitesse
const MIN_MOVE_MS = 1500; // en dessous, le saut est du bruit : on ignore
let motionFrame = null, lastFollow = 0, selfPan = false;
const moving = new Set();

function metresBetween(a, b) {
  const kx = M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * kx;
  return Math.hypot(dx, dy);
}

function setMarkerFix(m, lat, lon) {
  const now = performance.now();
  const fix = L.latLng(lat, lon);
  const prevFix = m.__fix;
  const prevAt = m.__fixAt;
  if (prevFix && prevAt != null) {
    const dt = now - prevAt;
    const d = metresBetween(prevFix, fix);
    if (dt >= MIN_MOVE_MS) {
      const inst = d / (dt / 1000);
      // Vitesse lissée : une valeur isolée aberrante ne doit pas faire
      // bondir la pastille, et un arrêt franc doit la ramener à zéro.
      m.__speed = m.__speed == null ? inst : m.__speed + (inst - m.__speed) * SPEED_ALPHA;
    }
    if (d > 5) m.__bearing = bearingDeg(prevFix, fix);
  }
  m.__fix = fix;
  m.__fixAt = now;
  // Point de départ de l'animation : la position PRÉDITE à l'instant présent,
  // pas celle affichée. C'est ce qui supprime le redémarrage visible : la
  // pastille est déjà là où la vitesse dit qu'elle doit être.
  m.__from = predict(m, now);
  m.__target = fix;
  m.__t0 = now;
  moving.add(m);
  kickMotion();
}

// Extrapolation à l'instant `now` : position observée + vitesse × temps.
function predict(m, now) {
  const fix = m.__fix;
  if (!fix || m.__fixAt == null) return m.__target || m.getLatLng();
  const v = m.__speed || 0;
  if (v <= 0.05) return fix;
  const dt = Math.min(Math.max((now - m.__fixAt) / 1000, 0), 8); // au-delà, on ne devine plus
  const d = v * dt;
  if (d < 1) return fix;
  const bearing = m.__paint?.[0]?.bearing ?? m.__bearing ?? 0;
  const rad = (bearing * Math.PI) / 180;
  const kx = M_PER_DEG_LAT * Math.cos((fix.lat * Math.PI) / 180);
  return L.latLng(fix.lat + (Math.cos(rad) * d) / M_PER_DEG_LAT, fix.lng + (Math.sin(rad) * d) / kx);
}

function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
    - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function kickMotion() {
  if (motionFrame) return;
  motionFrame = requestAnimationFrame(stepMotion);
}

function stepMotion(now) {
  motionFrame = null;
  const t = now ?? performance.now();
  for (const m of moving) {
    const from = m.__from, to = m.__target;
    if (!from || !to) continue;
    // Durée = distance / vitesse mesurée. Un bus rapide arrive au bout
    // vite, un bus à l'arrêt ne bouge pas : plus de durée constante
    // arbitraire qui ne colle à rien.
    const d = metresBetween(from, to);
    const v = m.__speed || 0;
    const dur = v > 0.3 ? Math.min(Math.max((d / v) * 1000, 2500), 12000) : 9000;
    const p = Math.min(1, (t - m.__t0) / dur);
    // Un marqueur caché dans un cluster n'a pas d'icône à déplacer : on le
    // téléporte au but. Interpoler 300 pastilles hors écran coûtait 18 000
    // setLatLng par seconde pour rien.
    if (p >= 1 || !m._icon) { m.setLatLng(to); moving.delete(m); continue; }
    // ease-in-out : départ et arrivée doux, vitesse constante au milieu
    const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
    // Attention : un LatLng de Leaflet expose .lng, PAS .lon. Se tromper
    // produisait un NaN qui tuait la boucle d'animation.
    const ll = L.latLng(from.lat + (to.lat - from.lat) * e, from.lng + (to.lng - from.lng) * e);
    m.setLatLng(ll);
    // Mode « suivre » : on recentre la carte sur le véhicule choisi, à
    // 5 images/s — assez pour que ça semble continu, pas assez pour
    // siphonner le GPU.
    if (state.follow && state.selectedId && m.__key === state.selectedId && t - lastFollow > FOLLOW_MS) {
      lastFollow = t;
      selfPan = true;
      map.panTo(ll, { animate: false });
      setTimeout(() => { selfPan = false; }, 0);
    }
  }
  if (moving.size) motionFrame = requestAnimationFrame(stepMotion);
  else motionFrame = null;
}

function stopMotion() {
  for (const m of moving) if (m.__target) m.setLatLng(m.__target);
  moving.clear();
  if (motionFrame) { cancelAnimationFrame(motionFrame); motionFrame = null; }
}

function renderMarkers() {
  const vis = visibleVehicles();
  const visKeys = new Set(vis.map(vKey));
  for (const [k, m] of markers) {
    if (visKeys.has(k)) continue;
    markerLayer.removeLayer(m);
    markers.delete(k);
    moving.delete(m);
  }
  for (const v of vis) {
    const k = vKey(v);
    const selected = state.selectedId === k;
    const alertOn = !v.theoretical && (state.alertRoutes.has(v.route_id)
      || (state.alertHover && state.alertHover.has(v.route_id)));
    // Un véhicule sélectionné reste mis en évidence même si le filtre l'a
    // écarté de la vue : sinon il disparaît et on ne sait plus où on l'a
    // cliqué. Le reste, en revanche, s'assombrit.
    let dimmed = (state.filterLine != null && v.route_id !== state.filterLine) || (state.selectedId != null && !selected);
    if (state.alertHover) dimmed = dimmed || !alertOn;
    let m = markers.get(k);
    if (!m) {
      const icon = new PillIcon({ iconSize: [46, 24], iconAnchor: [23, 12], html: PILL_HTML });
      m = L.marker([v.lat, v.lon], {
        icon,
        keyboard: false, // 300 pastilles au clavier : inutile, et ça bloque Tab
      });
      icon.options.marker = m; // createIcon() s'appuie dessus pour se peindre
      m.__key = k;
      m.__target = L.latLng(v.lat, v.lon);
      m.bindTooltip(`${escapeHtml(v.line)} → ${escapeHtml(v.destination)}`, { direction: 'top', className: 'bus-tip' });
      m.on('click', () => selectVehicle(k));
      markers.set(k, m);
      markerLayer.addLayer(m);
    } else {
      setMarkerFix(m, v.lat, v.lon);
    }
    paintPill(m, v, dimmed, selected, alertOn);
    const tip = v.theoretical
      ? `${escapeHtml(v.line)} → ${escapeHtml(v.destination)} <em>(théorique)</em>`
      : `${escapeHtml(v.line)} → ${escapeHtml(v.destination)}`;
    if (m.__tip !== tip) { m.setTooltipContent(tip); m.__tip = tip; }
  }
  syncSelectedMarker();
}

// Pastille de mise en évidence, toujours au-dessus des clusters.
function syncSelectedMarker() {
  const v = currentVehicle();
  if (!v) {
    if (selMarker) { selLayer.removeLayer(selMarker); moving.delete(selMarker); selMarker = null; }
    return;
  }
  if (!selMarker) {
    const icon = new PillIcon({ iconSize: [46, 24], iconAnchor: [23, 12], html: PILL_HTML, pane: 'selPane' });
    selMarker = L.marker([v.lat, v.lon], { icon, keyboard: false, interactive: false, riseOnHover: false });
    icon.options.marker = selMarker;
    selMarker.__key = state.selectedId;
    selLayer.addLayer(selMarker);
  } else {
    selMarker.__key = state.selectedId;
    setMarkerFix(selMarker, v.lat, v.lon);
  }
  paintPill(selMarker, v, false, true);
}

async function renderRouteShape() {
  shapeLayer.clearLayers();
  if (!state.filterLine) return;
  try {
    const detail = await loadRouteDetail(state.filterLine);
    const route = routeById.get(state.filterLine);
    const color = '#' + (route?.color || 'dc006b');
    const bounds = [];
    for (const v of detail.variants) {
      const latlngs = v.shape.map(([la, lo]) => [la, lo]);
      bounds.push(...latlngs);
      L.polyline(latlngs, { color: '#ffffff', weight: 7, opacity: 0.35 }).addTo(shapeLayer);
      L.polyline(latlngs, { color, weight: 4, opacity: 0.9 }).addTo(shapeLayer);
      for (const s of v.stops) {
        const c = L.circleMarker([s.lat, s.lon], { radius: 5, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 });
        c.bindTooltip(escapeHtml(s.name), { direction: 'top', className: 'bus-tip' });
        c.on('click', () => { state.selectedStop = s; clearVehicle(); state.nearby = null; loadDepartures(s.id); });
        c.addTo(shapeLayer);
      }
    }
    if (bounds.length) map.flyToBounds(L.latLngBounds(bounds).pad(0.12), { duration: 0.8 });
  } catch (e) { toast('Tracé de la ligne indisponible.'); }
}

function lineItemHtml(r, count) {
  const fav = state.favs.has(r.route_id) ? '★' : '☆';
  return `<button class="fav ${state.favs.has(r.route_id) ? 'on' : ''}" data-fav="${r.route_id}" title="Ajouter aux favoris">${fav}</button>` +
    `<span class="past" style="background:#${r.color};color:#${r.text_color}"></span><b>${escapeHtml(r.short_name)}</b>` +
    `<small>${escapeHtml(r.long_name)}</small><span class="n">${count}</span>`;
}

function renderLineList() {
  const counts = {};
  for (const v of state.vehicles) {
    if (state.mode !== 'all' && modeKey(v.mode) !== state.mode) continue;
    counts[v.route_id] = (counts[v.route_id] || 0) + 1;
  }
  const q = norm(state.query);
  const matchQ = (r) => !q || norm(r.short_name).includes(q) || norm(r.long_name).includes(q);
  const active = state.routes
    .filter((r) => (counts[r.route_id] || 0) > 0 && matchQ(r))
    .sort((a, b) => (counts[b.route_id] - counts[a.route_id]) || a.short_name.localeCompare(b.short_name));

  // La liste est reconstruite d'un seul tenant puis injectée d'un coup :
  // 200 <li> recréés toutes les 15 s étaient le principal gaspillage.
  const favUl = $('favList');
  const favItems = state.routes.filter((r) => state.favs.has(r.route_id) && matchQ(r));
  let html = '';
  for (const r of favItems) {
    const cls = 'line-item favline' + (state.filterLine === r.route_id ? ' sel' : '') + ((counts[r.route_id] || 0) === 0 ? ' dim' : '');
    html += `<li class="${cls}" data-route="${escapeHtml(r.route_id)}">${lineItemHtml(r, counts[r.route_id] || 0)}</li>`;
  }
  setHtml(favUl, html);
  favUl.style.display = favItems.length ? '' : 'none';

  $('linesCount').textContent = `(${active.length})`;
  if (!active.length) { setHtml($('lineList'), '<li class="line-item dim">Aucune ligne — essayez une autre recherche.</li>'); return; }
  let list = '';
  for (const r of active.slice(0, 200)) {
    if (state.favs.has(r.route_id)) continue; // déjà épinglée
    list += `<li class="line-item${state.filterLine === r.route_id ? ' sel' : ''}" data-route="${escapeHtml(r.route_id)}">${lineItemHtml(r, counts[r.route_id])}</li>`;
  }
  setHtml($('lineList'), list);
}

// Délégation : un seul écouteur pour les deux listes de lignes, au lieu de
// N écouteurs reconstruits à chaque rafraîchissement.
function onLineListClick(e) {
  const li = e.target.closest('li[data-route]');
  if (!li) return;
  const r = routeById.get(li.dataset.route);
  if (!r) return;
  if (e.target.closest('[data-fav]')) {
    e.stopPropagation();
    if (state.favs.has(r.route_id)) state.favs.delete(r.route_id);
    else state.favs.add(r.route_id);
    localStorage.setItem('tisseo.live.favs', JSON.stringify([...state.favs]));
    renderLineList();
  } else {
    // Un clic sur une ligne : on la filtre, on la trace en surbrillance, et
    // on ouvre la liste de ses véhicules avec leurs positions.
    const on = state.filterLine === r.route_id;
    selectLine(on ? null : r.route_id);
    openInventory('lignes', on ? null : r.route_id);
  }
}
$('favList').addEventListener('click', onLineListClick);
$('lineList').addEventListener('click', onLineListClick);

// ---------- itinéraire A → B ----------------------------------------------
// Le calcul est fait côté serveur (Dijkstra sur ~20 k états, marche,
// correspondances, horaires temps réels appliqués segment par segment).
// L'interface se contente de le formater et de le dessiner.
const journeyLayer = L.layerGroup().addTo(map);
let journey = null;

function journeyLegHtml(leg) {
  if (leg.type === 'walk') {
    return `<li class="jleg walk"><b>🚶 ${Math.round(leg.seconds / 60)} min</b>` +
      `<span>${escapeHtml(leg.from)} → ${escapeHtml(leg.to)}</span></li>`;
  }
  const dep = leg.depart ? fmtTime(leg.depart) : '';
  const arr = leg.arrive ? fmtTime(leg.arrive) : '';
  return `<li class="jleg" data-leg="${escapeHtml(leg.route_id)}" data-from="${escapeHtml(leg.from_id)}" data-to="${escapeHtml(leg.to_id)}">` +
    `<b><span class="dline" style="background:#${leg.color};color:#${leg.text_color}">${escapeHtml(leg.line)}</span> ${escapeHtml(leg.from)} → ${escapeHtml(leg.to)}</b>` +
    `<span class="jtime">${dep} – ${arr}` +
    `${leg.transfer_s ? ` <em>+${Math.round(leg.transfer_s / 60)} min de correspondance</em>` : ''}` +
    `${leg.real ? '' : ' <em>estimé</em>'}</span></li>`;
}

function renderJourney() {
  const box = $('jResults');
  if (!journey) { box.innerHTML = ''; return; }
  if (journey.error) {
    setHtml(box, `<div class="jerr">${escapeHtml(journey.error)}${journey.hint ? '<br><small>' + escapeHtml(journey.hint) + '</small>' : ''}</div>`);
    return;
  }
  const legs = journey.legs || [];
  const warnings = [];
  if (journey.estimates) warnings.push('horaires estimés : le temps réel ne couvre pas toutes les lignes');
  if (journey.out_of_service?.length) {
    warnings.push('hors service maintenant : ' + journey.out_of_service.map((r) => r.line).join(', '));
  }
  setHtml(box,
    `<div class="jhead"><b>${Math.round((journey.duration_s || 0) / 60)} min</b>` +
    `<span>départ ${fmtTime(journey.depart_at)} · arrivée ${fmtTime(journey.arrive_at)}` +
    `${journey.transfers ? ` · ${journey.transfers} correspondance${journey.transfers > 1 ? 's' : ''}` : ' · direct'}</span></div>` +
    (warnings.length ? `<div class="jwarn">⚠ ${warnings.map(escapeHtml).join('<br>⚠ ')}</div>` : '') +
    `<ol class="jlegs">${legs.map(journeyLegHtml).join('')}</ol>`);
  box.querySelectorAll('li.jleg[data-leg]').forEach((li) => {
    li.onclick = () => focusJourneyLeg(li.dataset.leg, li.dataset.from, li.dataset.to);
  });
}

// Dessine un trajet : on va chercher le vrai tracé de la ligne dans le sens
// emprunté (from_id → to_id), pas une corde entre les deux arrêts.
async function focusJourneyLeg(routeId, fromId, toId) {
  journeyLayer.clearLayers();
  if (!routeId || routeId === 'walk') return;
  try {
    const detail = await loadRouteDetail(routeId);
    const variant = (detail.variants || []).find((v) => {
      const ids = v.stops.map((s) => s.id);
      return ids.includes(fromId) && ids.includes(toId) && ids.indexOf(fromId) < ids.indexOf(toId);
    }) || (detail.variants || [])[0];
    if (!variant) return;
    const color = '#' + (routeById.get(routeId)?.color || 'dc006b');
    const latlngs = variant.shape.map(([la, lo]) => [la, lo]);
    L.polyline(latlngs, { color: '#000', weight: 11, opacity: .35, lineCap: 'round' }).addTo(journeyLayer);
    L.polyline(latlngs, { color: '#fff', weight: 8, opacity: .8, lineCap: 'round' }).addTo(journeyLayer);
    L.polyline(latlngs, { color, weight: 5, opacity: 1, lineCap: 'round' }).addTo(journeyLayer);
    for (const s of variant.stops) {
      if (s.lat == null) continue;
      const isEnd = s.id === fromId || s.id === toId;
      L.circleMarker([s.lat, s.lon], isEnd
        ? { radius: 7, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 }
        : { radius: 3.5, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: .9 })
        .bindTooltip(escapeHtml(s.name), { direction: 'top', className: 'bus-tip' })
        .addTo(journeyLayer);
    }
    map.flyToBounds(L.latLngBounds(latlngs).pad(0.08), { duration: 0.7 });
  } catch (e) { toast('Tracé de la ligne indisponible.'); }
}

async function askJourney() {
  const from = $('jFrom').value.trim();
  const to = $('jTo').value.trim();
  if (!from || !to) { toast('Indiquez un départ et une arrivée.'); return; }
  setHtml($('jResults'), '<div class="jerr">Calcul en cours…</div>');
  $('planner').open = true;
  try {
    const r = await fetch(`/api/journey?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const j = await r.json();
    journey = j.error ? { error: j.error, hint: j.hint } : j;
    renderJourney();
    journeyLayer.clearLayers();
    if (!j.error) {
      // On dessine d'emblée le premier trajet emprunté : l'utilisateur voit
      // où on l'emmène avant même de cliquer une étape.
      const ride = (j.legs || []).find((l) => l.type === 'ride');
      if (ride) focusJourneyLeg(ride.route_id, ride.from_id, ride.to_id);
    }
  } catch (e) {
    journey = { error: 'Calcul indisponible (' + e.message + ')' };
    renderJourney();
  }
}

$('jGo').onclick = askJourney;
$('jSwap').onclick = () => {
  const a = $('jFrom').value, b = $('jTo').value;
  $('jFrom').value = b; $('jTo').value = a;
  if (journey && !journey.error) askJourney();
};
$('jClose').onclick = () => { journey = null; journeyLayer.clearLayers(); renderJourney(); };
$('planner').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); askJourney(); }
  if (e.key === 'Escape') { journey = null; journeyLayer.clearLayers(); renderJourney(); }
});

function selectLine(routeId) {
  state.filterLine = routeId;
  state.selectedId = null;
  state.selVeh = null;
  state.follow = false;
  state.selectedStop = null;
  state.nearby = null;
  geoLayer.clearLayers();
  stopLayer.clearLayers();
  vehLayer.clearLayers();
  // deep link
  const url = new URL(location.href);
  if (routeId) {
    const r = routeById.get(routeId);
    url.searchParams.set('ligne', r?.short_name || routeId);
  } else url.searchParams.delete('ligne');
  history.replaceState(null, '', url);
  renderAll();
  renderRouteShape();
  paintNetwork();
}

// ---------- itinéraire d'un véhicule ---------------------------------------
// Le flux RT ne dit pas « où va ce bus », seulement « il est entre tel et tel
// arrêt ». Pour reconstituer son itinéraire on recolle trois morceaux :
//   - le sens de la variante (le headsign du GTFS == la destination du RT)
//   - les arrêts à venir, que le serveur donne déjà classés et horodatés
//   - la traînée réellement parcourue (/api/track, ~45 min d'historique)
function pickVariant(variants, v) {
  const dest = norm(v.destination), to = norm(v.to), from = norm(v.from);
  let best = null, bestScore = -1;
  for (const variant of variants) {
    const stops = variant.stops || [];
    let score = 0;
    if (variant.headsign && norm(variant.headsign) === dest) score += 4;
    if (stops.length && norm(stops[stops.length - 1].name) === (to || dest)) score += 3;
    if (stops.length && norm(stops[0].name) === from) score += 2;
    if (v.next_stop_id && stops.some((s) => s.id === v.next_stop_id)) score += 1;
    if (score > bestScore) { bestScore = score; best = variant; }
  }
  return best;
}

// ---------- notification de prochain passage ------------------------------
// Le serveur calcule déjà les départs d'un arrêt ; il ne manquait que le
// « réveille-moi quand ça arrive ». On garde en mémoire les départs déjà
// signalés pour ne pas notifier deux fois le même bus.
const notified = new Set();

async function askNotify() {
  if (!('Notification' in window)) { toast('Notifications non supportées par ce navigateur.'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications refusées.'); renderDetail(); return; }
  toggleNotify(true);
  toast('Vous serez prévenu 2 minutes avant chaque passage.');
}

function toggleNotify(on) {
  if (on) state.stopFavs.forEach((s) => state.notifyStops.add(s.id));
  else state.notifyStops.clear();
  try { localStorage.setItem('tisseo.live.notify', JSON.stringify([...state.notifyStops])); } catch { /* privé */ }
  updateNotifyButtons();
  checkNotifications(true);
}

function updateNotifyButtons() {
  document.querySelectorAll('[data-notify]').forEach((b) => {
    const on = state.notifyStops.has(b.dataset.notify);
    b.classList.toggle('on', on);
    b.textContent = on ? '🔔' : '🔕';
    b.title = on ? 'Couper les alertes de cet arrêt' : 'être prévenu avant chaque passage';
  });
}

function checkNotifications(force) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.hidden) return;
  const now = Math.floor(Date.now() / 1000);
  for (const [stopId, deps] of state.favDeps) {
    if (!state.notifyStops.has(stopId)) continue;
    for (const d of deps || []) {
      const key = `${stopId}|${d.route_id}|${d.dir ?? ''}|${d.time}`;
      if (notified.has(key)) continue;
      // 2 minutes de marge : assez pour partir, pas trop tôt pour rien rater.
      if (d.time > now && d.time - now <= 120) {
        notified.add(key);
        const nom = state.stopFavs.find((s) => s.id === stopId)?.name || 'votre arrêt';
        try {
          new Notification(`${d.line} dans ${Math.max(1, Math.round((d.time - now) / 60))} min`, {
            body: `${nom} → ${d.destination || ''}`.trim(),
            tag: key,
            icon: 'icon.svg',
          });
        } catch { /* certains navigateurs exigent un service worker */ }
      }
    }
  }
}

async function selectVehicle(key) {
  state.selectedId = key;
  state.selectedStop = null;
  state.nearby = null;
  stopLayer.clearLayers();
  // La pastille doit s'allumer tout de suite : renderMarkers() ne recrée
  // aucune icône, il ne met que des classes et des variables CSS à jour.
  renderMarkers();
  renderDetail();
  await loadVehicleItinerary();
}

function currentVehicle() {
  return state.vehicles.find((v) => vKey(v) === state.selectedId) || null;
}

// Désélection : on coupe aussi le suivi et l'itinéraire affiché.
function clearVehicle() {
  state.selectedId = null;
  state.selVeh = null;
  state.follow = false;
  vehLayer.clearLayers();
  renderMarkers();
}

async function loadVehicleItinerary() {
  const v = currentVehicle();
  vehLayer.clearLayers();
  if (!v) { state.selVeh = null; return; }
  const key = vKey(v);
  let variant = state.selVeh?.key === key ? state.selVeh.variant : null;
  let stops = state.selVeh?.key === key ? state.selVeh.stops : null;
  try {
    if (!variant) {
      const detail = await loadRouteDetail(v.route_id);
      variant = pickVariant(detail.variants || [], v);
      stops = variant?.stops || null;
    }
    const track = await fetchTrack(v.route_id, v.id);
    state.selVeh = { key, routeId: v.route_id, variant, stops, track };
    drawVehicleItinerary(v, state.selVeh);
  } catch (e) {
    state.selVeh = null;
    toast('Itinéraire indisponible : ' + e.message);
  }
  renderDetail();
}

async function fetchTrack(routeId, id) {
  const r = await fetch(`/api/track?route_id=${encodeURIComponent(routeId)}&id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error('track ' + r.status);
  const j = await r.json();
  return (j.track || []).map((p) => [p.lat, p.lon]);
}

function drawVehicleItinerary(v, sel) {
  vehLayer.clearLayers();
  const color = '#' + (v.color || 'dc006b');
  const upcoming = new Set((v.remaining || []).map((r) => r.id));
  const currentStopId = v.at_stop_id || v.next_stop_id;

  // Traînée : ce que le véhicule a réellement fait depuis ~45 min.
  if (sel.track.length > 1) {
    L.polyline(sel.track, { color: '#ffffff', weight: 6, opacity: 0.18 }).addTo(vehLayer);
    L.polyline(sel.track, { color, weight: 3, opacity: 0.5, dashArray: '1 7', lineCap: 'round' }).addTo(vehLayer);
  }

  // Tracé complet de la variante dans le bon sens.
  const latlngs = (sel.variant?.shape || []).map(([la, lo]) => [la, lo]);
  if (latlngs.length > 1) {
    // Trait large et lumineux : l'itinéraire doit sauter aux yeux même par-dessus
    // un fond clair, sans avoir à dézoomer.
    L.polyline(latlngs, { color: '#000000', weight: 13, opacity: 0.45, lineCap: 'round', lineJoin: 'round' }).addTo(vehLayer);
    L.polyline(latlngs, { color: '#ffffff', weight: 10, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(vehLayer);
    L.polyline(latlngs, { color, weight: 6, opacity: 1, lineCap: 'round', lineJoin: 'round' }).addTo(vehLayer);
  }

  // Arrêts : passés (creux), prochain (halé), à venir (pleins).
  for (const s of sel.stops || []) {
    const past = !upcoming.has(s.id) && s.id !== currentStopId;
    const isNext = s.id === currentStopId;
    const dep = (v.remaining || []).find((r) => r.id === s.id);
    const marker = L.circleMarker([s.lat, s.lon], past
      ? { radius: 4, color, weight: 2, fillColor: '#0b0e12', fillOpacity: 0.9, opacity: 0.55 }
      : isNext
        ? { radius: 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 }
        : { radius: 5, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 });
    marker.bindTooltip(
      escapeHtml(s.name) + (dep?.time ? ` · ${fmtTime(dep.time)}` : past ? ' · déjà passé' : ''),
      { direction: 'top', className: 'bus-tip' });
    marker.on('click', () => { state.selectedStop = { id: s.id, name: s.name, lat: s.lat, lon: s.lon }; clearVehicle(); vehLayer.clearLayers(); loadDepartures(s.id); });
    marker.addTo(vehLayer);
  }
}

function renderAlerts() {
  $('alertsCount').textContent = `(${state.alerts.length})`;
  const list = state.filterLine
    ? state.alerts.filter((a) => a.routes.length === 0 || a.routes.includes(state.filterLine))
    : state.alerts;
  // Une « info réseau » sans ligne citée (travaux, info générale) ne
  // perturbe rien en particulier : on ne la propage pas aux véhicules.
  state.alertRoutes = new Set(
    state.alerts.filter((a) => (a.severity ?? 0) > 0).flatMap((a) => a.routes || [])
  );
  if (!list.length) { setHtml($('alertList'), '<li class="sev1">Aucune perturbation signalée.</li>'); return; }
  let html = '';
  for (const a of list.slice(0, 30)) {
    const routeTags = (a.routes || []).slice(0, 4).map((id) => {
      const r = routeById.get(id);
      return r ? escapeHtml(r.short_name) : '';
    }).filter(Boolean).join(', ');
    html += `<li class="sev${a.severity ?? 0}"${(a.severity ?? 0) > 0 ? ' data-alert="1"' : ''}><b>${escapeHtml(stripHtml(a.title) || 'Info réseau')}</b>` +
      (routeTags ? `<div class="aroutes">Lignes : ${routeTags}</div>` : '') +
      (a.url ? ` <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">détails → </a>` : '') + '</li>';
  }
  setHtml($('alertList'), html);
}

// Survol d'une info trafic : on met en évidence les véhicules des lignes
// citées, sans changer le filtre (donc sans perdre la vue d'ensemble).
$('alertList').addEventListener('mouseover', (e) => {
  const li = e.target.closest('li[data-alert]');
  if (!li) return;
  const txt = li.textContent;
  const ids = [...routeById.values()].filter((r) => txt.includes(r.short_name)).map((r) => r.route_id);
  if (!ids.length) return;
  state.alertHover = new Set(ids);
  renderMarkers();
});
$('alertList').addEventListener('mouseleave', () => {
  if (!state.alertHover) return;
  state.alertHover = null;
  renderMarkers();
});

function relTime(t) {
  const diff = t - Math.floor(Date.now() / 1000);
  if (diff < 45) return 'à l’instant';
  if (diff < 3600) return `dans ${Math.round(diff / 60)} min`;
  return 'à ' + fmtTime(t);
}

function renderDetail() {
  const box = $('detail');
  // 1) panneau "autour de moi"
  if (state.nearby) {
    let html = `<button class="close" id="dClose">✕</button><h3>📍 Autour de moi</h3>`;
    for (const s of state.nearby.stops) {
      html += `<div class="stoprow"><b>${escapeHtml(s.name)}</b><span class="dist">à ${s.dist_m} m</span>`;
      if (!s.departures.length) html += `<div class="nodep">aucun passage imminent</div>`;
      for (const d of s.departures) html += depHtml(d);
      html += `</div>`;
    }
    setHtml(box, html);
    box.classList.remove('hidden');
    $('dClose').onclick = () => { state.nearby = null; geoLayer.clearLayers(); box.classList.add('hidden'); };
    return;
  }
  // 2) panneau prochains passages d'un arrêt
  if (state.selectedStop) {
    const s = state.selectedStop;
    const fav = isStopFav(s.id);
    let html = `<button class="close" id="dClose">✕</button>` +
      `<h3>🚏 ${escapeHtml(s.name)}` +
      `<button id="dFav" class="fav ${fav ? 'on' : ''}" title="Arrêt favori">${fav ? '★' : '☆'}</button>` +
      `<button id="dNotify" class="bell" data-notify="${escapeHtml(s.id)}" title="Être prévenu avant chaque passage">🔕</button></h3>`;
    if (!state.stopDeps.length) html += '<div class="nodep">Aucun passage dans les 2 prochaines heures.</div>';
    for (const d of state.stopDeps.slice(0, 10)) html += depHtml(d);
    setHtml(box, html);
    box.classList.remove('hidden');
    $('dClose').onclick = () => { state.selectedStop = null; state.stopDeps = []; stopLayer.clearLayers(); box.classList.add('hidden'); renderStopResults(); renderFavStops(); };
    $('dFav').onclick = () => toggleStopFav(state.selectedStop);
    $('dNotify').onclick = () => {
      const id = state.selectedStop.id;
      if (state.notifyStops.has(id)) toggleNotify(false);
      else {
        if (!isStopFav(id)) toggleStopFav(state.selectedStop);
        askNotify();
      }
    };
    updateNotifyButtons();
    return;
  }
  // 3) fiche véhicule
  const v = currentVehicle();
  if (!v) { box.classList.add('hidden'); return; }
  const statusTxt = { en_route: 'En circulation', at_stop: 'À l’arrêt', not_started: 'Pas encore parti', terminus: 'Terminus' }[v.status] || v.status;
  const lieu = v.status === 'en_route' ? `${v.from} → ${v.to}` : (v.at_stop || '—');
  const next = v.next_stop ? `${v.next_stop}${v.next_time ? ' · ' + fmtTime(v.next_time) : ''}` : '—';
  const sel = state.selVeh;
  const remaining = v.remaining || [];
  const steps = remaining.map((r) =>
    `<div class="step${r.id === v.at_stop_id ? ' now' : ''}"><span class="dot"></span>` +
    `<span class="nm">${escapeHtml(r.name)}</span><span class="tm">${r.time ? fmtTime(r.time) : ''}</span></div>`).join('');

  setHtml(box, `<button class="close" id="dClose">✕</button>` +
    `<span class="dline" style="background:#${v.color};color:#${v.text_color}">${escapeHtml(v.line)}</span>` +
    `<span class="status-tag ${v.status}">${statusTxt}</span>` +
    (v.theoretical ? '<span class="theo-tag" title="Le GTFS temps réel de Tisséo ne couvre pas ce mode : position calculée à partir des horaires du GTFS statique">théorique</span>' : '') +
    `<h3>→ ${escapeHtml(v.destination)}</h3>` +
    `<dl><dt>Position</dt><dd>${escapeHtml(lieu)}${v.on_route ? ' (sur le tracé)' : v.snapped ? ' (rapprochée)' : ' (estimée)'}</dd>` +
    `<dt>Prochain arrêt</dt><dd>${escapeHtml(next)}</dd>` +
    `<dt>Mode</dt><dd>${escapeHtml(v.mode)}</dd>` +
    `<dt>Véhicule</dt><dd>${v.theoretical
      // L'id technique d'une rame théorique est illisible : on montre la course.
      ? `rame de ${fmtTime(v.depart)} à ${fmtTime(v.arrivee)}`
      : '#' + escapeHtml(String(v.id))}</dd></dl>` +
    `<div class="progress"><i style="width:${Math.round((v.progress || 0) * 100)}%"></i></div>` +
    `<div class="vbtns"><button id="dFollow" class="mini ${state.follow ? 'on' : ''}">${state.follow ? '■ Suivre' : '▶ Suivre le véhicule'}</button>` +
    `<button id="dLine" class="mini">Toute la ligne ${escapeHtml(v.line)}</button></div>` +
    (sel
      ? (steps
        ? `<h4>Prochains arrêts <span class="muted">(${remaining.length})</span></h4><div class="steps">${steps}</div>`
        : '<div class="nodep">Aucun arrêt à venir : le véhicule a terminé son service.</div>')
      : '<div class="nodep">Itinéraire en cours…</div>'));
  box.classList.remove('hidden');
  $('dClose').onclick = () => {
    clearVehicle(); vehLayer.clearLayers(); box.classList.add('hidden');
  };
  $('dFollow').onclick = () => { toggleFollow(); };
  $('dLine').onclick = () => selectLine(v.route_id);
}

function toggleFollow() {
  state.follow = !state.follow;
  const v = currentVehicle();
  if (state.follow && v) map.panTo([v.lat, v.lon], { animate: true, duration: 0.4 });
  renderDetail();
}


// ---------- utilitaires ----------
function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function stripHtml(s) {
  const d = document.createElement('div');
  d.innerHTML = s || '';
  return d.textContent || '';
}

// ---------- événements ----------
let stopSearchT = null;
$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderLineList();
  clearTimeout(stopSearchT);
  stopSearchT = setTimeout(() => searchStopsApi(state.query), 220);
});
$('search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (state.stopResults.length) focusStop(state.stopResults[0]);
});

$('modes').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
  state.mode = btn.dataset.mode;
  renderAll();
});

$('btnRefresh').onclick = () => { state.countdown = 0; };
$('btnFit').onclick = () => {
  const vs = visibleVehicles();
  if (!vs.length) return;
  map.flyToBounds(L.latLngBounds(vs.map((v) => [v.lat, v.lon])).pad(0.15), { duration: 0.8 });
};
$('btnTiles').onclick = () => {
  baseMode = state.dark ? 'light' : 'dark';
  baseIdx = 0; tileErrors = 0; // le filet de sécurité reste actif pour le nouveau fond
  if (!tileSets[baseMode]?.length) loadTiles(); else setBaseLayer();
};
$('btnMap').onclick = () => {
  setVectorOnly(!vectorOnly);
  if (vectorOnly) { loadNetwork().then(fitNetwork); }
  // Retour au fond de carte : on re-teste les fournisseurs, le réseau peut
  // être revenu (VPN coupé, adblocker désactivé…).
  else loadTiles(true);
};

$('btnCopyLink').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Lien copié !');
  } catch (e) { toast('Copie impossible : ' + location.href); }
};
$('btnGeo').onclick = () => {
  if (!navigator.geolocation) { toast('Géolocalisation non supportée.'); return; }
  toast('Localisation en cours…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      geoLayer.clearLayers();
      L.circleMarker([lat, lon], { radius: 8, color: '#fff', weight: 2, fillColor: '#1e90ff', fillOpacity: 1 }).addTo(geoLayer)
        .bindTooltip('Vous êtes ici').openTooltip();
      map.flyTo([lat, lon], 15, { duration: 0.8 });
      loadNearby(lat, lon);
    },
    () => toast('Position refusée ou indisponible.'),
    { timeout: 10000 }
  );
};
$('sidebarToggle').onclick = () => $('sidebar').classList.toggle('open');
// Pendant un déplacement manuel, on fige les pastilles : interpoler en même
// temps que l'utilisateur fait glisser la carte donne une impression de_sdk
// traînée qui n'a rien à voir avec le réseau.
// Pendant un déplacement manuel, on fige les pastilles : les interpoler en
// même temps que l'utilisateur fait glisser la carte donne une impression de
// traînée qui n'a rien à voir avec le réseau. (Le recentrage du mode
// « suivre » est un panTo programmé : il se signale avec selfPan.)
map.on('movestart', () => { if (!selfPan) stopMotion(); });
// Un glissement de l'utilisateur l'emporte sur le suivi automatique.
map.on('dragstart', () => { if (state.follow) { state.follow = false; renderDetail(); } });
map.on('zoomend', () => { if (netLoaded) paintNetwork(); adaptProviderToZoom(); });

// Cadre le réseau entier — utilisé au démarrage en mode tracés, quand
// aucune tuile ne donne de repère géographique.
function fitNetwork() {
  if (!netLayer.getLayers().length) return;
  const b = L.latLngBounds([]);
  netLayer.eachLayer((l) => l.getLatLngs?.().forEach((p) => b.extend(p)));
  if (b.isValid()) map.fitBounds(b.pad(0.04));
}

// ---------- boucle ----------
// Le serveur pousse les changements de flux (SSE) : la boucle ci-dessous
// n'est plus qu'un filet de sécurité si le push est coupé, plus le compteur
// et le rafraîchissement de l'en-tête. Elle reste à 15 s car c'est elle qui
// rattrape une reconnexion perdue.
let sseLive = false;
let pending = false;

setInterval(() => {
  if (document.hidden) return;
  state.countdown -= 1;
  if (state.countdown <= 0) {
    state.countdown = REFRESH_S;
    loadAll();
  } else if (!sseLive) {
    // Sans push, on rafraîchit dès que le compteur est revenu au tiers :
    // inutile d'attendre 15 s quand le flux change toutes les 10 s.
    if (state.countdown < REFRESH_S * 0.6) state.countdown = REFRESH_S;
  }
  $('countdown').textContent = sseLive ? 'live' : state.countdown;
  renderHeader(false);
}, 1000);

function connectStream() {
  if (!('EventSource' in window)) return;
  let es;
  try {
    es = new EventSource('/api/stream');
  } catch { return; }
  es.addEventListener('hello', () => { sseLive = true; });
  es.addEventListener('update', (e) => {
    state.countdown = REFRESH_S;
    // Deux poussées rapprochées ne déclenchent qu'un rechargement : on
    // ignore ce qui arrive pendant qu'une requête est déjà en vol.
    if (pending) return;
    pending = true;
    loadAll().finally(() => { pending = false; });
    try {
      const ts = JSON.parse(e.data)?.rt_timestamp;
      if (ts) state.rtTimestamp = ts;
    } catch { /* donnée illisible : le rechargement est déjà lancé */ }
  });
  es.onerror = () => { sseLive = false; /* EventSource reconnecte tout seul */ };
  es.onopen = () => { sseLive = true; };
}

// PWA : mise en cache du shell applicatif
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// deep link ?ligne=L1 (nom court ou route_id)
(async function init() {
  updateMapButton();
  updateNotifyButtons();
  connectStream();
  await loadTiles();
  if (vectorOnly) { loadNetwork().then(fitNetwork); }
  await loadAll();
  const want = new URLSearchParams(location.search).get('ligne');
  if (want) {
    const q = norm(want);
    const r = state.routes.find((x) => norm(x.short_name) === q || x.route_id === want || norm(x.route_id) === q);
    if (r) selectLine(r.route_id);
  }
})();
