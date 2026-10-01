// Comptes Tisséo Live — trajets enregistrés, trajets planifiés, partages.
// ---------------------------------------------------------------
// Logique pure : aucun Express, aucun réseau. Tout ce qui est ici se teste en
// mémoire (`createStore({ dir: null })`) avec une horloge injectée.
//
// QUI EST L'UTILISATEUR. Tisséo Live n'a pas de mots de passe : l'identité vient
// du compte Atlas (lib/atlas.mjs). Ici, un compte n'est qu'un identifiant Atlas
// et un pseudo ; la session est un jeton tiré au hasard dont on ne garde que
// l'EMPREINTE — un vol du fichier de sessions ne donne aucun jeton utilisable.
//
// CE QUI N'EST JAMAIS ÉCRIT SUR LE DISQUE. Les positions partagées. Elles
// vivent en mémoire, le temps du partage, et meurent avec lui (ou avec le
// processus). Un fichier de positions serait un historique de déplacements :
// personne ne l'a demandé, donc il n'existe pas.
// ---------------------------------------------------------------
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const LIMITES = {
  trajets: 40,
  planifies: 40,
  partagesActifs: 60,
  destinataires: 20,
  nom: 60,
  lieu: 120,
  message: 200,
  sessionJours: 60,
  partageTrajetJours: 30,
  positionMinS: 5 * 60,
  positionMaxS: 4 * 3600,
  // Une position plus vieille que ça n'est plus « en direct » : on la rend
  // avec son âge, et l'interface la dit ancienne au lieu de la dessiner comme
  // si la personne y était encore.
  positionFraicheS: 120,
};

export class Refus extends Error {
  constructor(message, code = 'REFUS', statut = 400) { super(message); this.code = code; this.statut = statut; }
}

export const alea = (octets = 24) => randomBytes(octets).toString('hex');
export const empreinte = (jeton) => createHash('sha256').update(String(jeton)).digest('hex');
export function memeChaine(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- Texte ----------------------------------------------------------------
// Les caractères de contrôle n'ont rien à faire dans un nom de trajet, et un
// nom qui ne contient qu'eux doit être traité comme vide.
export function texte(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// --- Heure de Paris ---------------------------------------------------------
// Le réseau vit à l'heure de Paris, quel que soit le fuseau du serveur ou du
// téléphone. Un trajet planifié « 08:15 » veut dire 08:15 à Toulouse.
const fmtParis = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
});
const JOURS_EN = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Les composantes d'un instant (secondes) à l'heure de Paris. `js` : 1 = lundi … 7 = dimanche. */
export function partiesParis(t) {
  const o = {};
  for (const p of fmtParis.formatToParts(new Date(t * 1000))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, js: JOURS_EN[o.weekday] };
}

/** L'instant (secondes) d'une date et d'une heure de Paris. */
export function epochParis(y, mo, d, h, mi) {
  // On vise l'instant UTC « naïf », on lit quelle heure il est à Paris à cet
  // instant, et on corrige de l'écart. Deux passes : la première peut tomber
  // de l'autre côté d'un changement d'heure.
  const vise = Date.UTC(y, mo - 1, d, h, mi) / 1000;
  let t = vise;
  for (let i = 0; i < 2; i++) {
    const p = partiesParis(t);
    const lu = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) / 1000;
    t += vise - lu;
  }
  return t;
}

