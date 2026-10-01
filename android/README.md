# Toulouse Ville — Android natif

Application Android autonome, Java 17, vues Android, MapLibre Native OpenGL
13.6.1. Aucun WebView, aucun chargement de l'interface web. Android 8+ (API 26),
cible API 35 ; test sur Samsung SM-A176B sous Android 16.

Les données viennent des API du projet parent. Adresse par défaut :
`https://tisseo.plagnito.com`. Le menu **Réglages** permet de changer le serveur.
HTTPS est exigé, avec une exception strictement limitée à localhost pour le
tunnel USB. Aucune permission de localisation n'est demandée à l'ouverture.

## Compilation

Prérequis : JDK 17, SDK Android 35 / Build Tools 35. Le wrapper utilise Gradle
8.11.1 et AGP 8.9.2. Créer `local.properties` avec le chemin du SDK (non versionné).

```powershell
$env:JAVA_HOME='D:\Claude\.android-build\jdk17\jdk-17.0.19+10'
$env:GRADLE_USER_HOME='D:\Claude\.android-build\gradle-home'
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

APK signé pour le test : `app/build/outputs/apk/debug/app-debug.apk`.
La clé de développement Gradle doit être conservée pour les mises à jour
locales. Une distribution publique nécessitera une signature de production
durable et un `versionCode` croissant ; aucun secret de signature n'est inclus.

## Essai sur téléphone

Utilisation autonome avec le serveur public :

```powershell
adb -s SERIAL install -r app/build/outputs/apk/debug/app-debug.apk
adb -s SERIAL shell am start -n com.plagnito.toulouseville/.MainActivity --es api_url https://tisseo.plagnito.com
.\scripts\test-device.ps1 -Serial SERIAL
```

Pour développer avec le serveur local :

```powershell
adb devices
adb -s SERIAL reverse tcp:4127 tcp:4127
adb -s SERIAL install -r app/build/outputs/apk/debug/app-debug.apk
adb -s SERIAL shell am start -n com.plagnito.toulouseville/.MainActivity --es api_url http://127.0.0.1:4127
.\scripts\test-device.ps1 -Serial SERIAL -ApiUrl http://127.0.0.1:4127
```

L'option `api_url` est acceptée uniquement dans le build debug. Le serveur
Node doit tourner sur le PC durant l'essai USB. Le script vérifie les favoris
après redémarrage, les arrêts proches et un itinéraire Tisséo. Il ne touche
qu'au paquet `com.plagnito.toulouseville` et garde ses captures dans `captures/`.

## Fonctionnement

Les requêtes et fichiers sont traités hors du thread principal, avec quatre
chargements simultanés. Les réponses d'une connexion précédente sont ignorées
lors d'un changement de serveur. Le sondage Tisséo s'arrête quand l'application
passe en arrière-plan. Les disponibilités vélo se rafraîchissent à la minute.
Les lieux et le catalogue se conservent localement en cas de panne, avec un
message d'ancienneté ; aucun véhicule ni horaire temps réel n'est conservé
comme donnée actuelle. Les favoris sont stockés dans les préférences privées.

Le bouton **Partager ce lieu** ouvre le sélecteur Android avec le nom, l’adresse,
le point sur OpenStreetMap et la source. **Ajouter au calendrier** permet de
choisir un créneau publié, puis ouvre le brouillon dans le calendrier du téléphone.
L’utilisateur décide de l’enregistrer. Les dates sans horaires précis ne créent
pas de créneau inventé. Les changements d’heure conservent les décalages UTC
publiés. Aucune permission de lecture ou d’écriture du calendrier n’est requise.
Voir les [intents Android pour le calendrier](https://developer.android.com/guide/components/intents-common#Calendar).

La carte OSM affiche son attribution. Chaque fiche expose sa source et la
licence, ainsi que les horaires, disponibilités ou tarifs réellement fournis.
Les groupes sur la carte signalent leurs usages : S (sortir), B (bouger),
Q (quotidien). Cliquer sur un groupe zoome vers les lieux.

Le filtre « Ouvert maintenant » repose sur l'évaluation du serveur, limitée
aux horaires hebdomadaires simples connus. Les options PMR, accès libre et
végétarien n'incluent pas les valeurs inconnues. Les durées à pied proviennent
de Valhalla ; un parcours accessible n'est pas garanti par une déclaration PMR
du lieu. Le calculateur Tisséo distingue prévisions réelles et horaires
théoriques, et la carte indique que les véhicules sont des positions estimées.

Le serveur public sert les API Ville et Tisséo. Le téléphone peut les consulter
par Wi-Fi ou réseau mobile, sans le PC ni le tunnel USB.
