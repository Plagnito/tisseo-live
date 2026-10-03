// Service worker Tisséo Live — cache du shell applicatif uniquement.
// Les données temps réel (/api/*) ne sont JAMAIS mises en cache ici.
const CACHE = 'tisseo-live-v18';
const GEO = 'tisseo-geo-v1'; // géométrie du réseau : survit à une coupure
const SHELL = [
  './', './index.html', './styles.css?v=20261003-1.6.0', './app.js?v=20261003-1.6.0', './city.css?v=20261003-1.6.0', './city.js?v=20261003-1.6.0', './reseau.js?v=20261003-1.6.0', './walking.js?v=20261003-1.6.0', './compte.css?v=20261003-1.6.0', './compte.js?v=20261003-1.6.0', './art.js?v=20261003-1.6.0', './mobile.css?v=20261003-1.6.0', './mobile.js?v=20261003-1.6.0', './manifest.json', './icon.svg', './lib/city-explore.mjs', './lib/walk-rules.mjs',
  './vendor/leaflet.js', './vendor/leaflet.css', './vendor/leaflet.markercluster.js',
  './vendor/MarkerCluster.css', './vendor/MarkerCluster.Default.css',
  './vendor/images/marker-icon.png', './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png', './vendor/images/layers.png', './vendor/images/layers-2x.png',
];

self.addEventListener('install', (e) => {
  // allSettled : un fichier manquant ne doit pas faire échouer tout le
  // precache (addAll est tout-ou-rien).
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== CACHE && k !== GEO)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Le fond vectoriel du réseau est la SEULE chose qui manque pour que la
  // carte reste utilisable hors ligne : on le met en cache, contrairement au
  // reste de /api/* (positions et horaires, qui doivent rester frais).
  if (url.pathname === '/api/network') {
    e.respondWith(
      caches.open(GEO).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) {
          // Rafraîchissement opportuniste : on sert tout de suite, on met à
          // jour pour la prochaine ouverture.
          fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); }).catch(() => {});
          return hit;
        }
        try {
          const res = await fetch(e.request);
          if (res.ok) c.put(e.request, res.clone());
          return res;
        } catch (err) {
          return new Response(JSON.stringify({ error: 'Réseau indisponible', lines: [] }),
            { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
      })
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) return; // temps réel : réseau seul
  // Connexion Atlas, accord des assistants, connecteur MCP : jamais par le
  // cache. Ces adresses RÉPONDENT PAR UNE REDIRECTION vers un autre site ; la
  // branche « navigation » ci-dessous la prendrait pour un échec et servirait
  // la page d'accueil à la place — on cliquerait « Se connecter » et la carte
  // se rechargerait, sans un mot.
  if (/^\/(auth|oauth|mcp|\.well-known)(\/|$)/.test(url.pathname)) return;
  // Une nouvelle visite doit recevoir le dernier HTML, tout en conservant
  // la dernière page utilisable si la connexion est coupée.
  if (e.request.mode === 'navigate' && url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(e.request);
        if (response.ok) {
          await cache.put(e.request, response.clone());
          return response;
        }
        // Une redirection n'est pas une panne : on la laisse passer telle
        // quelle. La remplacer par la page d'accueil en cache, c'est afficher
        // la carte (sans styles) à l'adresse d'une page qui renvoyait ailleurs.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return response;
        return await cache.match(e.request) || await cache.match('./index.html') || response;
      } catch {
        return await cache.match(e.request) || await cache.match('./index.html')
          || new Response('Connexion indisponible. Rouvre cette page une fois connecté.',
            { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }
  e.respondWith(
    caches.match(e.request).then(
      (hit) => hit || fetch(e.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit)
    )
  );
});