const pad2 = (n) => String(n).padStart(2, '0');
export const dateParis = (t) => { const p = partiesParis(t); return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`; };
export const heureParis = (t) => { const p = partiesParis(t); return `${pad2(p.h)}:${pad2(p.mi)}`; };

// --- Lieux ------------------------------------------------------------------
const STOP_RE = /^stop_(point|area):[A-Za-z0-9_:.-]{1,48}$/;

/**
 * Un lieu tel qu'il est gardé : toujours un texte lisible, et, quand on les
 * connaît, un identifiant d'arrêt ou des coordonnées. Rend null si inutilisable.
 */
export function nettoyerLieu(brut) {
  const b = typeof brut === 'string' ? { texte: brut } : brut && typeof brut === 'object' ? brut : null;
  if (!b) return null;
  const lieu = {};
  const t = texte(b.texte ?? b.label ?? b.nom, LIMITES.lieu);
  const lat = Number(b.lat), lon = Number(b.lon);
  const coords = b.lat != null && b.lon != null && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (typeof b.stop_id === 'string' && STOP_RE.test(b.stop_id)) lieu.stop_id = b.stop_id;
  if (coords) { lieu.lat = +lat.toFixed(6); lieu.lon = +lon.toFixed(6); }
  lieu.texte = t || (coords ? `${lat.toFixed(5)},${lon.toFixed(5)}` : '');
  if (!lieu.texte) return null;
  return lieu;
}

/**
 * Ce qu'on donne au calculateur pour ce lieu. Un identifiant d'arrêt peut
 * disparaître quand Tisséo republie son réseau : s'il n'existe plus, on retombe
 * sur les coordonnées, puis sur le texte — jamais sur une erreur muette.
 */
export function requeteLieu(lieu, arretExiste = () => true) {
  if (lieu.stop_id && arretExiste(lieu.stop_id)) return lieu.stop_id;
  if (lieu.lat != null && lieu.lon != null) return `${lieu.lat},${lieu.lon}`;
  return lieu.texte;
}

// --- Trajets planifiés ------------------------------------------------------
const HEURE_RE = /^([01]?\d|2[0-3])[:h]([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function nettoyerPlan(b) {
  if (!b || typeof b !== 'object') throw new Refus('Trajet planifié illisible.');
  const de = nettoyerLieu(b.de), a = nettoyerLieu(b.a);
  if (!de || !a) throw new Refus('Un départ et une arrivée sont nécessaires.');
  const m = HEURE_RE.exec(String(b.heure ?? '').trim());
  if (!m) throw new Refus('Heure attendue au format HH:MM (ex. 08:15).');
  const heure = `${pad2(+m[1])}:${m[2]}`;
  const mode = b.mode === 'arriver' ? 'arriver' : 'partir';
  let date = null, jours = null;
  if (Array.isArray(b.jours) && b.jours.length) {
    jours = [...new Set(b.jours.map(Number).filter((j) => Number.isInteger(j) && j >= 1 && j <= 7))].sort((x, y) => x - y);
    if (!jours.length) throw new Refus('Jours attendus : 1 (lundi) à 7 (dimanche).');
  } else {
    const saisie = String(b.date ?? '').trim();
    const d = DATE_RE.exec(saisie);
    if (!d) throw new Refus('Choisis une date (AAAA-MM-JJ) ou des jours de la semaine.');
    // Le 31 février ne doit pas devenir le 3 mars en silence.
    const t = epochParis(+d[1], +d[2], +d[3], 12, 0);
    if (dateParis(t) !== saisie) throw new Refus('Cette date n’existe pas.');
    date = saisie;
  }
  let rappel = null;
  if (b.rappel_min != null && b.rappel_min !== '') {
    const r = Math.round(Number(b.rappel_min));
    if (!Number.isFinite(r) || r < 0 || r > 180) throw new Refus('Rappel : entre 0 et 180 minutes avant.');
    rappel = r;
  }
  return { nom: texte(b.nom, LIMITES.nom) || `${de.texte} → ${a.texte}`.slice(0, LIMITES.nom), de, a, mode, heure, date, jours, rappel_min: rappel };
}

/**
 * La prochaine fois que ce trajet a lieu. Rend `{ quand, passe }` :
 * — trajet daté : son instant, `passe` s'il est derrière nous ;
 * — trajet répété : la prochaine occurrence à venir (jamais passée).
 * Une occurrence commencée depuis moins de `tolerance` secondes compte encore
 * comme « maintenant » : à 08:17, le trajet de 08:15 n'est pas « la semaine
 * prochaine ».
 */
export function prochaineOccurrence(plan, maintenant, tolerance = 15 * 60) {
  const [h, mi] = plan.heure.split(':').map(Number);
  if (plan.date) {
    const [y, mo, d] = plan.date.split('-').map(Number);
    const quand = epochParis(y, mo, d, h, mi);
    return { quand, passe: quand < maintenant - tolerance };
  }
  const p = partiesParis(maintenant);
  for (let i = 0; i <= 7; i++) {
    // Midi + i jours : loin des changements d'heure, on retombe sur le bon jour.
    const jour = partiesParis(epochParis(p.y, p.mo, p.d, 12, 0) + i * 86400);
    if (!plan.jours.includes(jour.js)) continue;
    const quand = epochParis(jour.y, jour.mo, jour.d, h, mi);
    if (quand >= maintenant - tolerance) return { quand, passe: false };
  }
  return { quand: null, passe: true };
}

// ---------------------------------------------------------------------------
export function createAccounts({ store, now = () => Math.floor(Date.now() / 1000) }) {
  const comptes = store.collection('comptes');
  const sessions = store.collection('sessions');
  const trajets = store.collection('trajets');
  const planifies = store.collection('planifies');
  const partages = store.collection('partages');
  const positions = new Map(); // id de partage -> { lat, lon, precision_m, t } — mémoire seule

  // --- comptes --------------------------------------------------------------
  function ouvrirCompte({ id, pseudo }, atlas = null) {
    const uid = String(id);
    if (!/^\d{1,15}$/.test(uid)) throw new Refus('Compte Atlas invalide.', 'COMPTE', 502);
    return comptes.changer((c) => {
      const t = now();
      const existant = c[uid];
      c[uid] = {
        id: uid,
        pseudo: texte(pseudo, 40) || 'Voyageur',
        cree: existant?.cree ?? t,
        vu: t,
        // Les jetons Atlas servent à lire la liste de contacts et à prévenir un
        // ami. On garde le dernier jeu connu ; une connexion sans jetons (tests)
        // ne doit pas effacer ceux qu'on avait.
        atlas: atlas ?? existant?.atlas ?? null,
      };
      return publicCompte(c[uid]);
    });
  }
  const publicCompte = (c) => (c ? { id: c.id, pseudo: c.pseudo } : null);
  const compte = (uid) => publicCompte(comptes.lire()[String(uid)]);
  const jetonsAtlas = (uid) => comptes.lire()[String(uid)]?.atlas ?? null;
  function poserJetonsAtlas(uid, atlas) {
    comptes.changer((c) => { if (c[String(uid)]) c[String(uid)].atlas = atlas; });
  }

  // --- sessions -------------------------------------------------------------
  const DUREE_SESSION = LIMITES.sessionJours * 86400;
  function ouvrirSession(uid, { genre = 'web' } = {}) {
    const jeton = alea(32);
    const t = now();
    sessions.changer((s) => {
      // Ménage au passage : une session expirée ne sert plus à rien.
      for (const [k, v] of Object.entries(s)) if (v.expire < t) delete s[k];
      s[empreinte(jeton)] = { uid: String(uid), genre: genre === 'android' ? 'android' : 'web', cree: t, vu: t, expire: t + DUREE_SESSION };
    });
    return jeton;
  }
  function session(jeton) {
    if (!jeton || typeof jeton !== 'string' || jeton.length > 200) return null;
    const cle = empreinte(jeton);
    const s = sessions.lire()[cle];
    const t = now();
    if (!s || s.expire < t) return null;
    const c = comptes.lire()[s.uid];
    if (!c) return null;
    // Session glissante, mais on n'écrit pas le disque à chaque requête : une
    // fois par heure suffit à ne jamais déconnecter quelqu'un d'actif.
    if (t - s.vu > 3600) sessions.changer((x) => { x[cle].vu = t; x[cle].expire = t + DUREE_SESSION; });
    return { uid: s.uid, pseudo: c.pseudo, genre: s.genre };
  }
  function fermerSession(jeton) {
    if (!jeton) return false;
    return sessions.changer((s) => { const k = empreinte(jeton); const la = Boolean(s[k]); delete s[k]; return la; });
  }

  // --- trajets enregistrés --------------------------------------------------
  const listeDe = (col, uid) => col.lire()[String(uid)] ?? [];
  function vueTrajet(t) {
    return { id: t.id, nom: t.nom, de: t.de, a: t.a, utilisations: t.utilisations, dernier: t.dernier, cree: t.cree };
  }
  /** Les trajets, les plus utilisés d'abord : c'est ce que « fréquent » veut dire. */
  function listerTrajets(uid) {
    return [...listeDe(trajets, uid)]
      .sort((x, y) => (y.utilisations - x.utilisations) || ((y.dernier ?? y.cree) - (x.dernier ?? x.cree)))
      .map(vueTrajet);
  }
  function enregistrerTrajet(uid, b) {
    const de = nettoyerLieu(b?.de), a = nettoyerLieu(b?.a);
    if (!de || !a) throw new Refus('Un départ et une arrivée sont nécessaires.');
    return trajets.changer((col) => {
      const liste = col[String(uid)] ?? (col[String(uid)] = []);
      // Enregistrer deux fois le même trajet n'en crée pas deux : on rend
      // l'existant. « Même » = mêmes textes, à la casse près.
      const cle = (l) => l.texte.toLowerCase();
      const deja = liste.find((x) => cle(x.de) === cle(de) && cle(x.a) === cle(a));
      if (deja) return { ...vueTrajet(deja), deja: true };
      if (liste.length >= LIMITES.trajets) throw new Refus(`Limite atteinte : ${LIMITES.trajets} trajets enregistrés. Supprimes-en un.`, 'LIMITE', 409);
      const t = { id: `t_${alea(6)}`, nom: texte(b.nom, LIMITES.nom) || `${de.texte} → ${a.texte}`.slice(0, LIMITES.nom), de, a, cree: now(), utilisations: 0, dernier: null };
      liste.push(t);
      return vueTrajet(t);
    });
  }
  function trouver(col, uid, id, quoi) {
    const x = listeDe(col, uid).find((e) => e.id === id);
    if (!x) throw new Refus(`${quoi} introuvable.`, 'INCONNU', 404);
    return x;
  }
  function modifierTrajet(uid, id, b) {
    return trajets.changer(() => {
      const t = trouver(trajets, uid, id, 'Trajet');
      if (b.nom !== undefined) t.nom = texte(b.nom, LIMITES.nom) || t.nom;
      if (b.de !== undefined) { const l = nettoyerLieu(b.de); if (!l) throw new Refus('Départ illisible.'); t.de = l; }
      if (b.a !== undefined) { const l = nettoyerLieu(b.a); if (!l) throw new Refus('Arrivée illisible.'); t.a = l; }
      return vueTrajet(t);
    });
  }
  function supprimerDans(col, uid, id, quoi) {
    return col.changer((c) => {
      const liste = c[String(uid)] ?? [];
      const i = liste.findIndex((e) => e.id === id);
      if (i < 0) throw new Refus(`${quoi} introuvable.`, 'INCONNU', 404);
      liste.splice(i, 1);
      return true;
    });
  }
  const supprimerTrajet = (uid, id) => supprimerDans(trajets, uid, id, 'Trajet');
  function utiliserTrajet(uid, id) {
    return trajets.changer(() => {
      const t = trouver(trajets, uid, id, 'Trajet');
      t.utilisations += 1;
      t.dernier = now();
      return vueTrajet(t);
    });
  }
  const trajet = (uid, id) => vueTrajet(trouver(trajets, uid, id, 'Trajet'));

  // --- trajets planifiés ----------------------------------------------------
  function vuePlan(p) {
    const o = prochaineOccurrence(p, now());
    return {
      id: p.id, nom: p.nom, de: p.de, a: p.a, mode: p.mode, heure: p.heure,
      date: p.date, jours: p.jours, rappel_min: p.rappel_min, cree: p.cree,
      prochaine: o.quand, passe: o.passe,
    };
  }
  /** Les trajets planifiés, le prochain d'abord ; les passés à la fin. */
  function listerPlans(uid) {
    return listeDe(planifies, uid).map(vuePlan)
      .sort((x, y) => (x.passe - y.passe) || ((x.prochaine ?? Infinity) - (y.prochaine ?? Infinity)));
  }
  function planifier(uid, b) {
    const propre = nettoyerPlan(b);
    return planifies.changer((col) => {
      const liste = col[String(uid)] ?? (col[String(uid)] = []);
      if (liste.length >= LIMITES.planifies) throw new Refus(`Limite atteinte : ${LIMITES.planifies} trajets planifiés. Supprimes-en un.`, 'LIMITE', 409);
      const p = { id: `p_${alea(6)}`, ...propre, cree: now() };
      liste.push(p);
      return vuePlan(p);
    });
  }
  function modifierPlan(uid, id, b) {
    return planifies.changer(() => {
      const p = trouver(planifies, uid, id, 'Trajet planifié');
      // On revalide l'ENSEMBLE : changer la date d'un trajet répété, ou l'heure
      // seule, doit donner un plan cohérent, pas un mélange des deux formes.
      const fusion = { ...p, ...b };
      if (b.date !== undefined && b.jours === undefined) fusion.jours = null;
      if (b.jours !== undefined && b.date === undefined) fusion.date = null;
      Object.assign(p, nettoyerPlan(fusion));
      return vuePlan(p);
    });
  }
  const supprimerPlan = (uid, id) => supprimerDans(planifies, uid, id, 'Trajet planifié');
  const plan = (uid, id) => vuePlan(trouver(planifies, uid, id, 'Trajet planifié'));

  // --- partages -------------------------------------------------------------
  function actif(p, t = now()) { return p.expire > t; }
  function menagePartages() {
    const t = now();
    const col = partages.lire();
    const morts = Object.values(col).filter((p) => !actif(p, t));
    if (!morts.length) return;
    partages.changer((c) => { for (const p of morts) { delete c[p.id]; positions.delete(p.id); } });
  }

  /**
   * Ce qu'un partage montre à quelqu'un. `pour` : 'moi' (l'auteur), 'ami' (un
   * destinataire) ou 'assistant' (un outil d'IA branché par un destinataire).
   * Un assistant ne reçoit la position que si l'AUTEUR l'a permis : son ami a
   * le droit de la voir, pas de la transmettre à un tiers.
   */
  function vuePartage(p, pour) {
    const t = now();
    const v = {
      id: p.id, type: p.type, de: { id: p.de, pseudo: p.dePseudo },
      trajet: p.trajet, message: p.message, cree: p.cree, expire: p.expire,
      assistants: p.assistants,
    };
    if (pour === 'moi') v.vers = p.vers;
    if (p.type === 'position') {
      const pos = positions.get(p.id);
      const visible = pour !== 'assistant' || p.assistants;
      v.position = pos && visible
        ? { lat: pos.lat, lon: pos.lon, precision_m: pos.precision_m, age_s: Math.max(0, t - pos.t), fraiche: t - pos.t <= LIMITES.positionFraicheS }
        : null;
      if (!visible) v.position_reservee = 'Cette personne n’a pas autorisé les assistants à lire sa position.';
      else if (!pos) v.position_attente = 'Aucune position reçue pour l’instant.';
    }
    return v;
  }

  /**
   * @param {string} uid auteur
   * @param {object} b { type, vers:[{id,pseudo}], trajet?, message?, duree_s?, assistants? }
   *   `vers` doit déjà avoir été vérifié contre le carnet Atlas par l'appelant :
   *   ce module ne sait pas qui est ami avec qui.
   */
  function partager(uid, b) {
    menagePartages();
    const auteur = comptes.lire()[String(uid)];
    if (!auteur) throw new Refus('Compte introuvable.', 'COMPTE', 401);
    const type = b?.type === 'position' ? 'position' : 'trajet';
    const vers = [...new Map((Array.isArray(b?.vers) ? b.vers : [])
      .map((d) => [String(d?.id ?? ''), { id: String(d?.id ?? ''), pseudo: texte(d?.pseudo, 40) || 'Contact' }])
      .filter(([id]) => /^\d{1,15}$/.test(id) && id !== String(uid))).values()];
    if (!vers.length) throw new Refus('Choisis au moins un ami.');
    if (vers.length > LIMITES.destinataires) throw new Refus(`Au plus ${LIMITES.destinataires} destinataires.`);
    let trajetPartage = null;
    if (b.trajet) {
      const de = nettoyerLieu(b.trajet.de), a = nettoyerLieu(b.trajet.a);
      if (type === 'trajet' && (!de || !a)) throw new Refus('Un départ et une arrivée sont nécessaires.');
      if (a) {
        trajetPartage = { nom: texte(b.trajet.nom, LIMITES.nom) || null, de: de ?? null, a };
        // Un trajet planifié se partage avec son horaire : c'est ce qui permet
        // à l'ami de le retrouver tel quel.
        const horaire = HEURE_RE.test(String(b.trajet.heure ?? '').trim())
          && (b.trajet.date || (Array.isArray(b.trajet.jours) && b.trajet.jours.length));
        if (horaire) {
          const pl = nettoyerPlan({ ...b.trajet, de: de ?? a, a });
          Object.assign(trajetPartage, { mode: pl.mode, heure: pl.heure, date: pl.date, jours: pl.jours });
        }
      }
    }
    if (type === 'trajet' && !trajetPartage) throw new Refus('Aucun trajet à partager.');
    const t = now();
    let expire;
    if (type === 'position') {
      const d = Math.round(Number(b.duree_s));
      if (!Number.isFinite(d) || d < LIMITES.positionMinS || d > LIMITES.positionMaxS) {
        throw new Refus(`Durée du partage de position : de ${LIMITES.positionMinS / 60} minutes à ${LIMITES.positionMaxS / 3600} heures.`);
      }
      expire = t + d;
    } else expire = t + LIMITES.partageTrajetJours * 86400;
    return partages.changer((col) => {
      const miens = Object.values(col).filter((p) => p.de === String(uid) && actif(p, t));
      if (miens.length >= LIMITES.partagesActifs) throw new Refus('Trop de partages en cours : retires-en avant d’en créer d’autres.', 'LIMITE', 409);
      // Un seul partage de position à la fois : deux partages simultanés vers
      // des amis différents, c'est deux boutons « arrêter » dont un qu'on oublie.
      if (type === 'position') for (const p of miens) if (p.type === 'position') { delete col[p.id]; positions.delete(p.id); }
      const p = {
        id: `s_${alea(9)}`, type, de: String(uid), dePseudo: auteur.pseudo, vers,
        trajet: trajetPartage, message: texte(b.message, LIMITES.message) || null,
        assistants: b.assistants === true, cree: t, expire,
      };
      col[p.id] = p;
      return vuePartage(p, 'moi');
    });
  }
  function partagesDe(uid) {
    menagePartages();
    const col = Object.values(partages.lire());
    const moi = String(uid);
    const tri = (x, y) => y.cree - x.cree;
    return {
      envoyes: col.filter((p) => p.de === moi).sort(tri).map((p) => vuePartage(p, 'moi')),
      recus: col.filter((p) => p.vers.some((d) => d.id === moi)).sort(tri).map((p) => vuePartage(p, 'ami')),
    };
  }
  /** Un partage, s'il concerne ce compte. Sinon « introuvable » : on ne dit pas qu'il existe. */
  function partage(uid, id, pour = null) {
    menagePartages();
    const p = partages.lire()[String(id)];
    const moi = String(uid);
    if (!p) throw new Refus('Partage introuvable ou terminé.', 'INCONNU', 404);
    const role = p.de === moi ? 'moi' : p.vers.some((d) => d.id === moi) ? 'ami' : null;
    if (!role) throw new Refus('Partage introuvable ou terminé.', 'INCONNU', 404);
    return vuePartage(p, pour === 'assistant' && role === 'ami' ? 'assistant' : role);
  }
  /** L'auteur arrête son partage ; un destinataire s'en retire. */
  function retirerPartage(uid, id) {
    const moi = String(uid);
    return partages.changer((col) => {
      const p = col[String(id)];
      if (!p) throw new Refus('Partage introuvable ou terminé.', 'INCONNU', 404);
      if (p.de === moi) { delete col[p.id]; positions.delete(p.id); return { arrete: true }; }
      const i = p.vers.findIndex((d) => d.id === moi);
      if (i < 0) throw new Refus('Partage introuvable ou terminé.', 'INCONNU', 404);
      p.vers.splice(i, 1);
      if (!p.vers.length) { delete col[p.id]; positions.delete(p.id); }
      return { retire: true };
    });
  }
  function majPosition(uid, id, b) {
    const p = partages.lire()[String(id)];
    if (!p || p.de !== String(uid) || p.type !== 'position' || !actif(p)) {
      throw new Refus('Ce partage de position est terminé.', 'FINI', 410);
    }
    const lat = Number(b?.lat), lon = Number(b?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Refus('Position illisible.');
    const prec = Number(b?.precision_m);
    positions.set(p.id, {
      lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      precision_m: Number.isFinite(prec) && prec >= 0 ? Math.min(Math.round(prec), 50000) : null,
      t: now(),
    });
    return { ok: true, expire: p.expire, reste_s: p.expire - now() };
  }

  function resume(uid) {
    const p = partagesDe(uid);
    return {
      compte: compte(uid),
      trajets: listerTrajets(uid),
      planifies: listerPlans(uid),
      partages: p,
      limites: { trajets: LIMITES.trajets, planifies: LIMITES.planifies },
    };
  }

  /** Efface tout ce que le serveur garde sur ce compte. */
  function supprimerCompte(uid) {
    const moi = String(uid);
    trajets.changer((c) => { delete c[moi]; });
    planifies.changer((c) => { delete c[moi]; });
    partages.changer((c) => {
      for (const p of Object.values(c)) {
        if (p.de === moi) { delete c[p.id]; positions.delete(p.id); continue; }
        p.vers = p.vers.filter((d) => d.id !== moi);
        if (!p.vers.length) { delete c[p.id]; positions.delete(p.id); }
      }
    });
    sessions.changer((s) => { for (const [k, v] of Object.entries(s)) if (v.uid === moi) delete s[k]; });
    comptes.changer((c) => { delete c[moi]; });
    return true;
  }

  return {
    ouvrirCompte, compte, jetonsAtlas, poserJetonsAtlas,
    ouvrirSession, session, fermerSession,
    listerTrajets, enregistrerTrajet, modifierTrajet, supprimerTrajet, utiliserTrajet, trajet,
    listerPlans, planifier, modifierPlan, supprimerPlan, plan,
    partager, partagesDe, partage, retirerPartage, majPosition,
    resume, supprimerCompte,
    _positions: positions,
  };
}
