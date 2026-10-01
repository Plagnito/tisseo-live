# Prochaines fonctions utiles

Le mode Ville et le mode Tisséo partagent une carte, des favoris et des parcours.
Les deux ajouts immédiats de cette version Android sont le partage de lieux et
la préparation d’une entrée de calendrier depuis un créneau réellement publié.

## Priorité 1 — les déplacements habituels

**Arrêts et lignes favoris, puis widget Android.** Retrouver en un geste ses
prochains passages, et les consulter depuis l’écran d’accueil. Les API actuelles
fournissent déjà les arrêts et les passages. Le widget devra montrer l’heure de
mise à jour et distinguer prévision Tisséo et horaire théorique ; un résultat
ancien ne devra pas conserver un compte à rebours présenté comme actuel.

**Trajets enregistrés.** Enregistrer un départ et une arrivée nommés, puis
recalculer le trajet au moment du départ. Les favoris restent sur le téléphone.
Le résultat d’un ancien calcul ne vaut pas un itinéraire disponible aujourd’hui.

## Priorité 2 — les sorties faciles à organiser

**Suggestions selon la météo et le temps disponible.** Proposer des événements
avec un créneau compatible, puis des idées parmi les parcs et lieux culturels.
Le caractère intérieur / extérieur doit venir d’une donnée explicite ; les
catégories actuelles ne suffisent pas à affirmer qu’un lieu est à l’abri.

**Parcours de balade avec étapes.** Choisir quelques lieux, calculer les tronçons
piétons et afficher le temps total. Ajouter fontaines et toilettes à proximité
sans garantir leur ouverture. Les chemins ombragés et les parcours sans marches
attendent des données fiables avant d’être proposés comme tels.

## Priorité 3 — être prévenu au bon moment

**Alertes choisies pour les lignes favorites.** Notifications uniquement après
activation explicite, sur une perturbation nouvelle ou modifiée, avec lien vers
la source et réglage des plages horaires. Il faut d’abord stabiliser les
identifiants d’alerte et gérer les restrictions Android sur le travail en
arrière-plan ; aucun sondage permanent en arrière-plan n’est prévu actuellement.

**Rappels de sorties.** Utiliser d’abord le calendrier Android déjà proposé dans
les fiches. Des rappels internes ne seraient utiles qu’avec une gestion claire
des annulations et changements de créneau dans la source.

## Choix conseillé

Commencer par les **arrêts favoris et trajets enregistrés**, puis leur widget :
ils utilisent les données existantes et rendent l’app utile chaque jour.
Les suggestions météo et balades à étapes viennent ensuite. Les notifications
demandent davantage de suivi et une activation volontaire.
