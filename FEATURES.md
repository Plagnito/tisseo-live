# Ville & Promenade

## Disponible

- Une interface centrée sur trois usages : explorer, se déplacer, marcher. La version Android utilise des vues natives et MapLibre, sans WebView.
- Recherche de ville, sélection conservée et détection depuis une position autorisée. Les lieux, l’agenda et la météo suivent le profil choisi. Les réponses et caches des villes précédentes sont isolés.
- Tisséo à Toulouse : arrêts et lignes favoris, trajets enregistrés et recalculés à la consultation, widget des prochains passages, notifications facultatives sur les lignes choisies avec plage horaire. Android peut différer la vérification prévue toutes les 15 minutes.
- Ailleurs : lieux publics dans un rayon de 6 km, arrêts OSM quand la source répond et accès aux itinéraires en transports dans l’application de cartes. Aucun passage en direct n’est inventé pour un réseau sans connecteur.
- Balades de 2 à 6 étapes, réorganisation et calcul piéton par tronçon. Partage d’une liste de lieux dans Android, avec durée de marche estimée hors visites.
- Promenade démarrée volontairement, pause/reprise, distance GPS estimée par jour, statistiques sur 7 et 30 jours et historique local. Le service Android continue écran éteint et s’arrête avec Terminer ; il ne se relance pas après une interruption du processus. Dans le navigateur, masquer la page arrête le suivi.
- Gamification désactivée par défaut, activable dans les réglages : 10 points par tranche complète de 100 mètres enregistrés, un niveau tous les 500 points, badges de distance. Calculer un parcours ou ouvrir une fiche ne donne aucun point.
- Défi quotidien personnalisable et partage volontaire du défi dans Android. Les destinataires choisissent leur propre objectif ; les distances GPS et les positions ne sont pas publiées.

## Couverture

Les données varient selon la ville. Toulouse conserve ses sources spécialisées. Les exports OSM Huwise disponibles en France, Australie et Nouvelle-Zélande servent de sources stables pour plusieurs catégories ; certains exports couvrent seulement les cinémas ou les aires de jeux, ce qui est indiqué dans leurs fiches et sources. Overpass complète les catégories disponibles, avec caches, limites d’extraction et messages de panne. OpenAgenda ne fournit que les événements publiés dans sa base. Les horaires simples ne sont évalués que lorsqu’un fuseau est connu ; les informations inconnues ne passent pas les filtres pratiques.

## Jouer à plusieurs : prochaines fonctions proposées

1. **Défis coopératifs de groupe.** Un code d’invitation, un objectif hebdomadaire commun et une contribution adaptée à chacun. Partager uniquement les totaux volontairement, avec pseudonyme ; aucun tracé GPS ou domicile.
2. **Rallyes de découverte par équipes.** Une courte balade avec énigmes liées à des lieux documentés. Prévoir des variantes courtes et accessibles, sans encourager à manipuler le téléphone en traversant.
3. **Badges collectifs.** Récompenser une balade ensemble ou la découverte de plusieurs quartiers, sans classement obligatoire ni pénalité après une journée sans marche.
4. **Balades partagées.** Permettre de proposer des étapes à un groupe et de voter avant de partir, puis exporter le programme.

Ces fonctions en ligne nécessitent encore un service de groupes, des invitations et une gestion du consentement. Cette version propose déjà le partage Android des balades et défis, mais ne prétend pas synchroniser un groupe ou un classement.

Les prochaines intégrations de transport devront déclarer leur périmètre et leur source GTFS/GTFS-RT ou GBFS avant de proposer de vrais horaires ou disponibilités hors Toulouse.
