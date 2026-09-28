/* Tisséo Live — frontend carte */
'use strict';

const REFRESH_S = 15;
const readJson = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const state = {
  vehicles: [],
  routes: [],
  alerts: [],
  rtTimestamp: 0,
  filterLine: null, // route_id
  mode: 'all', // all | bus | tram | teleo
  query: '',
  selectedId: null, // clé véhicule
  selectedStop: null, // { id, name, lat, lon }
  stopDeps: [],
  stopResults: [], // résultats de /api/stops/search
  stopFavs: readJson('tisseo.live.stops', []), // [{ id, name, lat, lon }]
  favDeps: new Map(), // stop_id -> départs (favoris)
  nearby: null, // { lat, lon, stops: [...] }
  routeDetail: new Map(), // route_id -> { variants }
  favs: new Set(readJson('tisseo.live.favs', [])),
  dark: true,
  countdown: REFRESH_S,
};

const $ = (id) => document.getElementById(id);
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
  baseLayer = L.tileLayer(p.url, { maxZoom: 19, attribution: p.attribution || '' });
  baseLayer.on('tileerror', onTileError);
  baseLayer.addTo(map);
  if (p.labels) { labelLayer = L.tileLayer(p.labels, { maxZoom: 19 }); labelLayer.addTo(map); }
  state.dark = p.mode !== 'light';
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
const geoLayer = L.layerGroup().addTo(map); // position utilisateur
const stopLayer = L.layerGroup().addTo(map); // arrêt sélectionné (recherche / favoris)
const markers = new Map();

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
    renderAll(vehRes.stale);
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
  if (!state.stopResults.length) { ul.innerHTML = ''; ul.classList.add('hidden'); return; }
  ul.innerHTML = '';
  for (const s of state.stopResults) {
    const fav = isStopFav(s.id);
    const li = document.createElement('li');
    li.className = 'line-item' + (state.selectedStop?.id === s.id ? ' sel' : '');
    li.innerHTML = `<span class="stopdot"></span><span class="stopname">${escapeHtml(s.name)}</span>` +
      `<button class="fav ${fav ? 'on' : ''}" data-fav title="Arrêt favori">${fav ? '★' : '☆'}</button>`;
    li.querySelector('[data-fav]').onclick = (e) => { e.stopPropagation(); toggleStopFav(s); };
    li.onclick = () => focusStop(s);
    ul.appendChild(li);
  }
  ul.classList.remove('hidden');
}

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
  const ul = $('favStopList');
  $('favStopsCount').textContent = `(${state.stopFavs.length})`;
  ul.innerHTML = '';
  ul.style.display = state.stopFavs.length ? '' : 'none';
  for (const s of state.stopFavs) {
    const li = document.createElement('li');
    li.className = 'favstop' + (state.selectedStop?.id === s.id ? ' sel' : '');
    const deps = state.favDeps.get(s.id) || [];
    li.innerHTML = `<div class="stopbody"><b>${escapeHtml(s.name)}</b>` +
      (deps.length ? deps.slice(0, 3).map(depHtml).join('') : '<div class="nodep">chargement…</div>') + '</div>' +
      `<button class="fav on" data-unfav title="Retirer des favoris">★</button>`;
    li.querySelector('[data-unfav]').onclick = (e) => { e.stopPropagation(); toggleStopFav(s); };
    li.onclick = () => focusStop(s);
    ul.appendChild(li);
  }
}

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
function renderAll(stale) {
  renderHeader(stale);
  renderMarkers();
  renderStopResults();
  renderFavStops();
  renderLineList();
  renderAlerts();
  renderDetail();
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

function pillHtml(v, dimmed) {
  const caret = v.bearing != null && v.status === 'en_route'
    ? `<span class="caret" style="transform: rotate(${v.bearing}deg)"></span>` : '';
  return `<div class="pill ${v.status === 'at_stop' ? 'at_stop' : ''} ${dimmed ? 'dimmed' : ''}" style="--c:#${v.color};--tc:#${v.text_color}">${caret}${escapeHtml(v.line)}</div>`;
}

function renderMarkers() {
  const vis = new Set(visibleVehicles().map(vKey));
  for (const [k, m] of markers) {
    if (!vis.has(k)) { markerLayer.removeLayer(m); markers.delete(k); }
  }
  // animation fluide : transition CSS le temps de la mise à jour
  const container = map.getContainer();
  container.classList.add('animating');
  clearTimeout(renderMarkers._t);
  renderMarkers._t = setTimeout(() => container.classList.remove('animating'), 1400);
  for (const v of visibleVehicles()) {
    const k = vKey(v);
    const dimmed = state.filterLine != null && v.route_id !== state.filterLine;
    let m = markers.get(k);
    if (!m) {
      m = L.marker([v.lat, v.lon], {
        icon: L.divIcon({ className: '', html: pillHtml(v, dimmed), iconSize: [46, 24], iconAnchor: [23, 12] }),
      });
      m.bindTooltip(`${escapeHtml(v.line)} → ${escapeHtml(v.destination)}`, { direction: 'top', className: 'bus-tip' });
      m.on('click', () => { state.selectedId = k; state.selectedStop = null; state.nearby = null; stopLayer.clearLayers(); renderDetail(); });
      markers.set(k, m);
      markerLayer.addLayer(m);
    } else {
      m.setLatLng([v.lat, v.lon]);
      m.setIcon(L.divIcon({ className: '', html: pillHtml(v, dimmed), iconSize: [46, 24], iconAnchor: [23, 12] }));
      m.setTooltipContent(`${escapeHtml(v.line)} → ${escapeHtml(v.destination)}`);
    }
  }
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
        c.on('click', () => { state.selectedStop = s; state.selectedId = null; state.nearby = null; loadDepartures(s.id); });
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

  // favoris épinglés en haut
  const favUl = $('favList');
  favUl.innerHTML = '';
  const favItems = state.routes.filter((r) => state.favs.has(r.route_id) && matchQ(r));
  for (const r of favItems) {
    const li = document.createElement('li');
    li.className = 'line-item favline' + (state.filterLine === r.route_id ? ' sel' : '') + ((counts[r.route_id] || 0) === 0 ? ' dim' : '');
    li.innerHTML = lineItemHtml(r, counts[r.route_id] || 0);
    bindLineItem(li, r);
    favUl.appendChild(li);
  }
  favUl.style.display = favItems.length ? '' : 'none';

  $('linesCount').textContent = `(${active.length})`;
  const ul = $('lineList');
  ul.innerHTML = '';
  if (!active.length) { ul.innerHTML = '<li class="line-item dim">Aucune ligne — essayez une autre recherche.</li>'; return; }
  for (const r of active.slice(0, 200)) {
    if (state.favs.has(r.route_id)) continue; // déjà épinglée
    const li = document.createElement('li');
    li.className = 'line-item' + (state.filterLine === r.route_id ? ' sel' : '');
    li.innerHTML = lineItemHtml(r, counts[r.route_id]);
    bindLineItem(li, r);
    ul.appendChild(li);
  }
}

function bindLineItem(li, r) {
  li.querySelector('[data-fav]').onclick = (e) => {
    e.stopPropagation();
    state.favs.has(r.route_id) ? state.favs.delete(r.route_id) : state.favs.add(r.route_id);
    localStorage.setItem('tisseo.live.favs', JSON.stringify([...state.favs]));
    renderLineList();
  };
  li.onclick = () => selectLine(state.filterLine === r.route_id ? null : r.route_id);
}

function selectLine(routeId) {
  state.filterLine = routeId;
  state.selectedId = null;
  state.selectedStop = null;
  state.nearby = null;
  geoLayer.clearLayers();
  stopLayer.clearLayers();
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

function renderAlerts() {
  $('alertsCount').textContent = `(${state.alerts.length})`;
  const ul = $('alertList');
  ul.innerHTML = '';
  const list = state.filterLine
    ? state.alerts.filter((a) => a.routes.length === 0 || a.routes.includes(state.filterLine))
    : state.alerts;
  if (!list.length) { ul.innerHTML = '<li class="sev1">Aucune perturbation signalée.</li>'; return; }
  for (const a of list.slice(0, 30)) {
    const li = document.createElement('li');
    li.className = 'sev' + (a.severity ?? 0);
    const routeTags = (a.routes || []).slice(0, 4).map((id) => {
      const r = routeById.get(id);
      return r ? escapeHtml(r.short_name) : '';
    }).filter(Boolean).join(', ');
    li.innerHTML = `<b>${escapeHtml(stripHtml(a.title) || 'Info réseau')}</b>` +
      (routeTags ? `<div class="aroutes">Lignes : ${routeTags}</div>` : '') +
      (a.url ? ` <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">détails →</a>` : '');
    ul.appendChild(li);
  }
}

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
    box.innerHTML = html;
    box.classList.remove('hidden');
    $('dClose').onclick = () => { state.nearby = null; geoLayer.clearLayers(); box.classList.add('hidden'); };
    return;
  }
  // 2) panneau prochains passages d'un arrêt
  if (state.selectedStop) {
    const s = state.selectedStop;
    const fav = isStopFav(s.id);
    let html = `<button class="close" id="dClose">✕</button>` +
      `<h3>🚏 ${escapeHtml(s.name)} <button id="dFav" class="fav ${fav ? 'on' : ''}" title="Arrêt favori">${fav ? '★' : '☆'}</button></h3>`;
    if (!state.stopDeps.length) html += `<div class="nodep">Aucun passage dans les 2 prochaines heures.</div>`;
    for (const d of state.stopDeps.slice(0, 10)) html += depHtml(d);
    box.innerHTML = html;
    box.classList.remove('hidden');
    $('dClose').onclick = () => { state.selectedStop = null; state.stopDeps = []; stopLayer.clearLayers(); box.classList.add('hidden'); renderStopResults(); renderFavStops(); };
    $('dFav').onclick = () => toggleStopFav(state.selectedStop);
    return;
  }
  // 3) fiche véhicule
  const v = state.vehicles.find((x) => vKey(x) === state.selectedId);
  if (!v) { box.classList.add('hidden'); return; }
  const statusTxt = { en_route: 'En circulation', at_stop: 'À l’arrêt', not_started: 'Pas encore parti', terminus: 'Terminus' }[v.status] || v.status;
  const lieu = v.status === 'en_route' ? `${v.from} → ${v.to}` : (v.at_stop || '—');
  const next = v.next_stop ? `${v.next_stop}${v.next_time ? ' · ' + fmtTime(v.next_time) : ''}` : '—';
  box.innerHTML = `<button class="close" id="dClose">✕</button>` +
    `<span class="dline" style="background:#${v.color};color:#${v.text_color}">${escapeHtml(v.line)}</span>` +
    `<span class="status-tag ${v.status}">${statusTxt}</span>` +
    `<h3>→ ${escapeHtml(v.destination)}</h3>` +
    `<dl><dt>Position</dt><dd>${escapeHtml(lieu)}${v.snapped ? ' (tracé)' : ' (estimée)'}</dd>` +
    `<dt>Prochain arrêt</dt><dd>${escapeHtml(next)}</dd>` +
    `<dt>Mode</dt><dd>${escapeHtml(v.mode)}</dd>` +
    `<dt>Véhicule</dt><dd>#${escapeHtml(String(v.id))}</dd></dl>` +
    `<div class="progress"><i style="width:${Math.round(v.progress * 100)}%"></i></div>`;
  box.classList.remove('hidden');
  $('dClose').onclick = () => { state.selectedId = null; box.classList.add('hidden'); };
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
map.on('movestart', () => map.getContainer().classList.remove('animating'));
map.on('zoomend', () => { if (netLoaded) paintNetwork(); });

// Cadre le réseau entier — utilisé au démarrage en mode tracés, quand
// aucune tuile ne donne de repère géographique.
function fitNetwork() {
  if (!netLayer.getLayers().length) return;
  const b = L.latLngBounds([]);
  netLayer.eachLayer((l) => l.getLatLngs?.().forEach((p) => b.extend(p)));
  if (b.isValid()) map.fitBounds(b.pad(0.04));
}

// ---------- boucle ----------
setInterval(() => {
  if (document.hidden) return;
  state.countdown -= 1;
  if (state.countdown <= 0) {
    state.countdown = REFRESH_S;
    loadAll();
  }
  $('countdown').textContent = state.countdown;
  renderHeader(false);
}, 1000);

// PWA : mise en cache du shell applicatif
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// deep link ?ligne=L1 (nom court ou route_id)
(async function init() {
  updateMapButton();
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
