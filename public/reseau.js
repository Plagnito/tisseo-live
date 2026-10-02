/* Transports en direct des autres villes, dans le mode Ville.
 *
 * Toulouse a son propre moteur (app.js). Ici, n'importe quelle ville française
 * dont le réseau publie du temps réel au point d'accès national : le serveur
 * dit quel réseau couvre la ville, puis sert ses véhicules — positions GPS
 * publiées, ou estimées d'après les horaires temps réel quand le réseau ne
 * publie que ceux-là. La carte dit toujours laquelle des deux.
 */
(() => {
  'use strict';
  const h = escapeHtml;
  const STOPS_ZOOM = 16;        // les arrêts n'apparaissent que de près
  const DESSUS = 2000;          // rang d'affichage des véhicules
  // Rythme de relecture. Le serveur ne relit pas un flux plus d'une fois toutes
  // les vingt secondes ; les tests raccourcissent l'attente.
  const PERIODE = Number(window.__reseauPeriode) || 15_000;
  const lire = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage désactivé */ } };

  let profile = null, active = false, networks = [], current = null, ticket = 0, cherche = null;
  let timer = null, busy = false, last = null, stopsTimer = null, stopsKey = '';
  let selected = null; // { id } du véhicule dont la fiche est ouverte
  const vehLayer = L.layerGroup(), shapeLayer = L.layerGroup(), stopLayer = L.layerGroup();
  const markers = new Map();
  // Sur téléphone, la fiche se tient à l'écart des boutons de la carte (à droite).
  const etroit = window.matchMedia('(max-width: 820px)').matches;
  const popup = L.popup({ className: 'rv-popup', maxWidth: etroit ? Math.min(290, window.innerWidth - 118) : 290, autoPanPaddingTopLeft: [14, etroit ? 76 : 70], autoPanPaddingBottomRight: [etroit ? 78 : 24, 24] });

  const box = $('reseauBox'), check = $('reseauLive'), label = $('reseauLabel'), etat = $('reseauEtat'), choix = $('reseauChoix');
  if (!box) return;
  check.checked = lire('tisseo.reseau.on', true);

  const heure = (t) => new Date(t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: profile?.timezone || undefined });
  const dans = (t, now) => { const m = Math.round((t - now) / 60); return m <= 0 ? 'à l’instant' : m < 60 ? `dans ${m} min` : heure(t); };
  const pastille = (v) => `<b class="rv-line" style="background:${h(v.color || '#5b6b82')};color:${h(v.text || '#fff')}">${h(v.line)}</b>`;

  function icon(v, on) {
    const fleche = v.bearing === null || v.bearing === undefined ? '' : `<i class="rv-dir" style="transform:rotate(${Number(v.bearing)}deg) translateY(-16px)"></i>`;
    const w = Math.max(24, 12 + String(v.line).length * 7);
    return L.divIcon({
      className: 'rv-marker',
      html: `<div class="rv${v.estimated ? ' est' : ''}${on ? ' on' : ''}" style="--c:${h(v.color || '#5b6b82')};--t:${h(v.text || '#fff')}">${fleche}<b>${h(v.line)}</b></div>`,
      iconSize: [w, 24], iconAnchor: [w / 2, 12],
    });
  }

  function show() {
    const visible = active && check.checked && current;
    for (const l of [shapeLayer, stopLayer, vehLayer]) {
      if (visible && !map.hasLayer(l)) map.addLayer(l);
      if (!visible && map.hasLayer(l)) map.removeLayer(l);
    }
    if (!visible) { clearTimeout(timer); timer = null; map.closePopup(popup); return; }
    if (!timer && !busy) poll();
    loadStops();
  }

  function note(text, lien) {
    etat.innerHTML = h(text) + (lien && current?.page ? ` <a href="${h(current.page)}" target="_blank" rel="noopener">Source</a>` : '');
  }

  function draw(data) {
    last = data;
    const seen = new Set();
    for (const v of data.vehicles) {
      seen.add(v.id);
      const on = selected?.id === v.id;
      let m = markers.get(v.id);
      const cle = `${v.line}|${v.color}|${v.bearing}|${v.estimated}|${on}`;
      if (!m) {
        // Au-dessus des lieux de la ville : un véhicule bouge, un lieu attend.
        m = L.marker([v.lat, v.lon], { icon: icon(v, on), keyboard: false, zIndexOffset: on ? DESSUS + 500 : DESSUS });
        m.on('click', () => openVehicle(m.rv));
        m.addTo(vehLayer); markers.set(v.id, m);
      } else {
        m.setLatLng([v.lat, v.lon]);
        if (m.rvKey !== cle) m.setIcon(icon(v, on));
      }
      m.rv = v; m.rvKey = cle;
    }
    for (const [id, m] of markers) if (!seen.has(id)) { vehLayer.removeLayer(m); markers.delete(id); }
    const n = data.vehicles.length;
    if (data.error && !n) note(data.error, false);
    else if (!n) note(data.network.static === 'preparation' ? 'Préparation des lignes de ce réseau…' : 'Aucun véhicule en circulation annoncé pour l’instant.', true);
    else note(`${n} véhicule${n > 1 ? 's' : ''} · ${data.nature === 'gps' ? 'positions GPS publiées par le réseau' : 'positions estimées d’après les horaires temps réel'}${data.network.static === 'preparation' ? ' · lignes en préparation' : ''}.`, true);
  }

  async function poll() {
    clearTimeout(timer); timer = null;
    if (!active || !check.checked || !current) return;
    const mine = ticket, id = current.id;
    if (document.hidden) { timer = setTimeout(poll, 5000); return; }
    busy = true;
    try {
      const r = await fetch(`/api/net/${encodeURIComponent(id)}/vehicles`, { signal: AbortSignal.timeout(20_000) });
      const j = await r.json();
      if (mine !== ticket) return;
      if (!r.ok) throw new Error(j.error || 'Réseau indisponible');
      draw(j);
      if (selected && popup.isOpen()) refreshVehicle();
    } catch (e) {
      if (mine === ticket) note(String(e.message || 'Le temps réel de ce réseau ne répond pas.').slice(0, 140), false);
    } finally {
      busy = false;
      if (mine === ticket && active && check.checked) timer = setTimeout(poll, last?.network?.static === 'preparation' ? Math.min(5000, PERIODE) : PERIODE);
    }
  }

  // --- fiche d'un véhicule ---------------------------------------------------------
  function vehicleHtml(v, d) {
    const now = d?.at || Math.floor(Date.now() / 1000);
    const nature = v.estimated ? 'Position estimée d’après les horaires temps réel' : `Position GPS${v.age_s !== null && v.age_s !== undefined ? ` · il y a ${v.age_s < 90 ? `${v.age_s} s` : `${Math.round(v.age_s / 60)} min`}` : ''}`;
    const etatV = [v.status, v.stop ? (v.status === 'à l\'arrêt' ? v.stop : `prochain arrêt : ${v.stop}`) : null, v.speed_kmh ? `${v.speed_kmh} km/h` : null].filter(Boolean).join(' · ');
    const stops = d?.stops?.length
      ? `<ol class="rv-stops">${d.stops.slice(0, 7).map((s) => `<li><span>${h(s.name)}</span><time>${h(heure(s.time))}</time></li>`).join('')}</ol>${d.stops.length > 7 ? `<p class="rv-more">… ${d.stops.length - 7} arrêts de plus, jusqu’à ${h(d.stops[d.stops.length - 1].name)}</p>` : ''}`
      : d ? '<p class="rv-more">Arrêts à venir non publiés pour cette course.</p>' : '<p class="rv-more">Chargement des arrêts…</p>';
    return `<div class="rv-card"><div class="rv-head">${pastille(v)}<div><strong>${h(v.headsign || v.long || 'Destination non publiée')}</strong><small>${h(v.mode || '')}${current ? ` · ${h(current.name)}` : ''}</small></div></div>`
      + (etatV ? `<p class="rv-state">${h(etatV)}</p>` : '') + stops + `<p class="rv-src">${h(nature)}</p></div>`;
  }
  async function refreshVehicle() {
    const sel = selected, id = current?.id;
    if (!sel || !id) return;
    try {
      const r = await fetch(`/api/net/${encodeURIComponent(id)}/vehicle?vid=${encodeURIComponent(sel.id)}`, { signal: AbortSignal.timeout(15_000) });
      const d = await r.json();
      if (selected !== sel || !d.vehicle) return;
      popup.setContent(vehicleHtml(d.vehicle, d));
      if (!sel.traced) {
        sel.traced = true;
        shapeLayer.clearLayers();
        for (const line of d.shapes || []) L.polyline(line, { color: d.vehicle.color || '#5b6b82', weight: 5, opacity: 0.75, interactive: false, className: 'rv-shape' }).addTo(shapeLayer);
      }
    } catch { /* la fiche garde ce qu'elle affichait */ }
  }
  function openVehicle(v) {
    const before = selected?.id;
    selected = { id: v.id, traced: false };
    for (const id of [before, v.id]) { const m = markers.get(id); if (m) { m.setIcon(icon(m.rv, id === v.id)); m.setZIndexOffset(id === v.id ? DESSUS + 500 : DESSUS); m.rvKey = ''; } }
    shapeLayer.clearLayers();
    popup.setLatLng([v.lat, v.lon]).setContent(vehicleHtml(v, null)).openOn(map);
    refreshVehicle();
  }
  map.on('popupclose', (e) => {
    if (e.popup !== popup || !selected) return;
    const m = markers.get(selected.id);
    selected = null; shapeLayer.clearLayers();
    if (m) { m.setIcon(icon(m.rv, false)); m.setZIndexOffset(DESSUS); m.rvKey = ''; }
  });

  // --- arrêts (de près seulement) ---------------------------------------------------
  function loadStops() {
    clearTimeout(stopsTimer);
    stopsTimer = setTimeout(async () => {
      if (!active || !check.checked || !current) return;
      if (map.getZoom() < STOPS_ZOOM) { stopLayer.clearLayers(); stopsKey = ''; return; }
      const b = map.getBounds().pad(0.15), mine = ticket, id = current.id;
      const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => x.toFixed(4)).join(',');
      if (bbox === stopsKey) return;
      try {
        const j = await (await fetch(`/api/net/${encodeURIComponent(id)}/stops?bbox=${bbox}`, { signal: AbortSignal.timeout(15_000) })).json();
        if (mine !== ticket) return;
        stopsKey = bbox; stopLayer.clearLayers();
        for (const s of j.stops || []) {
          L.circleMarker([s.lat, s.lon], { radius: 5, weight: 2, color: '#fff', fillColor: '#33415c', fillOpacity: 1, className: 'rv-stop', bubblingMouseEvents: false })
            .on('click', () => openStop(s)).addTo(stopLayer);
        }
      } catch { /* les arrêts reviendront au prochain déplacement */ }
    }, 350);
  }
  async function openStop(s) {
    selected = null; shapeLayer.clearLayers();
    const id = current?.id, mine = ticket;
    popup.setLatLng([s.lat, s.lon]).setContent(`<div class="rv-card"><div class="rv-head"><div><strong>${h(s.name)}</strong><small>Arrêt · ${h(current?.name || '')}</small></div></div><p class="rv-more">Chargement des passages…</p></div>`).openOn(map);
    try {
      const d = await (await fetch(`/api/net/${encodeURIComponent(id)}/stop?stop_id=${encodeURIComponent(s.id)}`, { signal: AbortSignal.timeout(15_000) })).json();
      if (mine !== ticket || !popup.isOpen()) return;
      const liste = d.departures?.length
        ? `<ol class="rv-deps">${d.departures.slice(0, 8).map((x) => `<li>${pastille(x)}<span>${h(x.headsign || '')}</span><time>${h(dans(x.time, d.at))}</time></li>`).join('')}</ol>`
        : `<p class="rv-more">${d.realtime ? 'Aucun passage annoncé dans les deux heures.' : 'Ce réseau ne publie pas ses passages en temps réel.'}</p>`;
      popup.setContent(`<div class="rv-card"><div class="rv-head"><div><strong>${h(d.stop?.name || s.name)}</strong><small>Arrêt · ${h(current?.name || '')}</small></div></div>${liste}<p class="rv-src">Passages en temps réel publiés par le réseau</p></div>`);
    } catch { popup.setContent(`<div class="rv-card"><strong>${h(s.name)}</strong><p class="rv-more">Passages indisponibles pour l’instant.</p></div>`); }
  }
  map.on('moveend', () => { if (active && check.checked && current) loadStops(); });

  // --- ville → réseau ----------------------------------------------------------------
  function reset() {
    ticket++; clearTimeout(timer); timer = null; clearTimeout(stopsTimer);
    last = null; selected = null; stopsKey = ''; current = null; networks = [];
    for (const l of [vehLayer, shapeLayer, stopLayer]) l.clearLayers();
    markers.clear(); map.closePopup(popup);
  }
  function choose(n) {
    const keep = networks; reset(); networks = keep; current = n;
    label.textContent = `Transports en direct · ${n.name}`;
    note(check.checked ? 'Lecture du temps réel…' : (n.nature === 'gps' ? 'Ce réseau publie la position de ses véhicules.' : 'Ce réseau publie ses horaires temps réel : positions estimées.'), true);
    show();
  }
  async function sync(p, isActive) {
    active = Boolean(isActive);
    profile = p;
    // Une ville encore « en attente » (lien direct, nom pas encore connu) ne
    // compte pas : on cherchera son réseau quand le catalogue aura répondu.
    const cle = p && !p.pending ? p.id : null;
    if (cle === cherche) { show(); return; }
    cherche = cle;
    reset();
    box.classList.add('hidden'); choix.classList.add('hidden');
    if (!p || p.transport === 'tisseo' || !/^fr:/.test(p.id) || p.pending) return;
    const mine = ticket;
    try {
      const j = await (await fetch('/api/net/for?city=' + encodeURIComponent(p.id), { signal: AbortSignal.timeout(20_000) })).json();
      if (mine !== ticket || !j.networks?.length) return;
      networks = j.networks;
      choix.innerHTML = networks.map((n, i) => `<option value="${i}">${h(n.name)}</option>`).join('');
      choix.classList.toggle('hidden', networks.length < 2);
      box.classList.remove('hidden');
      choose(networks[0]);
    } catch { /* pas de réseau connu : la ville garde ses lieux */ }
  }
  check.addEventListener('change', () => { ecrire('tisseo.reseau.on', check.checked); if (check.checked) note('Lecture du temps réel…', true); else if (current) note(current.nature === 'gps' ? 'Ce réseau publie la position de ses véhicules.' : 'Ce réseau publie ses horaires temps réel : positions estimées.', true); show(); });
  choix.addEventListener('change', () => { const n = networks[Number(choix.value)]; if (n) choose(n); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active && check.checked && current && !timer && !busy) poll(); });

  window.Reseau = { sync, state: () => ({ network: current, vehicles: markers.size, nature: last?.nature ?? null, active }) };
})();
