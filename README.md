# Tisséo Live — véhicules en direct à Toulouse

Carte web qui affiche la **position estimée en temps réel** de tous les véhicules
en circulation sur le réseau Tisséo (bus, tram, Téléo).

## Honnêteté sur les données

Tisséo **ne publie pas les positions GPS** de ses véhicules en open data.
Le flux officiel GTFS-RT ([`GtfsRt.json`](https://api.tisseo.fr/opendata/gtfsrt/GtfsRt.json))
ne contient que des `TripUpdate` (horaires temps réel par arrêt) et des `Alert`.
Chaque position affichée est donc **interpolée** entre les deux arrêts qui encadrent
l'heure actuelle, grâce aux coordonnées du GTFS statique. C'est une estimation
(typiquement à un pâté de maisons près pour les bus), pas un point GPS.

Autres limites connues :
- **Métro A/B absent** : le flux temps réel ne couvre que bus + tram + Téléo.
- Pas de calcul de retard théorique : les `trip_id` du temps réel ne correspondent
  pas à ceux du GTFS statique, donc pas de jointure horaire fiable.

## Lancer l'appli

```powershell
cd D:\Claude\SideApps\Tisseo
npm install
npm start
# → http://localhost:3127
```

## API du mini-backend

| Route | Description |
|---|---|
| `GET /api/vehicles` | Véhicules actifs estimés (`?route_id=…`, `?mode=bus,tram,teleo`) |
| `GET /api/routes` | Les 124 lignes + nombre de véhicules actifs |
| `GET /api/alerts` | Perturbations / infos réseau du flux |
| `GET /api/route-detail?route_id=…` | Tracés + arrêts d'une ligne, par sens |
| `GET /api/network` | Tracés de **toutes** les lignes, simplifiés (`?tol=6&cell=5` en mètres) |
| `GET /api/tiles` | Fonds de carte **vérifiés** par le serveur (`?force=1` pour re-tester) |
| `GET /api/departures?stop_id=…` | Prochains passages à un arrêt (temps réel) |
| `GET /api/nearby?lat=…&lon=…&n=…` | Arrêts les plus proches + leurs passages |
| `GET /api/journey?from=…&to=…` | Itinéraire A→B (nom d'arrêt, id ou `lat,lon`) |
| `GET /api/status` | Santé : âge du flux, compteurs, véhicules recalés, erreurs amont |

## La carte, et ce qui se passe quand elle n'y est plus

Le fond de carte n'est jamais posé à l'aveugle. Le serveur **sonde** chaque
fournisseur (`lib/tiles.mjs`) et ne publie dans `/api/tiles` que ceux qui
servent une vraie tuile : HTTP 200, `image/*`, **256×256**, taille plausible,
et empreinte absente de la liste des placeholders connus.

Cette vérification n'est pas paranoia : CARTO répond aujourd'hui `200 OK` avec
une image de 2 Ko « API KEY REQUIRED » à la place de la carte. Le navigateur la
charge sans signaler d'erreur, donc un simple `tileerror` ne voit rien et
l'app affiche un fond « carte » qui n'en est pas une. CARTO est donc écarté.

Côté client, la chaîne de secours est :

```
Esri gris foncé → OSM → CyclOSM → Esri rues → OpenTopoMap → tracés du réseau
```

Le mode sombre bascule sur un mode clair réel avant d'abandonner, et en dernier
recours l'app passe en **mode tracés** : plus aucune tuile, mais le réseau
Tisséo entier dessiné à ses couleurs (`/api/network`, simplification
Douglas-Peucker) sur une trame de fond. Le bouton 🗺 force ce mode à la main,
et le re-teste quand on revient au fond de carte.

Leaflet est servi depuis `public/vendor/` : plus aucune dépendance CDN pour
faire tourner la carte.

## Fonctionnalités

- **Tracés réels** : la ligne sélectionnée affiche son parcours + ses arrêts ;
  les véhicules sont recalés dessus quand leur sens est identifiable (`snapped`).
- **Arrêts cliquables** : prochains passages en temps réel (« dans N min »).
- **📍 Autour de moi** : géolocalisation + arrêts proches et leurs passages.
- **Favoris** (☆, persistés), **lien partageable** (`?ligne=L1`), **PWA** installable.
- **Fluidité** : pastilles animées entre actualisations, regroupement (clusters)
  quand on dézoome, légende.
- **Carte résiliente** : Leaflet local, fonds vérifiés, repli en mode tracés.

Le backend met en cache le flux amont 10 s (avec `ETag`) pour respecter la limite
de charge, et ressert les dernières données connues en cas de coupure (flag `stale`).

## Tests

```powershell
npm test        # 20 tests unitaires (node:test) : géométrie, recherche,
                # simplification du réseau, contrôle des tuiles
npm start       # dans un terminal…
npm run test:e2e   # …puis vérifie dans un vrai navigateur que la carte
                # s'affiche, et que le mode tracés prend le relais sans tuiles
```

`npm run test:e2e` a besoin de Playwright (installé à part, `npm i -D playwright`).

## Régénérer les données statiques

`data/routes.json` + `data/stops.json` sont extraits du GTFS Tisséo :

```powershell
npm run prepare-gtfs
```

## Sources

- GTFS-RT : https://api.tisseo.fr/opendata/gtfsrt/
- GTFS statique : https://data.toulouse-metropole.fr/explore/dataset/tisseo-gtfs/
- Licence : ODbL (Tisséo / Toulouse Métropole)
- Fond de carte : © OpenStreetMap contributors · © Esri · CyclOSM · OpenTopoMap
