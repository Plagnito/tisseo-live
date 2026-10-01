// Stockage des comptes — des fichiers JSON, écrits de façon atomique.
// ---------------------------------------------------------------
// Tisséo Live ne conservait RIEN côté serveur. Avec les comptes, il garde le
// strict nécessaire : qui s'est connecté, ses trajets enregistrés et planifiés,
// ce qu'il partage, et les assistants qu'il a autorisés.
//
// POURQUOI DES FICHIERS. Quelques comptes, quelques dizaines de trajets : une
// base de données ajouterait une dépendance native à compiler sur le Raspberry
// Pi pour ranger moins d'un mégaoctet. Chaque collection tient dans un fichier,
// chargé une fois, réécrit en entier à chaque changement.
//
// POURQUOI « ATOMIQUE ». Écrire directement dans le fichier le VIDE avant de le
// remplir : une coupure de courant entre les deux laisse zéro octet, donc plus
// aucun compte. On écrit à côté (`.tmp`), puis on renomme — le renommage est
// une seule opération pour le système de fichiers : on lit soit l'ancien, soit
// le nouveau, jamais un fichier à moitié écrit.
//
// POURQUOI PAS data-live/. Ce dossier appartient au GTFS : le superviseur le
// SUPPRIME quand un rafraîchissement d'horaires tourne mal. Les comptes vivent
// dans data-user/, hors git comme lui, mais que personne n'efface.
// ---------------------------------------------------------------
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const NOM_RE = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * @param {object} options
 * @param {string|null} options.dir  dossier de stockage ; null = mémoire seule (tests)
 * @param {(m: string) => void} [options.log]
 */
export function createStore({ dir = null, log = () => {} } = {}) {
  const collections = new Map();
  if (dir) mkdirSync(dir, { recursive: true });

  function charger(nom, defaut) {
    if (!dir) return defaut();
    const fichier = join(dir, `${nom}.json`);
    if (!existsSync(fichier)) return defaut();
    try {
      return JSON.parse(readFileSync(fichier, 'utf8'));
    } catch (e) {
      // Un fichier illisible ne doit ni planter le serveur (toute la carte
      // tomberait pour un problème de comptes), ni être écrasé en silence par
      // une collection vide au prochain enregistrement : on le met de côté.
      const copie = `${fichier}.illisible-${Date.now()}`;
      try { copyFileSync(fichier, copie); } catch { /* disque plein : on garde au moins le journal */ }
      log(`stockage : ${nom}.json illisible (${e.message}) — copie gardée dans ${copie}, collection repartie de zéro`);
      return defaut();
    }
  }

  function ecrire(nom, donnees) {
    if (!dir) return;
    const fichier = join(dir, `${nom}.json`);
    const tmp = `${fichier}.tmp`;
    // La chaîne est construite AVANT d'ouvrir quoi que ce soit : un objet non
    // sérialisable lève ici, sans avoir touché au disque.
    const texte = JSON.stringify(donnees);
    writeFileSync(tmp, texte, { mode: 0o600 });
    renameSync(tmp, fichier);
  }

  /**
   * Une collection : `lire()` rend l'objet vivant, `changer(fn)` le modifie et
   * l'enregistre. `fn` peut rendre une valeur, transmise à l'appelant.
   */
  function collection(nom, defaut = () => ({})) {
    if (!NOM_RE.test(nom)) throw new Error(`stockage : nom de collection invalide « ${nom} »`);
    if (collections.has(nom)) return collections.get(nom);
    let donnees = charger(nom, defaut);
    const c = {
      lire: () => donnees,
      changer(fn) {
        const rendu = fn(donnees);
        ecrire(nom, donnees);
        return rendu;
      },
      /** Marque la collection comme modifiée sans passer par `changer`. */
      enregistrer: () => ecrire(nom, donnees),
      vider() { donnees = defaut(); ecrire(nom, donnees); },
    };
    collections.set(nom, c);
    return c;
  }

  return { collection, dir, persistant: Boolean(dir) };
}
