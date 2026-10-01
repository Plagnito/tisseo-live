/* Mode Ville, indépendant du rafraîchissement du flux Tisséo. */
(() => {
  'use strict';
  const icons = {
    bike: '<circle cx="5" cy="17" r="4"/><circle cx="19" cy="17" r="4"/><path d="m5 17 5-9 6 9H5m5-9h5l4 9M8 5h4m3 0h3l1 3"/>',
    parking: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M10 17V7h3a3 3 0 0 1 0 6h-3"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-13 4h2m4 0h2"/>',
    culture: '<path d="m3 9 9-6 9 6H3m2 2v7m5-7v7m4-7v7m5-7v7M3 21h18"/>',
    landmark: '<path d="M4 21h16M6 21V10h12v11M4 10l8-7 8 7M10 21v-7h4v7M9 8h6"/>',
    food: '<path d="M6 3v7m-3-7v5a3 3 0 0 0 6 0V3M6 11v10M19 21V3c-4 3-4 9 0 10"/>',
    leaf: '<path d="M20 3C7 2 2 9 5 16s15 4 15-13ZM3 21l12-12"/>',
    market: '<path d="M3 10h18l-2-6H5l-2 6Zm1 0v11h16V10m-12 0v3m8-3v3M8 21v-5h8v5"/>',
    sport: '<circle cx="12" cy="12" r="9"/><path d="m9 8 6 0 2 6-5 4-5-4 2-6ZM12 3v5m8 8-3-2M4 16l3-2m2 6 3-2"/>',
    book: '<path d="M12 5v16m0-16C8 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-2-1-6-2-10 1Z"/>',
    building: '<path d="M4 21V5h16v16M2 21h20M8 9h1m6 0h1M8 13h1m6 0h1M10 21v-4h4v4"/>',
    water: '<path d="M12 3c-3 5-7 9-7 12a7 7 0 0 0 14 0c0-3-4-7-7-12Z"/>',
    pin: '<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    works: '<path d="M3 21h18M6 17l4-13h4l4 13M7 13h10M9 8h6M5 17h14v4H5z"/>',
  };
  const svg = (id) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[id] || icons.pin}</svg>`;
  const h = escapeHtml;
  const saved = readJson('tisseo.city.settings', {});
  let active = false, catalog = [], categories = new Map(), selected = new Set(), preset = 'all', initialized = false, myLocation = null;
  let selectedPlace = null, listLimit = 30, renderTimer, searchTimer, loadingCatalog = false, catalogError = false;
  const data = new Map(), loading = new Set(), markersById = new Map();
  const favorites = new Map(Object.entries(readJson('tisseo.city.favorites', {})));
  let favoritesOnly = false, intent = '', iso = null, isoOrigin = null, isoRequest = 0, weather = null, alerts = null, todayLoading = false;
  const walkLayer = L.layerGroup(), zoneLayer = L.layerGroup();
  let detailOrigin = null;
  const layer = useCluster ? L.markerClusterGroup({ maxClusterRadius: 48, showCoverageOnHover: false, disableClusteringAtZoom: 18,
    iconCreateFunction: (c) => {
      const mix = new Map(); for (const m of c.getAllChildMarkers()) mix.set(m.options.cityCategory, (mix.get(m.options.cityCategory) || 0) + 1);
      const sorted = [...mix].sort((a, b) => b[1] - a[1]); let pct = 0;
      const segments = sorted.map(([id, n]) => { const start = pct; pct += n / c.getChildCount() * 100; return `${categories.get(id)?.color || '#e9aa89'} ${start}% ${pct}%`; });
      const title = sorted.map(([id, n]) => `${n} ${categories.get(id)?.label || id}`).join(', ');
      return L.divIcon({ className: '', html: `<div class="city-cluster city-cluster-mix" style="background:conic-gradient(${segments.join(',')})" title="${h(title)}"><span><b>${c.getChildCount()}</b><small>${sorted.length > 1 ? `${sorted.length} types` : h(categories.get(sorted[0][0])?.label || '')}</small></span></div>`, iconSize: [48, 48] });
    } }) : L.layerGroup();
  const focusLayer = L.layerGroup();
  const queue = [];
  let busy = 0;
  const date = (value, withTime = false) => {
    if (!value) return 'date non fournie';
    const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
    return Number.isFinite(d.getTime()) ? d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }) : 'date non fournie';
  };
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const distance = (p) => map.distance(map.getCenter(), [p.lat, p.lon]);
  const distLabel = (d) => d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`;
  function remember() {
    try { localStorage.setItem('tisseo.city.settings', JSON.stringify({ categories: [...selected], transport: $('cityTransport').checked, inView: $('cityInView').checked, period: $('cityPeriod').value })); } catch { /* stockage désactivé */ }
  }
  function syncTransport() {
    const show = !active || $('cityTransport').checked;
    for (const l of [markerLayer, selLayer]) {
      if (show && !map.hasLayer(l)) map.addLayer(l);
      if (!show && map.hasLayer(l)) map.removeLayer(l);
    }
    for (const l of [shapeLayer, vehLayer, stopLayer, netLayer]) {
      const wanted = !active || (l === netLayer && vectorOnly);
      if (wanted && !map.hasLayer(l)) map.addLayer(l);
      if (!wanted && map.hasLayer(l)) map.removeLayer(l);
    }
  }
  function setActive(value, { persist = true } = {}) {
    active = Boolean(value);
    document.body.classList.toggle('city-view', active);
    for (const id of ['cityPanel', 'cityHeader', 'cityMapNote']) $(id).classList.toggle('hidden', !active);
    for (const id of ['transportPanel', 'transportStats', 'liveBadge', 'btnMap']) $(id).classList.toggle('hidden', active);
    $('viewCity').classList.toggle('active', active); $('viewCity').setAttribute('aria-pressed', String(active));
    $('viewTransport').classList.toggle('active', !active); $('viewTransport').setAttribute('aria-pressed', String(!active));
    $('appTitle').innerHTML = active ? 'Toulouse <em>Ville</em>' : 'Tisséo <em>Live</em>';
    document.title = active ? 'Toulouse Ville — Explorer la ville' : 'Tisséo Live — Véhicules en direct à Toulouse';
    map.attributionControl.setPrefix(active ? 'Toulouse Métropole (Licence Ouverte) · OSM / Cyclocity (ODbL)' : 'Tisséo / Toulouse Métropole (ODbL)');
    $('btnFit').title = active ? 'Recentrer sur les lieux sélectionnés' : 'Zoomer sur les véhicules';
    $('btnGeo').title = active ? 'Explorer les lieux autour de moi' : 'Véhicules et arrêts autour de moi';
    $('btnRefresh').title = active ? 'Actualiser les données de la ville' : 'Actualiser';
    $('countdown').classList.toggle('hidden', active); $('countdownS').classList.toggle('hidden', active);
    if (active) {
      $('sidebar').classList.remove('open');
      state.follow = false;
      closeInventory(); $('detail').classList.add('hidden'); hideError();
      layer.addTo(map); focusLayer.addTo(map); walkLayer.addTo(map); zoneLayer.addTo(map);
      if (!initialized) {
        initialized = true;
        // Le fond clair donne les noms de rues et les repères de quartier
        // utiles aux lieux de la ville ; le bouton de thème reste disponible.
        baseMode = 'light'; baseIdx = 0; tileErrors = 0;
        if (!vectorOnly && tileSets.light?.length) setBaseLayer();
        map.setView([43.6047, 1.4442], 14);
        loadCatalog();
        loadToday();
      }
      render();
      if (selectedPlace) renderDetail();
    } else {
      if (map.hasLayer(layer)) map.removeLayer(layer);
      if (map.hasLayer(focusLayer)) map.removeLayer(focusLayer);
      map.removeLayer(walkLayer); map.removeLayer(zoneLayer);
      $('cityDetail').classList.add('hidden');
      renderAll();
    }
    syncTransport();
    if (persist) {
      const url = new URL(location.href);
      if (active) url.searchParams.set('vue', 'ville'); else url.searchParams.delete('vue');
      history.replaceState(null, '', url);
      try { localStorage.setItem('tisseo.map.view', JSON.stringify(active ? 'city' : 'transport')); } catch { /* stockage désactivé */ }
    }
    map.invalidateSize();
  }
  async function loadCatalog() {
    if (loadingCatalog) return;
    loadingCatalog = true; catalogError = false;
    $('cityFeedback').textContent = 'Chargement des catégories…';
    try {
      const r = await fetch('/api/city/catalog', { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error('Catalogue indisponible');
      const j = await r.json();
      if (!Array.isArray(j.categories)) throw new Error('Catalogue incorrect');
      catalog = j.categories;
      categories = new Map(catalog.map((c) => [c.id, c]));
      selected = new Set(Array.isArray(saved.categories) ? saved.categories.filter((id) => categories.has(id)) : ['bikes', 'parking', 'events', 'culture', 'parks', 'services']);
      if (selected.size < catalog.length) document.querySelectorAll('#cityPresets button').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
      renderCategories();
      loadSelected();
      for (const id of ['events', 'works']) if (!data.has(id)) enqueue(id);
    } catch {
      catalogError = true;
      $('cityFeedback').textContent = 'Le catalogue est indisponible. Clique sur ↻ pour réessayer.';
    } finally { loadingCatalog = false; render(); }
  }
  function loadSelected() {
    for (const id of selected) if (!data.has(id) && !loading.has(id)) enqueue(id);
  }
  function enqueue(id) {
    if (loading.has(id)) return;
    loading.add(id); queue.push(id); renderCategories();
    pump();
  }
  function pump() {
    while (busy < 4 && queue.length) {
      const id = queue.shift(); busy++;
      fetch(`/api/city/places?category=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(35_000) })
        .then(async (r) => { if (!r.ok) throw new Error('Source indisponible'); return r.json(); })
        .then((j) => { if (!Array.isArray(j.places)) throw new Error('Données incorrectes'); data.set(id, j); })
        .catch(() => {
          const old = data.get(id);
          data.set(id, { ...old, places: old?.places || [], status: old?.places?.length ? 'stale' : 'unavailable', message: 'Source indisponible. Clique sur ↻ pour réessayer.' });
        })
        .finally(() => { loading.delete(id); busy--; rebuildMarkers(); renderCategories(); render(); renderDetail(); pump(); });
    }
  }
  function dateAllowed(p) {
    const day = today();
    if ((p.category === 'events' || p.category === 'works') && p.end_date < day) return false;
    if (p.category !== 'events') return true;
    if ($('cityEventTag').value && !p.tags?.includes($('cityEventTag').value)) return false;
    if ($('cityPeriod').value === 'upcoming') return true;
    if ($('cityPeriod').value === 'tonight') {
      return window.CE?.eventTonight(p, day) || false;
    }
    const end = new Date(`${day}T12:00:00Z`);
    if ($('cityPeriod').value === 'week') end.setUTCDate(end.getUTCDate() + 6);
    const lastDay = end.toISOString().slice(0, 10);
    if (p.sessions?.length && window.CE) return p.sessions.some((s) => window.CE.parisDay(s.begin) <= lastDay && window.CE.parisDay(s.end) >= day);
    return p.start_date <= lastDay && p.end_date >= day;
  }
  function allPlaces() {
    const q = norm($('citySearch').value.trim());
    const pool = favoritesOnly ? [...favorites.values()].map((p) => data.get(p.category)?.places.find((x) => x.id === p.id) || p) : [...selected].flatMap((id) => data.get(id)?.places || []);
    return pool.filter((p) => categories.has(p.category) && dateAllowed(p) && (!q || norm(`${p.name} ${p.address} ${p.city} ${p.subtitle} ${p.description}`).includes(q))
      && (!$('cityOpen').checked || (window.CE?.openingState(p.opening_hours) || p.opening_state) === 'open')
      && (!$('cityFree').checked || p.free_access === true || p.tags?.includes('free'))
      && (!$('cityAccessible').checked || p.wheelchair === 'yes') && (!$('cityVegetarian').checked || p.vegetarian === true)
      && (!iso || (window.CE?.walkingBand(p, iso.features) ?? Infinity) <= Number($('cityWalkMinutes').value)));
  }
  function visiblePlaces() {
    const bounds = map.getBounds();
    return allPlaces().filter((p) => !$('cityInView').checked || bounds.contains([p.lat, p.lon])).sort((a, b) => distance(a) - distance(b) || a.name.localeCompare(b.name, 'fr'));
  }
  function pin(p, selectedIcon = false) {
    const c = categories.get(p.category);
    return L.divIcon({ className: 'city-pin-wrap', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="city-pin${selectedIcon ? ' selected' : ''}" style="--c:${c.color}">${svg(c.icon)}</div>` });
  }
  function rebuildMarkers() {
    layer.clearLayers(); markersById.clear();
    const points = allPlaces();
    for (const p of points) {
      if (p.id === selectedPlace?.id) continue;
      const m = L.marker([p.lat, p.lon], { icon: pin(p), title: p.name, keyboard: true, cityCategory: p.category });
      m.bindTooltip(h(p.name), { className: 'city-tooltip', direction: 'top', offset: [0, -13] });
      m.on('click', () => selectPlace(p));
      markersById.set(p.id, m); layer.addLayer(m);
    }
    focusLayer.clearLayers();
    if (selectedPlace && points.some((p) => p.id === selectedPlace.id)) {
      L.marker([selectedPlace.lat, selectedPlace.lon], { icon: pin(selectedPlace, true), zIndexOffset: 1000, title: selectedPlace.name }).addTo(focusLayer).on('click', () => renderDetail());
    } else if (selectedPlace) { selectedPlace = null; $('cityDetail').classList.add('hidden'); }
  }
  function renderCategories() {
    document.querySelectorAll('#cityPresets button').forEach((b) => {
      const ids = catalog.filter((c) => b.dataset.preset === 'all' || c.group === b.dataset.preset).map((c) => c.id);
      const matches = ids.length > 0 && ids.length === selected.size && ids.every((id) => selected.has(id));
      b.classList.toggle('active', matches); b.setAttribute('aria-pressed', String(matches));
    });
    setHtml($('cityCategories'), catalog.map((c) => {
      const d = data.get(c.id), isLoading = loading.has(c.id);
      const count = isLoading ? '…' : d?.status === 'unavailable' ? '!' : d ? String(d.places.length) : '—';
      return `<button class="city-category${selected.has(c.id) ? ' active' : ''}${d?.status === 'unavailable' ? ' unavailable' : d?.status === 'stale' ? ' stale' : ''}" style="--c:${c.color}" data-category="${h(c.id)}" aria-pressed="${selected.has(c.id)}" title="${h(d?.message || c.label)}">${svg(c.icon)}<span class="category-label">${h(c.label)}</span><span class="category-count">${count}</span></button>`;
    }).join(''));
    $('cityEventFilters').classList.toggle('hidden', !selected.has('events'));
    $('cityClear').textContent = selected.size ? 'Tout masquer' : 'Tout afficher';
  }
  function render() {
    if (!active || catalogError || loadingCatalog) return;
    const places = visiblePlaces(), total = allPlaces().length;
    const pendingCount = [...selected].filter((id) => loading.has(id)).length;
    const unavailable = [...selected].filter((id) => data.get(id)?.status === 'unavailable');
    const old = [...selected].filter((id) => data.get(id)?.status === 'stale');
    renderToday();
    $('cityFavoriteCount').textContent = favorites.size;
    $('cityFavorites').classList.toggle('active', favoritesOnly); $('cityFavorites').setAttribute('aria-pressed', String(favoritesOnly));
    $('cityResultCount').textContent = places.length;
    $('cityHeaderText').textContent = pendingCount ? `${pendingCount} sources en cours…` : `${total.toLocaleString('fr-FR')} lieux & infos`;
    $('cityMapSummary').textContent = `${selected.size} catégories · ${places.length.toLocaleString('fr-FR')} résultats${$('cityInView').checked ? ' dans la vue' : ''}`;
    const feedback = [];
    if (!selected.size) feedback.push('Active une catégorie pour explorer la ville.');
    else if (pendingCount) feedback.push('Les lieux apparaissent au fur et à mesure du chargement.');
    else if (!places.length) feedback.push($('citySearch').value ? 'Aucun résultat dans les catégories sélectionnées. Essaie un autre mot ou élargis la vue.' : 'Aucun résultat ici. Déplace la carte, élargis la vue ou active d’autres catégories.');
    if (unavailable.length) feedback.push(`Sources indisponibles : ${unavailable.map((id) => categories.get(id).label).join(', ')}. Réessayer : ↻.`);
    if (old.length) feedback.push('Certaines sources sont indisponibles : leurs dernières données sont conservées.');
    if (selected.size === 1 && selected.has('events') && data.get('events')?.message) feedback.push(data.get('events').message);
    $('cityFeedback').textContent = feedback.join(' ');
    setHtml($('cityResults'), places.slice(0, listLimit).map((p) => {
      const c = categories.get(p.category);
      let sub = p.address || p.subtitle || c.label;
      if (p.category === 'bikes') sub = p.bikes === null ? 'Disponibilité inconnue' : `${p.bikes} vélos · ${p.docks ?? '?'} places · dernier relevé`;
      if (p.category === 'events') sub = `${date(p.start_date)} → ${date(p.end_date)}`;
      return `<li><button class="city-result${selectedPlace?.id === p.id ? ' selected' : ''}" data-place="${h(p.id)}"><span class="city-result-icon" style="--c:${c.color}">${svg(c.icon)}</span><span class="city-result-body"><b>${favorites.has(p.id) ? '★ ' : ''}${h(p.name)}</b><small>${h(sub)}</small></span><span class="city-result-distance" title="${iso ? 'Zone de marche calculée sur les chemins' : 'Distance à vol d’oiseau du centre de la carte'}">${iso ? `≤ ${window.CE.walkingBand(p, iso.features)} min` : distLabel(distance(p))}</span></button></li>`;
    }).join(''));
    $('cityMore').classList.toggle('hidden', places.length <= listLimit);
    setHtml($('citySources'), [...selected].map((id) => {
      const c = categories.get(id), d = data.get(id);
      return `<div class="city-source"><b>${h(c.label)}</b><a href="${h(c.source.url)}" target="_blank" rel="noopener noreferrer">${h(c.source.label)} ↗</a><br>${h(c.source.license)}${d?.source_updated_at ? `<br>Données du ${h(date(d.source_updated_at, true))}` : ''}${d?.fetched_at ? `<br>Consultées le ${h(date(d.fetched_at, true))}` : ''}${d?.message ? `<br><span class="city-source-status">${h(d.message)}</span>` : ''}${id === 'events' ? '<br>Agenda public partiel. Consulte aussi l’agenda municipal.' : ''}</div>`;
    }).join(''));
  }
  function selectPlace(p) {
    detailOrigin = { lat: map.getCenter().lat, lon: map.getCenter().lng };
    selectedPlace = p;
    $('sidebar').classList.remove('open');
    rebuildMarkers(); renderDetail(); render();
    map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 16), { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : .6 });
  }
  function renderDetail() {
    if (!active || !selectedPlace) return;
    const d = data.get(selectedPlace.category);
    const p = d?.places?.find((x) => x.id === selectedPlace.id) || selectedPlace;
    selectedPlace = p;
    const c = categories.get(p.category);
    const age = p.reported_at ? Math.max(0, Math.round((Date.now() / 1000 - p.reported_at) / 60)) : null;
    const bikes = p.category === 'bikes' ? `<div class="city-bike-counts"><span><b>${p.bikes ?? '?'}</b>vélos au dernier relevé</span><span><b>${p.docks ?? '?'}</b>places au dernier relevé</span></div><p class="city-data-age">${age === null ? 'Âge du relevé inconnu.' : `Relevé ${age < 1 ? 'il y a moins d’une minute' : `il y a ${age} min`}${age > 10 ? ' · ancien, disponibilité à vérifier' : ''}.`}${p.renting === false ? ' Location suspendue.' : ''}${p.returning === false ? ' Retour suspendu.' : ''}</p>` : '';
    const dates = p.start_date ? `<p class="city-detail-dates">${h(date(p.start_date))} → ${h(date(p.end_date))}</p>` : '';
    const details = (p.details || []).map((f) => `<dt>${h(f.label)}</dt><dd>${h(f.value)}</dd>`).join('');
    setHtml($('cityDetail'), `<button class="close" id="cityDetailClose" aria-label="Fermer la fiche">✕</button><div class="city-detail-type" style="--c:${c.color}">${svg(c.icon)}${h(p.subtitle || c.label)}</div><h3>${h(p.name)}</h3>${p.address || p.city ? `<p>${h([p.address, p.city].filter(Boolean).join(' · '))}</p>` : ''}${dates}${bikes}${p.description ? `<p>${h(p.description)}</p>` : ''}${details ? `<dl>${details}</dl>` : ''}<div class="city-detail-actions"><button id="cityJourney">Y aller en transports</button>${p.url ? `<a href="${h(p.url)}" target="_blank" rel="noopener noreferrer">Site du lieu ↗</a>` : ''}${p.phone ? `<a href="tel:${h(p.phone.replace(/[^+\d]/g, ''))}">Appeler</a>` : ''}</div><p class="city-detail-source"><a href="${h(p.source_url || d?.source?.url || c.source.url)}" target="_blank" rel="noopener noreferrer">${h(c.source.label)} ↗</a><br>${h(c.source.license)}${d?.source_updated_at ? `<br>Données du ${h(date(d.source_updated_at, true))}` : ''}${d?.status === 'stale' ? '<br>Source indisponible · dernières données conservées.' : ''}${p.category === 'events' ? '<br>Dates issues de l’agenda public. Vérifie auprès de l’organisateur.' : ''}</p>`);
    $('cityDetail').classList.remove('hidden');
    const actions = $('cityDetail').querySelector('.city-detail-actions');
    $('cityDetail').querySelectorAll('#cityFavorite, #cityWalk, .city-detail-sessions').forEach((el) => el.remove());
    const favoriteButton = document.createElement('button'); favoriteButton.id = 'cityFavorite'; favoriteButton.textContent = favorites.has(p.id) ? '★ Retirer des favoris' : '☆ Enregistrer ce lieu';
    favoriteButton.onclick = () => {
      if (favorites.has(p.id)) favorites.delete(p.id); else favorites.set(p.id, p);
      try { localStorage.setItem('tisseo.city.favorites', JSON.stringify(Object.fromEntries(favorites))); } catch { toast('Le stockage des favoris est indisponible.'); }
      renderDetail(); rebuildMarkers(); render();
    };
    actions.prepend(favoriteButton);
    const walkingButton = document.createElement('button'); walkingButton.id = 'cityWalk'; walkingButton.textContent = 'Y aller à pied'; walkingButton.onclick = () => walkTo(p); actions.append(walkingButton);
    const sourceLink = $('cityDetail').querySelector('.city-detail-source a');
    if (p.source_label) sourceLink.textContent = `${p.source_label} ↗`;
    if (p.sessions?.length) {
      const times = document.createElement('p'); times.className = 'city-detail-dates city-detail-sessions';
      times.textContent = 'Prochains créneaux : ' + p.sessions.filter((s) => Date.parse(s.end) > Date.now()).slice(0, 5).map((s) => `${date(s.begin, true)} → ${date(s.end, true)}`).join(' · ');
      actions.before(times);
    }
    $('cityDetailClose').onclick = () => { selectedPlace = null; $('cityDetail').classList.add('hidden'); rebuildMarkers(); render(); };
    $('cityJourney').onclick = () => {
      $('jTo').value = `${p.lat},${p.lon}`;
      const from = myLocation || state.nearby;
      if (from) $('jFrom').value = `${from.lat},${from.lon}`;
      setActive(false); $('planner').open = true; $('sidebar').classList.add('open');
      if (!$('jFrom').value) $('jFrom').focus();
      toast(`Destination : ${p.name}. Choisis ton départ.`);
    };
  }
  function fit() {
    const points = allPlaces();
    if (!points.length) { map.setView([43.6047, 1.4442], 13); return; }
    map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon])).pad(.08), { maxZoom: 16 });
  }
  function refresh() {
    if (!catalog.length) { loadCatalog(); return; }
    for (const id of selected) enqueue(id);
    render();
    loadToday();
  }
  async function loadToday() {
    if (todayLoading) return; todayLoading = true;
    const result = await Promise.allSettled(['/api/city/weather', '/api/alerts'].map(async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(15_000) }); if (!r.ok) throw new Error(); return r.json(); }));
    weather = result[0].status === 'fulfilled' ? result[0].value : null;
    alerts = result[1].status === 'fulfilled' ? result[1].value.alerts : null;
    todayLoading = false; renderToday();
  }
  function renderToday() {
    const events = data.get('events')?.places.filter((p) => window.CE ? window.CE.eventOnDay(p) : p.start_date <= today() && p.end_date >= today());
    const works = data.get('works')?.places.filter((p) => p.start_date <= today() && p.end_date >= today());
    const weatherText = weather ? `${Math.round(weather.temperature_2m)}° · ${weather.weather_code === 0 ? 'Ciel dégagé' : weather.weather_code <= 3 ? 'Nuages & éclaircies' : weather.weather_code <= 48 ? 'Brouillard' : weather.weather_code < 71 ? 'Pluie possible' : weather.weather_code < 86 ? 'Précipitations' : 'Orages possibles'}` : todayLoading ? 'Météo en cours…' : 'Météo indisponible';
    setHtml($('cityToday'), `<b>${h(weatherText)}</b>${weather ? `<small>${weather.min}° / ${weather.max}° · pluie ${weather.rain_probability ?? '?'} %<br>Prévision <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> · ${h(date(weather.fetched_at, true))}</small>` : ''}<div class="city-today-counts"><button data-today="events">${events?.length ?? '…'} sorties</button><button data-today="works">${works?.length ?? '…'} chantiers</button><button data-today="alerts">${alerts ? `${alerts.length} infos Tisséo` : 'Infos Tisséo indisponibles'}</button></div>${alerts?.length ? `<small>${h(alerts[0].title || alerts[0].header || alerts[0].header_text || alerts[0].description?.replace(/<[^>]*>/g, " ") || 'Perturbation signalée sur le réseau')}</small>` : ''}`);
    $('cityToday').onclick = (e) => {
      const kind = e.target.closest('[data-today]')?.dataset.today; if (!kind) return;
      if (kind === 'alerts') { setActive(false); $('sidebar').classList.add('open'); return; }
      selected = new Set([kind]); favoritesOnly = false; $('cityPeriod').value = 'today'; resetPractical();
      loadSelected(); remember(); rebuildMarkers(); renderCategories(); render();
    };
  }
  function resetPractical() { for (const id of ['cityOpen', 'cityFree', 'cityAccessible', 'cityVegetarian']) $(id).checked = false; $('cityEventTag').value = ''; }
  async function calculateAround(origin) {
    const ticket = ++isoRequest; iso = null; isoOrigin = origin; zoneLayer.clearLayers(); walkLayer.clearLayers(); rebuildMarkers(); render();
    $('cityAroundStatus').textContent = 'Calcul des chemins à 5, 10 et 15 minutes…';
    try {
      const r = await fetch(`/api/city/isochrone?lat=${origin.lat}&lon=${origin.lon}`, { signal: AbortSignal.timeout(30_000) }); const j = await r.json();
      if (!r.ok) throw new Error(j.error); if (ticket !== isoRequest) return;
      iso = j; drawZones(); $('cityAroundClear').classList.remove('hidden'); $('cityInView').checked = false;
      map.fitBounds(L.geoJSON(j).getBounds(), { padding: [30, 30], maxZoom: 16 });
      $('cityAroundStatus').textContent = 'Zones estimées sur les chemins · Valhalla / OSM. Départ : ' + (origin === myLocation ? 'ma position.' : 'centre choisi sur la carte.');
      rebuildMarkers(); render();
    } catch (e) { if (ticket === isoRequest) $('cityAroundStatus').textContent = e.message || 'Calcul piéton indisponible.'; }
  }
  function drawZones() {
    zoneLayer.clearLayers(); if (!iso) return;
    const minutes = Number($('cityWalkMinutes').value);
    L.geoJSON({ type: 'FeatureCollection', features: iso.features.filter((f) => Number(f.properties.contour) === minutes) }, { style: { color: '#b96e50', weight: 2, fillColor: '#e9aa89', fillOpacity: .14 } }).addTo(zoneLayer);
    L.circleMarker([isoOrigin.lat, isoOrigin.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#b96e50', fillOpacity: 1 }).addTo(zoneLayer);
  }
  async function walkTo(p) {
    const origin = isoOrigin || myLocation || detailOrigin || { lat: map.getCenter().lat, lon: map.getCenter().lng };
    const ticket = p.id; toast('Calcul du parcours à pied…'); walkLayer.clearLayers();
    try {
      const q = new URLSearchParams({ from_lat: origin.lat, from_lon: origin.lon, to_lat: p.lat, to_lon: p.lon });
      const r = await fetch(`/api/city/walk?${q}`, { signal: AbortSignal.timeout(30_000) }); const j = await r.json(); if (!r.ok) throw new Error(j.error);
      if (selectedPlace?.id !== ticket || !active) return;
      const line = L.geoJSON({ type: 'Feature', geometry: j.geometry }, { style: { color: '#b96e50', weight: 5, opacity: .9 } }).addTo(walkLayer);
      map.fitBounds(line.getBounds(), { padding: [35, 35], maxZoom: 17 });
      let box = $('cityWalkResult'); if (!box) { box = document.createElement('div'); box.id = 'cityWalkResult'; $('cityDetail').querySelector('.city-detail-actions').after(box); }
      setHtml(box, `<p><b>${Math.ceil(j.duration_s / 60)} min à pied · ${distLabel(j.distance_m)}</b><br>Départ : ${isoOrigin ? 'point de la zone à pied' : myLocation ? 'ma position' : 'centre de la carte avant la sélection'}</p><details><summary>Étapes du parcours</summary><ol>${j.instructions.map((s) => `<li>${h(s.text)}</li>`).join('')}</ol></details><small>${h(j.notice)} · ${h(j.source)}</small>`);
    } catch (e) { toast(e.message || 'Parcours indisponible.'); }
  }
  $('viewCity').onclick = () => setActive(true);
  $('viewTransport').onclick = () => setActive(false);
  $('cityDate').textContent = new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
  $('cityCategories').onclick = (e) => {
    const b = e.target.closest('[data-category]'); if (!b) return;
    const id = b.dataset.category;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    preset = null;
    document.querySelectorAll('#cityPresets button').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
    listLimit = 30; loadSelected(); remember(); rebuildMarkers(); renderCategories(); render();
  };
  $('cityPresets').onclick = (e) => {
    const b = e.target.closest('[data-preset]'); if (!b) return;
    preset = b.dataset.preset;
    favoritesOnly = false; intent = ''; resetPractical(); $('cityPeriod').value = 'upcoming';
    selected = new Set(catalog.filter((c) => preset === 'all' || c.group === preset).map((c) => c.id));
    document.querySelectorAll('#cityPresets button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    listLimit = 30; loadSelected(); remember(); rebuildMarkers(); renderCategories(); render();
  };
  $('cityClear').onclick = () => {
    selected = selected.size ? new Set() : new Set(catalog.map((c) => c.id));
    loadSelected(); remember(); rebuildMarkers(); renderCategories(); render();
  };
  $('cityResults').onclick = (e) => {
    const b = e.target.closest('[data-place]'); if (!b) return;
    const p = allPlaces().find((p) => p.id === b.dataset.place); if (p) selectPlace(p);
  };
  $('citySearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { listLimit = 30; rebuildMarkers(); render(); }, 180); };
  $('citySearch').onkeydown = (e) => { if (e.key === 'Enter') { const p = visiblePlaces()[0]; if (p) selectPlace(p); } };
  $('cityPeriod').onchange = () => { listLimit = 30; remember(); rebuildMarkers(); render(); };
  for (const id of ['cityEventTag', 'cityOpen', 'cityFree', 'cityAccessible', 'cityVegetarian']) $(id).onchange = () => { listLimit = 30; rebuildMarkers(); render(); };
  $('cityFavorites').onclick = () => { favoritesOnly = !favoritesOnly; resetPractical(); $('cityPeriod').value = 'upcoming'; if (favoritesOnly) for (const id of new Set([...favorites.values()].map((p) => p.category))) if (!data.has(id)) enqueue(id); rebuildMarkers(); render(); };
  $('cityIntents').addEventListener('click', (e) => {
    const b = e.target.closest('[data-intent]'); if (!b) return; intent = b.dataset.intent; favoritesOnly = false; resetPractical();
    selected = new Set(intent === 'tonight' ? ['events', 'food', 'culture', 'bikes'] : intent === 'stroll' ? ['parks', 'visits', 'water', 'toilets', 'bikes'] : ['events', 'parks', 'libraries', 'water', 'toilets']);
    $('cityPeriod').value = intent === 'tonight' ? 'tonight' : 'week'; $('cityEventTag').value = intent === 'family' ? 'family' : '';
    $('cityTransport').checked = true; syncTransport(); loadSelected(); remember(); rebuildMarkers(); renderCategories(); render();
    document.querySelectorAll('[data-intent]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
  });
  $('cityAroundGeo').onclick = () => $('btnGeo').click();
  $('cityAroundCenter').onclick = () => calculateAround({ lat: map.getCenter().lat, lon: map.getCenter().lng });
  $('cityWalkMinutes').onchange = () => { drawZones(); rebuildMarkers(); render(); };
  $('cityAroundClear').onclick = () => { isoRequest++; iso = null; isoOrigin = null; zoneLayer.clearLayers(); walkLayer.clearLayers(); $('cityAroundClear').classList.add('hidden'); $('cityAroundStatus').textContent = 'Zone retirée.'; rebuildMarkers(); render(); };
  $('cityInView').onchange = () => { listLimit = 30; remember(); render(); };
  $('cityTransport').onchange = () => { remember(); syncTransport(); };
  $('cityMore').onclick = () => { listLimit += 30; render(); };
  $('cityFit').onclick = fit;
  $('cityTransport').checked = Boolean(saved.transport);
  $('cityInView').checked = saved.inView !== false;
  if (['today', 'tonight', 'week', 'upcoming'].includes(saved.period)) $('cityPeriod').value = saved.period;
  map.on('moveend', () => { if (!active) return; clearTimeout(renderTimer); renderTimer = setTimeout(render, 70); });
  window.addEventListener('keydown', (e) => { if (active && e.key === 'Escape' && selectedPlace) { selectedPlace = null; $('cityDetail').classList.add('hidden'); rebuildMarkers(); render(); } });
  setInterval(() => {
    if (!active || document.hidden) return;
    for (const id of selected) {
      const age = Date.now() - new Date(data.get(id)?.fetched_at || 0).getTime();
      if (id === 'bikes' || age > 20 * 60_000 || data.get(id)?.status !== 'ok') enqueue(id);
    }
    rebuildMarkers(); render(); renderDetail();
  }, 60_000);
  window.cityView = { get active() { return active; }, setActive, fit, refresh, syncTransport,
    around(lat, lon) { myLocation = { lat, lon }; remember(); map.setView([lat, lon], 16); calculateAround(myLocation); },
    showTransportVehicle() { if (active) setActive(false); },
  };
  const view = new URLSearchParams(location.search).get('vue');
  if (view === 'ville' || (!view && !new URLSearchParams(location.search).has('ligne') && readJson('tisseo.map.view', 'transport') === 'city')) setActive(true, { persist: false });
})();
