// Service worker Tisséo Live — cache du shell applicatif uniquement.
// Les données temps réel (/api/*) ne sont JAMAIS mises en cache ici.
const CACHE = 'tisseo-live-v4';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.json', './icon.svg',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // temps réel : réseau seul
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
