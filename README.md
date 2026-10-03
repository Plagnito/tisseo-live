# Tisséo Live — véhicules en direct à Toulouse

## Mode Ville — Toulouse et ses alentours

Le bouton **Ville**, à côté de **Transports**, ouvre une seconde lecture de
la carte. Accès direct : `http://localhost:4127/?vue=ville`.

- **Bouger** : stations VélÔToulouse avec le dernier relevé de disponibilité,
  parkings et superposition facultative des véhicules Tisséo.
- **Sortir** : événements en cours ou à venir, culture, patrimoine,
  restaurants et cafés, parcs, marchés et équipements sportifs.
- **Quotidien** : bibliothèques, mairies, fontaines à boire, toilettes
  référencées dans OpenStreetMap et chantiers de voirie en cours ou à venir.

Les catégories se combinent. La recherche porte sur les catégories actives ;
« Dans la vue » limite la liste à la zone visible. Une fiche donne les
informations publiées, leur source et un bouton **Y aller en transports**
qui prépare la destination dans le calculateur existant. Les préférences
restent dans le navigateur ; `?vue=ville` permet de partager ce mode.

Sources : [Toulouse Métropole Open Data](https://data.toulouse-metropole.fr/),
[Cyclocity GBFS](https://api.cyclocity.fr/contracts/toulouse/gbfs/station_information.json),
[restauration OSM / Huwise](https://public.opendatasoft.com/explore/dataset/osm-france-food-service/),
[patrimoine OSM / Huwise](https://public.opendatasoft.com/explore/dataset/osm-france-historic/)
et Overpass pour les toilettes. Les exports OSM couvrent Toulouse ; les
autres jeux peuvent couvrir la Métropole. Les licences sont indiquées dans
les fiches et dans le panneau des sources.

**Couverture** : aucun annuaire n'est exhaustif. L'agenda fusionne désormais
les événements publics OpenAgenda de Toulouse et l'agenda touristique de la
Métropole. Les doublons sont fusionnés ; les créneaux réels servent aux
filtres aujourd'hui, ce soir et sept jours. Les annulations et événements
terminés sont écartés. Un lien vers [l'agenda municipal](https://metropole.toulouse.fr/agenda)
reste proposé. Les tarifs, horaires et capacités publiés
ne sont pas assimilés à des disponibilités en direct. Les vélos indiquent
l'âge du relevé ; les valeurs absentes restent inconnues.

Le serveur partage et met en cache les lectures : une minute pour les
statuts vélos, vingt minutes pour l'agenda et les chantiers, six heures pour
les annuaires. Une source en panne conserve son dernier résultat en mémoire
avec un avertissement ; sans résultat antérieur, la catégorie est signalée
indisponible. Les lectures de sources sont dédupliquées et les reprises
espacées d'au moins une minute. Aucune clé ni nouvelle dépendance nécessaire.

API : `GET /api/city/catalog` et `GET /api/city/places?category=parks`.
Vérification des normalisations, du cache et des pannes :
`node --test test/city.test.mjs` (également inclus dans `npm test`).

### Explorer au quotidien

- Résumé **Aujourd'hui à Toulouse** : météo Open-Meteo, sorties de la journée,
  chantiers en cours et informations du flux Tisséo.
- Favoris locaux et envies **Ce soir**, **Une balade**, **Avec les enfants**.
- Agenda : gratuit, famille, concerts, expositions. Les critères sont issus
  des descriptions, conditions et âges publiés, sans inventer de programme.
- Filtres pratiques : horaires connus, accès libre / gratuit, PMR déclaré et
  option végétarienne déclarée. Une valeur inconnue ne satisfait pas un filtre.
  L'évaluation des horaires reconnaît uniquement le sous-ensemble hebdomadaire
  explicite OSM et `24/7` ; jours fériés et syntaxes complexes restent inconnus.
- Clusters avec couleurs des catégories présentes et indication du mélange.
- Zones de **5 / 10 / 15 minutes à pied** et parcours avec instructions,
  calculés par Valhalla sur le réseau OSM. La distance à vol d'oiseau reste
  explicitement distincte. La position n'est demandée qu'après un clic.

API supplémentaires : `/api/city/weather`, `/api/city/isochrone?lat=…&lon=…`,
`/api/city/walk?from_lat=…&from_lon=…&to_lat=…&to_lon=…`.
Les lectures météo sont partagées quinze minutes ; les calculs piétons cinq
minutes, avec un cache borné et une temporisation des échecs. Le moteur se
configure avec `CITY_ROUTING_URL` ; le serveur de démonstration FOSSGIS est
utilisé par défaut pour ce prototype, conformément à son usage modéré.
En cas de panne, aucun tracé ou temps de marche n'est fabriqué.

### Application Android native

Le projet autonome [android/](android/README.md) utilise les vues Android et
**MapLibre Native 13.6.1 (OpenGL)**. Il ne contient ni PWA ni WebView. Les deux
modes, les catégories, l'agenda, les filtres, les favoris, les zones à pied,
les fiches de lieux, les véhicules, les arrêts et le calculateur Tisséo sont
des écrans natifs. Les positions Tisséo restent des estimations horaires.

Le serveur HTTPS public `https://tisseo.plagnito.com` est sélectionné par défaut.
Le tunnel USB `adb reverse tcp:4127 tcp:4127` reste une option de développement.
Les fiches se partagent avec les applications Android ; un événement peut
préparer une entrée de calendrier après choix de son créneau publié.
Les favoris et les
derniers annuaires consultés sont conservés sur le téléphone, avec indication
explicite d'ancienneté hors connexion ; les disponibilités vélo ne sont alors
pas présentées comme actuelles.

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
# → http://localhost:4127
```

Le port par défaut est **4127**, pas 3127 : sur cette machine, 3103-3202 est une
plage d'exclusion Windows (réservée par Hyper-V/WSL). Un port dans cette plage
ne donne pas « déjà utilisé » mais `EACCES` — refus du système alors que
personne n'écoute, ce qui est très difficile à diagnostiquer. Pour choisir un
port libre : `netsh interface ipv4 show excludedportrange protocol=tcp`.

## API du mini-backend

| Route | Description |
|---|---|
| `GET /api/vehicles` | Véhicules actifs estimés (`?route_id=…`, `?mode=bus,tram,teleo`) |
| `GET /api/routes` | Les 124 lignes + nombre de véhicules actifs |
| `GET /api/alerts` | Perturbations / infos réseau du flux |
| `GET /api/route-detail?route_id=…` | Tracés + arrêts d'une ligne, par sens |
| `GET /api/network` | Tracés de **toutes** les lignes, simplifiés (`?tol=6&cell=5` en mètres) |
| `GET /api/stream` | **Flux temps réel (SSE)** : un événement à chaque changement du flux amont |
| `GET /api/tiles` | Fonds de carte **vérifiés** par le serveur (`?force=1` pour re-tester) |
| `GET /api/departures?stop_id=…` | Prochains passages à un arrêt (temps réel) |
| `GET /api/nearby?lat=…&lon=…&n=…` | Arrêts les plus proches + leurs passages |
| `GET /api/journey?from=…&to=…` | Itinéraire A→B (nom d'arrêt, adresse, lieu, id ou `lat,lon`) ; `from_stop` / `from_lat`+`from_lon`+`from_label` pour un lieu déjà choisi ; `at=<epoch>` ; chaque étape porte son tracé (`path`), sa distance et ses arrêts — `trace=0` pour s'en passer |
| `GET /api/places/suggest?q=…` | Suggestions au fil de la frappe : arrêts (avec leurs lignes), adresses et lieux à portée d'un arrêt |
| `GET /api/status` | Santé : âge du flux, compteurs, véhicules recalés, erreurs amont |
| `GET /api/auth/connexion` | Connexion par le compte Atlas (SSO, PKCE) ; `?app=android` revient dans l'application. Sous `/api/` comme le retour et l'accord des assistants : aucun service worker, même ancien, n'intercepte ce préfixe |
| `/api/compte/…` | Trajets enregistrés, trajets planifiés, amis, partages, assistants autorisés — voir « Compte Atlas » |
| `/api/oauth/…`, `/oauth/…`, `/.well-known/oauth-…` | Serveur d'autorisation des assistants (connecteur MCP avec compte) |

## Ce que fait la carte

- **Positions le long du tracé.** Un véhicule n'est pas posé sur une corde
  entre deux arrêts puis rapproché au plus près de la ligne : on parcourt la
  polyligne du GTFS entre l'abscisse de l'arrêt de départ et celle de l'arrêt
  d'arrivée. `on_route` distingue « sur la route » de « rapproché ».
   Contrôle qualité : c'est un test de la suite (`test/traces.test.mjs`) —
   chaque arrêt doit être à moins de 100 m du tracé de sa ligne. Sur les 5 699
   arrêts et 243 variantes, le pire écart est de 32 m. Pour le détail :
   `node --test test/traces.test.mjs`.

- **Métro A/B et Téléo.** Absents du GTFS-RT de Tisséo (ou plus aux heures
  creuses), leurs courses sont reconstruites depuis les horaires du GTFS
  statique et animées sur le tracé. Marqués **théoriques** partout : contour
  pointillé, badge dans la fiche, mention dans l'info-bulle. La liste des
  modes est explicite (`TISSEO_THEO_MODES`), jamais déduite d'une absence
  ponctuelle — sinon des rames fantômes apparaissent dès que le réseau est
  calme. `TISSEO_NOW=<epoch>` fige l'horloge (tests, rejeu).
- **Mouvement.** La vitesse de chaque véhicule est mesurée entre deux points
  observés, lissée, et la pastille avance en continu à cette vitesse
  (routage à l'estime) : une nouvelle donnée corrige la trajectoire au lieu
  de relancer l'animation.
- **Fond de carte qui suit le zoom.** La sonde vérifie la **limite de zoom
  native** de chaque fournisseur (une tuile identique à celle du niveau
  précédent = placeholder) ; le client passe en `maxNativeZoom` et bascule sur
  un fournisseur qui a des données au niveau demandé. Sans cela, le fond gris
  foncé d'Esri affichait « map data not available » dès le z17.
- **Push, pas sondage.** `/api/stream` (SSE) prévient à chaque changement du
  flux amont ; le polling 15 s ne reste qu'en filet si la connexion tombe.
- **Infos trafic sur la carte.** Les lignes citées par une perturbation
  reçoivent un contour d'alerte ; survoler une info met ses véhicules en
  évidence.
- **Notifications.** Une cloche sur un arrêt favori prévient 2 minutes avant
  chaque passage.
- **Inventaire.** Les compteurs « véhicules » et « lignes » ouvrent la liste
  de ce qui roule, avec la position de chaque véhicule. Un clic sur une ligne
  la filtre, la trace, et ouvre ses véhicules.
 - **Le trajet entier, d'une adresse à une autre.** Les deux champs du
   planificateur proposent arrêts, adresses et lieux pendant la frappe ; le lieu
   choisi part avec ses coordonnées, pas avec son libellé. Le routeur n'entre plus
   dans le réseau par *le* plus proche arrêt mais par tous ceux à portée de marche
   (700 m, 14 au plus), de chaque côté — c'est lui qui choisit —, et sait répondre
   « à pied » quand c'est plus court. Le résultat est dessiné **en entier** dès le
   calcul : marches sur le vrai chemin piéton, lignes à leur couleur sur le tracé
   emprunté, les deux bouts marqués A et B, carte cadrée sur l'ensemble. Cliquer
   une étape s'en rapproche sans effacer le reste ; « Voir tout le trajet » recadre.
   Contrôle : `npm run test:e2e:trajet-complet`.
 - **Perturbations appliquées, pas seulement affichées.** Le flux ne structure
   une alerte que par ligne ; les arrêts non desservis, le sens et les dates sont
   dans son texte. `lib/perturbations.mjs` les en extrait : un arrêt fermé n'annonce
   plus de passage (la fiche dit quelle ligne ne s'y arrête pas, et pourquoi), et
   l'itinéraire ne monte, ne descend ni ne traverse là où la ligne est coupée — à
   l'heure du trajet, pas à l'heure de la demande.
 - **Itinéraire A→B.** Dijkstra sur ~20 k états côté serveur (marche,
   correspondances, horaires temps réels appliqués segment par segment), tracé
   sur la carte dans le sens emprunté. Deux subtilités du réseau de Tisséo,
   traitées explicitement :
   - **Une station n'a pas un seul `stop_point`.** Les deux sens d'une ligne de
     métro n'emploient pas le même identifiant pour la même station, et la
     recherche ne relie que les arrêts d'une même variante. Le nom saisi est
     donc groupé en *emplacements* (tous les quais à moins de 120 m) et le
     routeur reçoit la station entière, pas un quai tiré au sort. Dix-neuf
     arrêts s'appellent « Jean Jaurès », répartis sur trois stations.
   - **L'attente dépend du mode.** Un métro toutes les 4 min ne s'attend pas
     comme un bus toutes les 30 min. Avec une attente uniforme de 240 s, toute
     correspondance devenait plus chère qu'une marche de 300 m, et le
     planificateur proposait de marcher entre deux stations de métro à 271 m.
     Attente par défaut et plafond sont maintenant fixés par mode (métro 120 s
     / 300 s max, tramway 180 s / 480 s, bus 240 s / 900 s).

   Quand un nom masque plusieurs stations, la réponse indique dans `ambigu`
   quels emplacements ont été écartés : on ne renvoie pas « Jean Jaurès » sans
   dire lequel.

   **Le réseau n'est pas d'un seul tenant.** Les horaires publiés se décomposent
   en 12 composantes : la principale (3 629 arrêts) et 11 îlots représentant
   156 arrêts — 4 % du réseau, à Lacassagne, Lévignac, Mérenvielle… Aucune
   ligne ne les relie au reste, donc aucun trajet n'existe depuis ou vers ces
   là. L'interface le dit au lieu d'afficher une panne. Un test
   (`test/itineraires.test.mjs`) suit ce découpage : un rafraîchissement des
   données qui aggrave le morcellement se voit immédiatement.

   **La nuit, rien ne circule.** Le routeur préfère alors proposer un trajet
   théorique sur le réseau entier plutôt que de ne rien proposer — mais il
   nomme les lignes hors service (`out_of_service`), et l'interface affiche
   « hors service maintenant : A ». Sans cela, on proposerait le métro à
   3 h du matin comme si c'était normal.

   **Adresses et lieux.** Le champ affiche « une adresse… » : il sait le
   faire. Un nom qui ne correspond à aucun arrêt part au géocodeur de l'IGN
   Géoplateforme (sans clé), et le lieu retenu est le mieux noté parmi ceux
   qui sont à moins de 800 m d'un arrêt desservi. Les deux index du géocodeur
   sont interrogé séparément : demandés ensemble, l'IGN renvoie seulement des
   lieux et l'adresse exacte disparaît (« 15 rue de Metz » sort à 0,98 en
   index `address`, mais à 0 résultat en `address,poi`). Un nom d'arrêt cité
   dans une phrase n'est reconnu que s'il apparaît **en entier** : sinon
   « 1 place Wilson Toulouse » répondait par l'arrêt « Lac », contenu dans
   « Toulouse », et le géocodeur n'était jamais appelé.

   **« Vous êtes déjà sur place ».** Quand le départ et l'arrivée partagent un
   arrêt, c'est la réponse, pas une erreur : la marche l'emporte
   naturellement, puisqu'elle est plus courte que n'importe quel détour.


## Transports en direct des autres villes

Dans le mode Ville, une ville française dont le réseau publie du temps réel montre ses
véhicules sur la carte : Bordeaux, Rennes, Montpellier, Nice, Rouen, Toulon, Dijon, Brest,
Angers, Tours, Le Havre, Metz, Le Mans, Lille, Saint-Étienne, Clermont-Ferrand, Orléans,
Nancy… Aucune liste n'est écrite dans le code : elle vient du **point d'accès national**
([transport.data.gouv.fr](https://transport.data.gouv.fr)), relu deux fois par jour.

- **Quelle ville, quel réseau.** Chaque fiche du catalogue dit quelles communes et
  intercommunalités elle couvre ; la ville choisie y est cherchée par son code INSEE et
  celui de son intercommunalité. Le réseau urbain passe avant une navette, celui qui publie
  des positions avant celui qui ne publie que des horaires (`lib/reseaux/catalogue.mjs`).
- **Deux natures de position, dites telles quelles.** « GPS » : le réseau publie la position
  de ses véhicules (`VehiclePositions`). « Estimée » : il ne publie que ses horaires temps
  réel (`TripUpdates`) ; le véhicule est alors placé entre l'arrêt qu'il vient de quitter et
  le suivant, le long du tracé quand le GTFS en a un — comme la carte de Toulouse. Sur la
  carte, une position estimée a un contour en tirets ; la fiche le dit en toutes lettres.
- **Le GTFS statique sans `stop_times.txt`.** Lignes, couleurs, destinations, arrêts et un
  tracé par sens suffisent ; les passages viennent du temps réel. Le fichier des horaires,
  qui pèse des centaines de mégaoctets sur une métropole, n'est jamais lu. La préparation
  tourne dans un processus à part (`scripts/prepare-reseau.mjs`, deux à trois secondes), une
  à la fois ; le résultat (`data-net/<réseau>/net.json`, hors dépôt) est refait chaque
  semaine. En attendant, les véhicules s'affichent déjà, avec l'identifiant brut de leur ligne.
- **Flux lus à la demande.** Rien n'est interrogé tant que personne ne regarde la ville ; un
  flux n'est pas relu plus d'une fois toutes les vingt secondes, et un relais qui répond
  « trop de requêtes » est laissé tranquille une minute. Le décodeur protobuf est écrit à la
  main (`lib/reseaux/gtfsrt.mjs`, sans dépendance) ; les quelques réseaux qui servent du
  JSON sont lus aussi.
- **Le navigateur ne fournit jamais d'adresse**, seulement l'identifiant d'un réseau du
  catalogue. Les adresses du catalogue sont elles-mêmes contrôlées avant lecture, redirections
  comprises : ni la machine, ni le réseau local (`publicUrl`).
- **Trois natures de réseau.** « gps » et « estime » ci-dessus, et « theorique » : un réseau
  urbain qui ne publie QUE ses horaires (Lyon, Marseille, Strasbourg). Il n'a pas de véhicules
  à montrer — la case ne dit pas « en direct », la pastille LIVE disparaît — mais garde ses
  arrêts, des passages théoriques présentés comme tels, et l'itinéraire.
- **L'itinéraire, sur le réseau de la ville.** Le routeur de Toulouse (`lib/router.mjs`) est
  réutilisé tel quel : le GTFS du réseau est préparé dans le format des données Tisséo —
  lignes, quais, parcours par sens ET par branche, temps de parcours réels, grille horaire
  rangée par motifs — sur une fenêtre de quinze jours (`lib/reseaux/plan.mjs`, lecture de
  `stop_times.txt` ligne à ligne, dans le processus à part ; trois à vingt secondes selon la
  taille du réseau ; `data-net/<réseau>/plan.json`). La préparation ne démarre qu'à la première
  demande d'itinéraire : en attendant, l'API répond 503 « en préparation » et la page patiente
  en le disant. Deux réseaux au plus gardent leurs horaires en mémoire. Départ et arrivée : un
  arrêt du réseau, une adresse ou un lieu (géocodeur national, centré sur la ville), un point.
  Les heures sont théoriques, et c'est écrit ; quand le réseau publie ses horaires temps réel,
  une course annoncée remplace l'horaire. Dans la page, c'est le planificateur de Toulouse qui
  vient s'installer dans le panneau de la ville (`window.Planner.use`) et retrouve sa place
  ensuite ; les trajets enregistrés du compte restent toulousains.
- **Vélos en libre-service.** Même catalogue, autre famille : les systèmes À STATIONS (Vélib',
  Vélo'v, V'lille, LeVélo…) publient un flux GBFS — stations, vélos et places libres. Ses trois
  versions en circulation sont ramenées à la forme des stations toulousaines
  (`lib/reseaux/velos.mjs`). Les disponibilités sont relues au plus une fois par minute ; une
  réponse périmée est servie tout de suite et rafraîchie derrière. Une ville sans système à
  stations garde les stations référencées dans OpenStreetMap, sans disponibilités. Les flottes
  sans station (vélos et trottinettes posés sur le trottoir) ne sont pas reprises.
- **Ce qui manque, et qui est dit.** Paris et l'Île-de-France : pas de réseau (leur jeu de
  données est régional et d'un autre ordre de grandeur) — la ville garde ses lieux et ses
  Vélib' en direct. Un flux en panne (Grenoble sert une page web à la place du sien, Nantes
  refuse souvent les lectures) donne « ne répond pas pour l'instant », jamais une carte vide
  présentée comme calme. Un itinéraire hors de Toulouse ignore les perturbations du réseau.

| Route | Description |
|---|---|
| `GET /api/net/for?city=fr:33063` | Réseaux de la ville, le meilleur d'abord (`nature` : `gps`, `estime` ou `theorique`) |
| `GET /api/net/:id/vehicles` | Véhicules en circulation (aucun pour un réseau `theorique`) |
| `GET /api/net/:id/vehicle?vid=…` | Arrêts à venir d'un véhicule et tracés de sa ligne |
| `GET /api/net/:id/stops?bbox=sud,ouest,nord,est` | Arrêts dans une emprise |
| `GET /api/net/:id/stop?stop_id=…` | Prochains passages à un arrêt (tous ses quais) ; `theoretical` quand ils viennent des horaires |
| `GET /api/net/:id/plan` | État des horaires du réseau (`preparation`, `pret`, `indisponible`) ; lance leur préparation |
| `GET /api/net/:id/suggest?q=…&city=…` | Arrêts du réseau et adresses de la ville, pour la saisie |
| `GET /api/net/:id/journey?from=…&to=…&at=…&city=…` | Itinéraire (aussi `from_stop`, `from_lat`/`from_lon`/`from_label`, idem `to_`) ; 503 pendant la préparation |

Contrôles : `node --test test/reseaux.test.mjs test/reseaux-plan.test.mjs` et `npm run test:e2e:reseaux` (réseau fabriqué,
aucun flux réel).

## Compte Atlas : trajets enregistrés, planifiés, partagés

Le compte est **facultatif** : sans lui, la carte, les itinéraires et le connecteur
public marchent exactement comme avant. Avec lui (volet **Compte** du site, pastille
**Compte** dans l'application Android) :

- **Trajets enregistrés** — « Enregistrer » sous un itinéraire calculé. Les lieux sont
  résolus à l'enregistrement (on garde l'arrêt compris, pas la faute de frappe), le
  trajet se recalcule d'un geste et suit le compte d'un appareil à l'autre.
- **Trajets planifiés** — partir à / arriver avant une heure, à une date ou certains
  jours de la semaine (heure de Paris). L'itinéraire est **recalculé à la consultation**,
  jamais figé ; au-delà de l'horizon des horaires publiés, la réponse le dit. Sur
  Android, un rappel sonne avant le départ.
- **Partages entre amis** — les amis sont les **contacts acceptés d'Atlas Contacts** ;
  on ne peut rien partager à quelqu'un d'autre. Un partage est aussi annoncé par une
  carte dans Atlas Contacts. Une **position en direct** se partage pour une durée
  choisie (5 min à 4 h), une à la fois, et s'arrête d'elle-même.

Ce que le serveur garde, et ce qu'il ne garde pas :

- `data-user/` (hors git, fichiers `0600`, écriture atomique) : comptes (identifiant et
  pseudo Atlas), trajets, planifications, partages, autorisations des assistants. Les
  jetons de session et d'assistant n'y sont que sous forme d'**empreinte**.
- Les **positions partagées ne sont jamais écrites** : elles vivent en mémoire, le temps
  du partage, et disparaissent avec lui (ou au redémarrage). Passé deux minutes sans
  nouvelle, une position n'est plus servie comme actuelle.
- Le mot de passe ne passe jamais par ici : la connexion se fait chez Atlas
  (code d'autorisation + PKCE). « Tout effacer » supprime les données du compte ici,
  sans toucher au compte Atlas.

Réglages (`.env`) : `PUBLIC_URL` (défaut `https://tisseo.plagnito.com`), `ATLAS_URL`
(défaut `https://plagnito.com`), `TISSEO_DATA_USER` (dossier des comptes, défaut
`data-user` ; `memoire` = rien sur le disque, pour les tests).

Banc d'essai sans toucher au vrai Atlas : `node scripts/banc-atlas.mjs` (faux Atlas
sur 4731, trois comptes) puis le serveur avec `ATLAS_URL=http://127.0.0.1:4731`.

## Connecteur MCP (ChatGPT, Claude…)

Deux adresses, le même serveur **MCP** (transport « Streamable HTTP », sans état) :

- `POST /mcp` — **sans compte**. Réseau en direct et mode Ville, tout en lecture seule.
- `POST /mcp/compte` — **avec compte Atlas** (OAuth 2.1 : découverte RFC 9728 / 8414,
  enregistrement dynamique, PKCE S256). Les mêmes outils, plus ceux du compte.

| Outil | Ce qu'il répond |
|---|---|
| `vehicules` | Véhicules en circulation (position estimée, destination, prochain arrêt), filtrables par ligne, mode ou **autour d'un lieu** |
| `vehicule` | Un véhicule : arrêts restants avec heures, trace des dernières minutes |
| `itineraire` | Trajet A → B entre **arrêts, adresses, lieux** (« gare Matabiau », « aéroport ») ou `lat,lon`, maintenant ou à une heure donnée |
| `prochains_passages` | Départs à un arrêt (temps réel, sinon théorique — toujours le cas du métro) |
| `arrets_proches` | Arrêts autour d'un lieu, distance à pied et prochains passages |
| `rechercher_lieu` | Lever une ambiguïté : arrêts homonymes, adresses, lieux |
| `lignes` / `ligne` | Liste des lignes ; parcours et perturbations d'une ligne |
| `perturbations` | Infos trafic en texte brut, par ligne |
| `etat_du_reseau` | Vue d'ensemble, fraîcheur des données, validité des horaires |
| `ville_rechercher`, `ville_categories`, `ville_lieux` | Mode Ville : trouver une ville, ses catégories, ses lieux |
| `ville_meteo`, `ville_a_pied`, `ville_a_distance_de_marche`, `ville_balade` | Météo, trajet piéton, ce qui est à N minutes à pied, balade à étapes |
| `ville_transports` | Transports d'une autre ville française : véhicules par ligne, véhicules d'une ligne, passages à un arrêt — positions publiées ou estimées, passages en direct ou théoriques, c'est dit |
| `ville_itineraire` | Itinéraire en transports dans une autre ville française, sur le réseau de la ville ; chaque étape dit si son heure est théorique |

Avec un compte (`/mcp/compte`) :

| Outil | Ce qu'il fait |
|---|---|
| `mon_compte` | Qui est connecté, résumé de ce qui est enregistré |
| `mes_trajets`, `enregistrer_trajet`, `supprimer_trajet`, `calculer_mon_trajet` | Trajets enregistrés |
| `mes_trajets_planifies`, `planifier_trajet`, `modifier_trajet_planifie`, `supprimer_trajet_planifie`, `calculer_trajet_planifie` | Trajets planifiés |
| `mes_amis`, `partages_recus`, `mes_partages`, `partager_trajet`, `arreter_partage` | Amis et partages — seulement si la case **amis** a été cochée à l'autorisation |

Deux permissions, demandées sur l'écran d'accord : `tisseo` (ses propres trajets) et
`amis` (décochée par défaut). Un assistant ne **démarre jamais** un partage de
position, et ne voit celle d'un ami que si cet ami a lui-même coché « visible par les
assistants » en la partageant. Chaque assistant autorisé se révoque depuis le volet
Compte.

**Brancher dans ChatGPT** : Paramètres → Applis et connecteurs → Paramètres avancés →
*Mode développeur*, puis **Créer** : URL `https://tisseo.plagnito.com/mcp`,
authentification **Aucune** — ou `https://tisseo.plagnito.com/mcp/compte`,
authentification **OAuth** (rien à saisir : le client s'enregistre tout seul, puis
ouvre la connexion Atlas et l'écran d'accord). Dans Claude : Paramètres → Connecteurs →
*Ajouter un connecteur personnalisé*, mêmes URL.

Ce qui rend les réponses fiables pour un modèle de langage :
- heures en clair (fuseau de Paris) + « dans N min », jamais d'epoch seul ;
- chaque lieu dit comment il a été **compris** (`interprete_comme`) : arrêt, adresse, lieu ;
- **homonymes** : « Jean Jaurès » existe à trois endroits ; on prend le plus desservi
  (la station de métro) et on nomme les autres ;
- une adresse n'est retenue que si un arrêt Tisséo est à moins de 1,5 km : c'est ce qui
  écarte « 12 rue Alsace-Lorraine » à **Lavaur**, que le géocodeur classe en premier ;
- **refuser plutôt que deviner** : « Paris Gare de Lyon » ou « Bordeaux Saint-Jean » ne
  deviennent pas un sosie toulousain ; une saisie qui est le nom d'une **commune** rend son
  centre si le réseau y passe (« Muret »), un refus motivé sinon (« Lavaur », à 32 km) —
  jamais l'avenue de Toulouse qui porte ce nom. Ordre : arrêt de ce nom exact → commune
  desservie → arrêt dont le nom commence ainsi → refus → adresse ou lieu géocodé ;
- les **perturbations** comptent dans les réponses : passages retirés aux arrêts non
  desservis (avec la raison), itinéraires qui contournent une coupure à l'heure du trajet ;
- l'itinéraire écarte les lignes **hors service** à l'heure demandée (amplitude des
  horaires théoriques) et attend le prochain passage théorique quand le temps réel manque.

Géocodage : [Géoplateforme IGN](https://geoservices.ign.fr/documentation/services/services-geoplateforme/geocodage)
(sans clé) — seul le texte du lieu y est envoyé. Garde-fou : 120 appels / min / IP.

```powershell
node scripts/verifier-mcp.mjs                          # serveur local (4127)
node scripts/verifier-mcp.mjs https://tisseo.plagnito.com/mcp
```

## Déploiement (Raspberry Pi)

Dépôt `Plagnito/tisseo-live` (privé), publié depuis ce dossier du monodépôt `D:\Claude` :

```powershell
git subtree push --prefix=SideApps/Tisseo tisseo main   # remote tisseo = git@github.com:Plagnito/tisseo-live.git
```

Sur le Pi, `updater/supervisor.cjs` (service `tisseo-live`, voir
`updater/tisseo-live.service`) tire `main` toutes les 15 min, réinstalle, redémarre, et
revient à la version précédente si `/api/health` ne répond pas. Il **rafraîchit aussi le
GTFS** dans `data-live/` (hors git) : les horaires théoriques ne couvrent qu'environ un
mois, et sans ça le métro perdrait ses horaires le jour où la fenêtre expire.
`/api/status` donne `schedules_until`.

`data-user/` (les comptes) est hors git lui aussi : il survit aux `reset --hard` du
déploiement, et **rien ne le régénère** — c'est le seul dossier du service à sauvegarder.
Côté Atlas, le client SSO `tisseo-live` est déclaré dans `plugins/comet-sso.js`.

**Avant de pousser un changement de `public/`** : le CDN garde les `.js` et `.css` par
adresse, des heures durant, quels que soient les en-têtes de cache (mesuré le 02/10/2026 :
l'ancien `sw.js` encore servi huit heures après un déploiement). Un fichier modifié sans
changer d'adresse n'atteint donc pas les navigateurs. Relever la version (`?v=…`) partout —
`index.html`, `sw.js`, et `register('sw.js?v=…')` dans `app.js` — puis
`node scripts/versions.mjs --ecrire`. `npm test` échoue tant que ce n'est pas fait.

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
 - **Hors ligne** : la géométrie du réseau est mise en cache par le service
   worker au démarrage (281 Ko, en tâche de fond) — sans cela le cache ne se
   remplissait qu'en mode tracés, et une coupure de réseau laissait une carte
   vide. Vérifié par `npm run test:e2e:hors-ligne` : réseau coupé, 243 tracés
   toujours dessinés. Les positions, elles, restent réseau seul : on n'invente
   pas de véhicule sans flux.
 - **Téléphone** : la barre de compteurs était masquée sous 820 px, ce qui
   rendait l'inventaire des véhicules et la liste des lignes **inatteignables
   sur tout téléphone** — absents, pas seulement incommodes. Elle est désormais
   compacte (nombre + icône) et la barre passe sur deux lignes pour que les
   boutons de fond de carte et de thème restent à l'écran ; les cibles
   tactiles font 44 px. Vérifié sur 360, 390 et 820 px
   (`npm run test:e2e:telephone`).
 - **Téléphone, présentation** (`public/mobile.css`, `public/mobile.js`) : sous 820 px,
   l'en-tête tient en deux lignes (où l'on est et le choix de la vue, puis les compteurs) ;
   les commandes de la carte flottent sur la carte ; le panneau est une **feuille** qui
   monte du bas — on la tire par sa poignée, elle s'efface quand une fiche s'ouvre sur la
   carte. L'itinéraire se lit en **frise** (heures, ligne à sa couleur, marche en
   pointillés), à toute largeur. Les emojis ont laissé place à des **icônes dessinées** :
   `public/art.js` est généré par `node android/scripts/make-art.mjs`, depuis les mêmes
   tracés que l'application Android — ne pas le modifier à la main.
 - **Trois moteurs** : Chromium, Firefox et WebKit, y compris le pont vers
   `lib/`, le push SSE, le service worker et le hors ligne
   (`npm run test:e2e:navigateurs`). Firefox et WebKit demandent un
   téléchargement : `npx playwright install firefox webkit`.
 - **Performance** : mesurée à l'heure de pointe, pas à 3 h du matin. Avec 425
   véhicules, 53 images/s en déplacement ; au pire cas (z15, 148 pastilles
   dégroupées, toutes animées) 53 images/s, 1 954 nœuds dans le DOM, fiche
   véhicule ouverte en 43 ms. Il n'y a pas de problème de performance à
   corriger — le test existe pour le prouver et pour le surveiller
   (`npm run verifier:performance`).


Le backend met en cache le flux amont 10 s (avec `ETag`) pour respecter la limite
de charge, et ressert les dernières données connues en cas de coupure (flag `stale`).

## Tests

```powershell
npm test        # tests unitaires (node:test) : géométrie, interpolation
                # sur le tracé, mouvement des pastilles, choix du sens d'une
                # ligne, véhicules théoriques, recherche d'arrêts,
                # itinéraires (balayage de 120 trajets), qualité des tracés,
                # fonds de carte, connecteur MCP, comptes (trajets, plans,
                # partages, OAuth des assistants, routes face à un faux Atlas)
npm start       # dans un terminal…
npm run test:e2e              # carte réelle + repli mode tracés sans tuiles
npm run test:e2e:itineraire   # clic véhicule → itinéraire, fluidité, suivi
npm run test:e2e:metro        # métro théorique (serveur dédié, horloge à 10h00)
npm run test:e2e:inventaire   # inventaire lignes/véhicules, zoom au-delà du natif
npm run test:e2e:iti          # planificateur A→B
npm run test:e2e:live         # push SSE, alertes sur la carte, notifications
npm run test:e2e:hors-ligne   # réseau coupé : la carte et ses tracés tiennent
npm run test:e2e:telephone     # 3 tailles d'écran : 360, 390 et 820 px
npm run test:e2e:navigateurs   # Chromium, Firefox et WebKit
npm run test:e2e:compte        # compte : deux personnes, trajets, partage de position
                               # (autonome : lance son faux Atlas et son serveur)
```

Les tests `e2e` ont besoin de Playwright (installé à part, `npm i -D playwright`).

```powershell
node --test test/traces.test.mjs   # chaque arrêt est-il bien sur le tracé de sa ligne ?
node test/vitesse.mjs              # vitesse mesurée affichée (serveur forcé à une heure de trafic)
```

Pour un balayage de routage approfondi (800 trajets au lieu de 120, ~2 min) :

```powershell
$env:BALAYAGE = 800; npm run verifier:itineraires
```

## Régénérer les données statiques

`data/routes.json` + `data/stops.json` sont extraits du GTFS Tisséo :

```powershell
npm run prepare-gtfs
```

## Sources

- GTFS-RT : https://api.tisseo.fr/opendata/gtfsrt/
- GTFS statique : https://data.toulouse-metropole.fr/explore/dataset/tisseo-gtfs/
- Autres réseaux : point d'accès national https://transport.data.gouv.fr (GTFS et GTFS-RT de chaque réseau, sous sa propre licence — Licence Ouverte ou ODbL ; la source est citée sous la case du réseau)
- Licence : ODbL (Tisséo / Toulouse Métropole)
- Fond de carte : © OpenStreetMap contributors · © Esri · CyclOSM · OpenTopoMap

## Mode Ville multi-ville et Android natif

Le mode Ville conserve le choix d’une ville et peut la détecter depuis une position autorisée. Le catalogue, les lieux, la météo et l’agenda suivent ce profil. Tisséo conserve ses API propres à Toulouse. Les données disponibles ailleurs sont présentées avec leur source et leur couverture ; l’application ne crée pas de passages en direct pour les autres réseaux.

Routes supplémentaires : `/api/cities/search?q=`, `/api/cities/detect?lat=&lon=`, `/api/city/catalog?city=fr:69123`, `/api/city/places?city=fr:69123&category=parks`, `/api/city/weather?city=fr:69123`. Sans `city`, le profil Toulouse est conservé. Les identifiants `fr:CODE_INSEE` et `geo:LAT:LON` survivent au redémarrage du serveur. Les calculs à pied acceptent des coordonnées mondiales valides ; `/api/city/tour?points=LAT,LON;LAT,LON` calcule une balade de 2 à 6 étapes et limite sa longueur géographique à 20 km.

Les lieux OSM sont limités à 6 km du centre choisi. Les exports publics Huwise disponibles pour la France, l’Australie et la Nouvelle-Zélande stabilisent plusieurs catégories ; les exports limités aux cinémas ou aux aires de jeux sont signalés. Overpass complète les données disponibles, par extraction bornée et partagée entre catégories, avec cache de 6 heures et message d’indisponibilité. La recherche Photon est limitée à une requête par seconde et mise en cache 24 heures. Les URL de services restent configurables : `CITY_GEOCODER_URL`, `CITY_OVERPASS_URL`, `CITY_ROUTING_URL`. Pour un volume important, configurer une source dédiée selon les [règles des instances Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances). Les exports utilisent la [requête géographique Huwise](https://help.opendatasoft.com/apis/ods-explore-v2/).

La promenade stocke les distances quotidiennes localement. Les points et badges sont désactivés par défaut et activables dans Réglages, avec 10 points par 100 mètres enregistrés. La version web interrompt le suivi lorsqu’elle est masquée ; le suivi écran éteint utilise le service de localisation de l’[application Android native](android/README.md). Les points GPS ne sont pas envoyés au serveur. Chaque appareil conserve ses propres statistiques et réglages.

Fonctions réalisées et idées de coopération : [FEATURES.md](FEATURES.md).
