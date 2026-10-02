// Routes des comptes : connexion Atlas, trajets, partages, OAuth des assistants.
// ---------------------------------------------------------------
// Tout ce qui parle HTTP est ici ; la logique est dans account.mjs, atlas.mjs et
// oauth.mjs, qui se testent sans serveur.
//
// DEUX SORTES DE JETONS, QUI NE S'ÉCHANGENT PAS.
//   • la SESSION (cookie `tisseo_session`, ou Bearer pour l'application
//     Android) ouvre /api/compte ;
//   • le JETON D'ASSISTANT (OAuth, lib/oauth.mjs) ouvre /mcp et rien d'autre.
// Un assistant ne peut donc ni lire la liste des assistants autorisés, ni en
// autoriser un autre, ni supprimer le compte.
// ---------------------------------------------------------------
import express from 'express';
import { Refus, alea, empreinte, memeChaine, dateParis, heureParis, requeteLieu, nettoyerLieu, LIMITES } from './account.mjs';
import { pkce } from './atlas.mjs';
import { ErreurOAuth, documentsDecouverte } from './oauth.mjs';

const COOKIE = 'tisseo_session';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function lireCookie(req, nom) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === nom) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
const porteur = (req) => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim());
  return m ? m[1] : null;
};

/** Une page HTML minimale, pour les étapes qui se passent hors de l'application. */
function page(titre, corps, { statut = 200 } = {}) {
  return {
    statut,
    html: `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(titre)} — Tisséo Live</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#11161c;color:#e8edf2;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:20px}
main{width:100%;max-width:460px;background:#171d24;border:1px solid #2a3440;border-radius:14px;padding:26px}
h1{font-size:20px;margin:0 0 6px}p{margin:10px 0;color:#b8c3cf}b{color:#e8edf2}
.qui{display:flex;gap:10px;align-items:center;padding:12px;border-radius:10px;background:#11161c;border:1px solid #2a3440;margin:14px 0}
.qui small{display:block;color:#8a97a6}
ul{padding-left:20px;margin:10px 0;color:#cdd6df}li{margin:5px 0}
label.case{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:10px;border:1px solid #3b4756;margin:14px 0;cursor:pointer}
label.case input{margin-top:4px;width:18px;height:18px;flex:none}
label.case small{display:block;color:#8a97a6;margin-top:3px}
.actions{display:flex;gap:10px;margin-top:18px}
button,a.bouton{flex:1;min-height:46px;border-radius:10px;border:1px solid #3b4756;background:#1f2731;color:#e8edf2;font:inherit;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;display:grid;place-items:center;padding:0 14px}
button.oui,a.bouton.oui{background:#e2001a;border-color:#e2001a;color:#fff}
.note{font-size:13px;color:#8a97a6;margin-top:16px}
</style></head><body><main>${corps}</main></body></html>`,
  };
}
function envoyerPage(res, p) {
  res.status(p.statut).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // Ces pages portent des boutons qui engagent le compte : elles ne
    // s'affichent dans aucun cadre, où qu'il soit.
    'X-Frame-Options': 'DENY',
    // Pas de `form-action` : Chrome l'applique aussi à la REDIRECTION qui suit
    // l'envoi du formulaire d'accord, et bloquerait le retour chez l'assistant.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    // « same-origin », pas « no-referrer » : avec ce dernier, Chrome envoie
    // « Origin: null » sur l'envoi du formulaire d'accord, et la garde d'origine
    // le refusait — l'écran d'accord répondait « Session expirée » à tout le
    // monde. Rien ne part pour autant vers l'assistant : le référent n'est
    // transmis qu'à nos propres pages.
    'Referrer-Policy': 'same-origin',
  }).send(p.html);
}

/**
 * @param {import('express').Express} app
 */
export function monterCompte(app, {
  accounts, atlas, atlasSessions, oauth,
  calculer,                    // async (args d'« itineraire ») -> résultat ; lève en cas d'échec
  resoudreLieu = null,         // async (texte) -> { nom, arret_id?, lat, lon } ; lève si introuvable
  arretExiste = () => true,
  horairesJusquau = () => null, // "YYYYMMDD" ou null
  publicUrl = 'https://tisseo.plagnito.com',
  now = () => Math.floor(Date.now() / 1000),
  log = console.error,
  // [nombre, fenêtre en ms] par adresse IP. Réglables pour les tests, qui
  // enchaînent des dizaines de connexions depuis la même machine.
  debits = {},
}) {
  const DEBITS = { connexion: [30, 10 * 60_000], inscription: [20, 3600_000], compte: [240, 60_000], ...debits };
  const PUBLIC = String(publicUrl).replace(/\/+$/, '');
  const HOTE_PUBLIC = new URL(PUBLIC).host;

  // L'adresse sous laquelle CETTE requête nous voit. Seuls deux cas sont
  // admis : la machine locale (développement, téléphone branché en USB) et
  // l'adresse publique. Un en-tête Host fantaisiste ne fabrique donc jamais
  // une adresse de retour vers ailleurs.
  function baseDe(req) {
    const hote = String(req.headers.host ?? '');
    return /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(hote) ? `http://${hote}` : PUBLIC;
  }
  const estLocal = (req) => baseDe(req) !== PUBLIC;

  // Un corps illisible est une erreur de l'appelant (400), pas une panne (500).
  const lecteur = (analyse) => (req, res, next) => analyse(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Corps de requête illisible.', code: 'CORPS' });
    next();
  });
  const json = lecteur(express.json({ limit: '64kb' }));
  const formulaire = lecteur(express.urlencoded({ extended: false, limit: '16kb' }));
  const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // --- garde-fous de débit --------------------------------------------------
  function limiteur(max, fenetreMs) {
    const coups = new Map();
    return (req, res, next) => {
      const ip = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
      const t = Date.now();
      const l = (coups.get(ip) ?? []).filter((x) => t - x < fenetreMs);
      if (l.length >= max) return res.status(429).json({ error: 'Trop de demandes. Réessaie dans un moment.' });
      l.push(t); coups.set(ip, l);
      if (coups.size > 5000) for (const [k, v] of coups) if (!v.some((x) => t - x < fenetreMs)) coups.delete(k);
      next();
    };
  }
  const debitConnexion = limiteur(...DEBITS.connexion);
  const debitInscription = limiteur(...DEBITS.inscription);
  const debitCompte = limiteur(...DEBITS.compte);

  // --- session ----------------------------------------------------------------
  function sessionDe(req) {
    const jeton = porteur(req) ?? lireCookie(req, COOKIE);
    const s = accounts.session(jeton);
    return s ? { ...s, jeton, parCookie: !porteur(req) } : null;
  }
  function poserCookie(req, res, jeton) {
    const attrs = [`${COOKIE}=${encodeURIComponent(jeton)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${LIMITES.sessionJours * 86400}`];
    if (!estLocal(req)) attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
  }
  function retirerCookie(req, res) {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${estLocal(req) ? '' : '; Secure'}`);
  }
  // Une requête qui MODIFIE, portée par le cookie, doit venir de nos pages. Le
  // cookie est en SameSite=Lax, ce qui barre déjà les envois inter-sites ; ce
  // contrôle ferme le reste (un sous-domaine voisin, un navigateur laxiste).
  // L'application Android envoie son jeton en en-tête : pas de cookie, donc
  // rien à détourner.
  function origineSure(req) {
    const o = req.headers.origin;
    if (!o) return true;
    // Origine masquée (réglage de confidentialité du navigateur) : on se fie à
    // Sec-Fetch-Site, qu'une page ne peut ni poser ni falsifier.
    if (o === 'null') return req.headers['sec-fetch-site'] === 'same-origin';
    try { return new URL(o).host === new URL(baseDe(req)).host; } catch { return false; }
  }
  function exiger(req, res) {
    const s = sessionDe(req);
    if (!s) { res.status(401).json({ error: 'Connexion requise.', code: 'CONNEXION' }); return null; }
    if (req.method !== 'GET' && s.parCookie && !origineSure(req)) { res.status(403).json({ error: 'Origine refusée.', code: 'ORIGINE' }); return null; }
    return s;
  }
  // Les refus métier deviennent des réponses lisibles ; le reste remonte au
  // gestionnaire d'erreurs central.
  const metier = (fn) => ah(async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) {
      if (e instanceof Refus) return res.status(e.statut).json({ error: e.message, code: e.code });
      throw e;
    }
  });

  // --- lieux ------------------------------------------------------------------
  // Un lieu donné en texte seul est RÉSOLU au moment où on l'enregistre : on
  // garde l'arrêt ou le point que le calculateur a compris, et le nom sous
  // lequel il l'a compris. Deux raisons : une faute de frappe est refusée tout
  // de suite, pas le matin où l'on consulte son trajet ; et « Jean Jaurès »,
  // qui désigne trois stations, reste celle qu'on a vue en enregistrant.
  async function completerLieu(brut, quoi) {
    const l = nettoyerLieu(brut);
    if (!l) throw new Refus(`${quoi} : indique un lieu.`);
    if (l.stop_id || l.lat != null || !resoudreLieu) return l;
    let d;
    try { d = await resoudreLieu(l.texte); } catch (e) { throw new Refus(`${quoi} — ${String(e?.message ?? e)}`, 'LIEU', 422); }
    if (d.arret_id) l.stop_id = d.arret_id;
    if (Number.isFinite(d.lat) && Number.isFinite(d.lon)) { l.lat = d.lat; l.lon = d.lon; }
    if (d.nom) l.texte = String(d.nom).slice(0, LIMITES.lieu);
    return l;
  }
  /** Les lieux d'une demande (trajet, plan, partage), résolus. Ne touche qu'à ce qui est fourni. */
  async function preparer(b) {
    const out = { ...(b ?? {}) };
    if (out.de !== undefined && out.de !== null) out.de = await completerLieu(out.de, 'Départ');
    if (out.a !== undefined && out.a !== null) out.a = await completerLieu(out.a, 'Arrivée');
    return out;
  }

  // =========================================================================
  //  Connexion par Atlas
  // =========================================================================
  const attentes = new Map(); // state -> { verifier, redirectUri, retour, app, expire }
  const billets = new Map();  // code à usage unique (Android) -> { jeton, expire }
  const menage = () => {
    const t = now();
    for (const [k, v] of attentes) if (v.expire < t) attentes.delete(k);
    for (const [k, v] of billets) if (v.expire < t) billets.delete(k);
  };
  // Un chemin de retour ne peut être qu'un chemin de CE site.
  const cheminSur = (v) => (typeof v === 'string' && /^\/(?!\/)[^\\]{0,600}$/.test(v) ? v : '/');
  const SCHEMA_APP = 'tisseo-ville://auth';
  // Les adresses que le NAVIGATEUR visite (connexion, retour d'Atlas, accord
  // d'un assistant) vivent sous /api/ : c'est le seul préfixe qu'AUCUNE version
  // du service worker n'a jamais intercepté. Ailleurs, un navigateur resté sur
  // un ancien service worker prend leur redirection pour une panne et sert la
  // page d'accueil à leur place (vécu le 02/10/2026, le CDN servant encore
  // l'ancien sw.js).
  const CONNEXION = '/api/auth/connexion';
  const RETOUR = '/api/auth/retour';
  const AUTORISER = '/api/oauth/authorize';
  const ACCORD = '/api/oauth/accord';
  // Les anciennes adresses restent servies — l'application Android 1.2.0, un
  // onglet resté ouvert, un assistant qui a mémorisé l'ancienne adresse
  // d'autorisation — mais par une PAGE qui renvoie (réponse 200), jamais par
  // une redirection : c'est la seule forme qu'un ancien service worker laisse
  // passer. La cible est une constante de ce fichier ; seule la requête
  // d'origine la suit.
  const relayer = (vers) => (req, res) => {
    const i = req.originalUrl.indexOf('?');
    const cible = vers + (i < 0 ? '' : req.originalUrl.slice(i).replace(/[^\x21-\x7e]/g, ''));
    res.set('Refresh', `0; url=${cible}`);
    envoyerPage(res, page('Tisséo Live', `<h1>Un instant…</h1><div class="actions"><a class="bouton oui" href="${esc(cible)}">Continuer</a></div>`));
  };
  app.get('/auth/connexion', relayer(CONNEXION));
  app.get('/auth/retour', relayer(RETOUR));
  app.get('/oauth/authorize', relayer(AUTORISER));
  app.get('/oauth/accord', relayer(ACCORD));
  // Une connexion se termine dans le navigateur qui l'a commencée. Sans ce
  // lien, quelqu'un pourrait commencer une connexion avec SON compte Atlas et
  // faire ouvrir l'adresse de retour à une autre personne, qui se retrouverait
  // connectée au compte d'autrui sans le savoir (et y enregistrerait ses
  // trajets). Le témoin est réutilisé d'une tentative à l'autre : deux onglets
  // ne se gênent pas.
  const TEMOIN_DEMANDE = 'tisseo_demande';
  function lierAuNavigateur(req, res) {
    const deja = lireCookie(req, TEMOIN_DEMANDE);
    const lien = /^[0-9a-f]{32,64}$/.test(deja ?? '') ? deja : alea(18);
    res.append('Set-Cookie', `${TEMOIN_DEMANDE}=${lien}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${estLocal(req) ? '' : '; Secure'}`);
    return empreinte(lien);
  }

  app.get(CONNEXION, debitConnexion, (req, res) => {
    menage();
    if (attentes.size > 2000) return envoyerPage(res, page('Connexion', '<h1>Trop de connexions en cours</h1><p>Réessaie dans une minute.</p>', { statut: 503 }));
    const { verifier, challenge } = pkce();
    const state = alea(18);
    const redirectUri = `${baseDe(req)}${RETOUR}`;
    attentes.set(state, {
      verifier, redirectUri, retour: cheminSur(req.query.retour), app: req.query.app === 'android',
      navigateur: lierAuNavigateur(req, res),
      expire: now() + 10 * 60,
    });
    res.set('Cache-Control', 'no-store').redirect(atlas.urlAutorisation({ redirectUri, state, challenge }));
  });

  app.get(RETOUR, debitConnexion, ah(async (req, res) => {
    menage();
    const a = attentes.get(String(req.query.state ?? ''));
    attentes.delete(String(req.query.state ?? ''));
    const echec = (message, statut = 400) => envoyerPage(res, page('Connexion', `<h1>Connexion interrompue</h1><p>${esc(message)}</p><div class="actions"><a class="bouton oui" href="${CONNEXION}">Recommencer</a><a class="bouton" href="/">Retour à la carte</a></div>`, { statut }));
    if (!a || a.expire < now()) return echec('Cette tentative de connexion a expiré, ou a déjà servi.');
    const lien = lireCookie(req, TEMOIN_DEMANDE);
    if (!lien || !memeChaine(empreinte(lien), a.navigateur)) return echec('Cette connexion n’a pas été commencée dans ce navigateur. Recommence depuis ici.');
    if (!req.query.code) return echec('Atlas n’a pas confirmé la connexion.');
    let j;
    try {
      j = await atlas.echangerCode({ code: String(req.query.code).slice(0, 200), redirectUri: a.redirectUri, verifier: a.verifier }, now());
    } catch (e) {
      if (e instanceof Refus) return echec(e.message, e.statut);
      throw e;
    }
    if (!j.profil) return echec('Atlas n’a pas transmis le compte.', 502);
    accounts.ouvrirCompte(j.profil, { acces: j.acces, expire: j.expire, rafraichir: j.rafraichir });
    const jeton = accounts.ouvrirSession(j.profil.id, { genre: a.app ? 'android' : 'web' });
    if (a.app) {
      // Le jeton de session ne voyage pas dans une adresse (elle finit dans
      // l'historique du navigateur) : on remet un billet à usage unique, que
      // l'application échange aussitôt.
      const billet = alea(24);
      billets.set(billet, { jeton, expire: now() + 120 });
      const lien = `${SCHEMA_APP}?billet=${billet}`;
      const p = page('Connexion réussie', `<h1>Connexion réussie</h1><p>Compte Atlas : <b>${esc(j.profil.pseudo)}</b>.</p><p>Retourne dans l’application pour terminer.</p><div class="actions"><a class="bouton oui" href="${esc(lien)}">Ouvrir Ville &amp; Promenade</a></div><p class="note">Ce lien ne sert qu’une fois, pendant deux minutes.</p>`);
      // Redirection immédiate : la page n'est là que si le navigateur refuse
      // d'ouvrir l'application tout seul.
      res.set('Refresh', `0; url=${lien}`);
      return envoyerPage(res, p);
    }
    poserCookie(req, res, jeton);
    res.set('Cache-Control', 'no-store').redirect(a.retour);
  }));

  app.post('/api/auth/echange', debitConnexion, json, (req, res) => {
    menage();
    const cle = String(req.body?.billet ?? '');
    const b = billets.get(cle);
    billets.delete(cle);
    if (!b || b.expire < now()) return res.status(400).json({ error: 'Ce lien de connexion a expiré. Recommence.', code: 'BILLET' });
    const s = accounts.session(b.jeton);
    res.json({ jeton: b.jeton, compte: s ? { id: s.uid, pseudo: s.pseudo } : null });
  });

  app.post('/api/auth/deconnexion', json, (req, res) => {
    const s = sessionDe(req);
    if (s && s.parCookie && !origineSure(req)) return res.status(403).json({ error: 'Origine refusée.' });
    if (s) accounts.fermerSession(s.jeton);
    retirerCookie(req, res);
    res.json({ ok: true });
  });

  // =========================================================================
  //  /api/compte
  // =========================================================================
  const api = express.Router();
  api.use(debitCompte, json);

  // Sans session : 200 avec `connecte: false`. La page appelle cette route à
  // chaque ouverture ; un 401 y ferait une ligne rouge dans la console de tout
  // visiteur anonyme, pour un état parfaitement normal.
  api.get('/', (req, res) => {
    const s = sessionDe(req);
    if (!s) return res.json({ connecte: false, connexion: CONNEXION });
    res.json({ connecte: true, ...accounts.resume(s.uid), horaires_jusquau: horairesJusquau() });
  });
  api.delete('/', metier((req, res) => {
    const s = exiger(req, res); if (!s) return;
    oauth.oublierCompte(s.uid);
    accounts.supprimerCompte(s.uid);
    retirerCookie(req, res);
    res.json({ ok: true });
  }));

  // --- trajets enregistrés ----------------------------------------------------
  api.get('/trajets', metier((req, res) => { const s = exiger(req, res); if (s) res.json({ trajets: accounts.listerTrajets(s.uid) }); }));
  api.post('/trajets', metier(async (req, res) => {
    const s = exiger(req, res); if (!s) return;
    const t = accounts.enregistrerTrajet(s.uid, await preparer(req.body));
    res.status(t.deja ? 200 : 201).json({ trajet: t });
  }));
  api.put('/trajets/:id', metier(async (req, res) => { const s = exiger(req, res); if (s) res.json({ trajet: accounts.modifierTrajet(s.uid, req.params.id, await preparer(req.body)) }); }));
  api.delete('/trajets/:id', metier((req, res) => { const s = exiger(req, res); if (s) { accounts.supprimerTrajet(s.uid, req.params.id); res.json({ ok: true }); } }));
  // La page calcule elle-même (elle dessine le trajet sur la carte) : elle
  // signale seulement qu'elle s'en est servie, pour le classement « fréquents ».
  api.post('/trajets/:id/utilise', metier((req, res) => { const s = exiger(req, res); if (s) res.json({ trajet: accounts.utiliserTrajet(s.uid, req.params.id) }); }));

  // --- calcul -----------------------------------------------------------------
  /** L'itinéraire entre deux lieux enregistrés. Lève un Refus lisible. */
  async function itineraireEntre(de, a, { depart = null, arriver = null } = {}) {
    const args = { depart: requeteLieu(de, arretExiste), arrivee: requeteLieu(a, arretExiste) };
    if (arriver) args.arriver_avant = arriver; else if (depart) args.heure_depart = depart;
    try {
      return await calculer(args);
    } catch (e) {
      // Le calculateur explique lui-même ce qui ne va pas (« lieu introuvable »,
      // « impossible d'arriver avant… ») : on transmet son message.
      throw new Refus(String(e?.message ?? e), 'CALCUL', 422);
    }
  }
  /**
   * Calcule un trajet enregistré, maintenant ou à une heure donnée. Compte
   * comme une utilisation : c'est ce qui fait remonter les trajets fréquents.
   */
  async function calculTrajet(uid, id, quand = {}) {
    const t = accounts.trajet(uid, id);
    const itineraire = await itineraireEntre(t.de, t.a, quand);
    return { trajet: accounts.utiliserTrajet(uid, t.id), itineraire };
  }
  /** L'itinéraire d'un trajet planifié, à sa prochaine occurrence. */
  async function calculPlan(uid, id) {
    const p = accounts.plan(uid, id);
    if (p.passe || !p.prochaine) throw new Refus('Ce trajet planifié est passé. Change sa date ou supprime-le.', 'PASSE', 409);
    const quand = `${dateParis(p.prochaine)}T${heureParis(p.prochaine)}`;
    const itineraire = await itineraireEntre(p.de, p.a, p.mode === 'arriver' ? { arriver: quand } : { depart: quand });
    const out = { planifie: p, itineraire };
    // Les horaires publiés s'arrêtent à une date : au-delà, le calcul repose
    // sur des horaires qui n'existent pas encore. On le dit, on ne l'invente pas.
    const fin = horairesJusquau();
    if (fin && dateParis(p.prochaine).replaceAll('-', '') > fin) {
      out.avertissement = `Les horaires publiés par Tisséo s’arrêtent le ${fin.slice(6, 8)}/${fin.slice(4, 6)}/${fin.slice(0, 4)} : cet itinéraire sera à recalculer à l’approche de la date.`;
    }
    return out;
  }

  // `?heure=HH:MM` ou `?arriver=HH:MM` ; sans rien, maintenant.
  const HEURE = /^([01]?\d|2[0-3]):[0-5]\d$/;
  api.get('/trajets/:id/calcul', metier(async (req, res) => {
    const s = exiger(req, res); if (!s) return;
    const depart = HEURE.test(String(req.query.heure ?? '')) ? String(req.query.heure) : null;
    const arriver = HEURE.test(String(req.query.arriver ?? '')) ? String(req.query.arriver) : null;
    res.json(await calculTrajet(s.uid, req.params.id, { depart, arriver }));
  }));

  // --- trajets planifiés ------------------------------------------------------
  api.get('/planifies', metier((req, res) => { const s = exiger(req, res); if (s) res.json({ planifies: accounts.listerPlans(s.uid), horaires_jusquau: horairesJusquau() }); }));
  api.post('/planifies', metier(async (req, res) => { const s = exiger(req, res); if (s) res.status(201).json({ planifie: accounts.planifier(s.uid, await preparer(req.body)) }); }));
  api.put('/planifies/:id', metier(async (req, res) => { const s = exiger(req, res); if (s) res.json({ planifie: accounts.modifierPlan(s.uid, req.params.id, await preparer(req.body)) }); }));
  api.delete('/planifies/:id', metier((req, res) => { const s = exiger(req, res); if (s) { accounts.supprimerPlan(s.uid, req.params.id); res.json({ ok: true }); } }));
  api.get('/planifies/:id/calcul', metier(async (req, res) => {
    const s = exiger(req, res); if (!s) return;
    res.json(await calculPlan(s.uid, req.params.id));
  }));

  // --- amis (carnet Atlas) ------------------------------------------------------
  const carnets = new Map(); // uid -> { at, liste } : une minute, pour ne pas marteler Atlas
  async function amisDe(uid, { frais = false } = {}) {
    const c = carnets.get(uid);
    if (!frais && c && Date.now() - c.at < 60_000) return c.liste;
    const liste = await atlasSessions.contacts(uid);
    carnets.set(uid, { at: Date.now(), liste });
    if (carnets.size > 2000) carnets.delete(carnets.keys().next().value);
    return liste;
  }
  api.get('/amis', metier(async (req, res) => {
    const s = exiger(req, res); if (!s) return;
    res.json({ amis: await amisDe(s.uid, { frais: req.query.frais === '1' }), gerer: `${atlas.base}/contacts` });
  }));

  // --- partages -----------------------------------------------------------------
  /**
   * Crée un partage vers des amis VÉRIFIÉS : la liste envoyée par le client
   * est recoupée avec le carnet Atlas, relu à l'instant. Un identifiant qui
   * n'est pas un contact accepté fait échouer toute la demande — on ne partage
   * pas « avec ceux qui restent » sans le dire.
   */
  async function creerPartage(uid, b) {
    const demandes = [...new Set((Array.isArray(b?.amis) ? b.amis : []).map((x) => String(x)))];
    if (!demandes.length) throw new Refus('Choisis au moins un ami.');
    const carnet = await amisDe(uid, { frais: true });
    const parId = new Map(carnet.map((c) => [c.id, c]));
    const inconnus = demandes.filter((id) => !parId.has(id));
    if (inconnus.length) throw new Refus('Tu ne peux partager qu’avec tes contacts Atlas.', 'PAS_CONTACT', 403);
    const trajetPartage = b.trajet && typeof b.trajet === 'object' ? await preparer(b.trajet) : b.trajet;
    const partage = accounts.partager(uid, { ...b, trajet: trajetPartage, vers: demandes.map((id) => ({ id, pseudo: parId.get(id).pseudo })) });
    // La carte dans Atlas Contacts : une annonce. Si Atlas ne la prend pas, le
    // partage existe quand même, et l'ami le verra en ouvrant Tisséo Live.
    const annonce = await atlasSessions.prevenir(uid, {
      type: partage.type === 'position' ? 'position' : 'itineraire',
      vers: demandes,
      donnees: { partage: {
        id: partage.id, type: partage.type, expire: partage.expire, message: partage.message,
        nom: partage.trajet?.nom ?? null, de: partage.trajet?.de?.texte ?? null, a: partage.trajet?.a?.texte ?? null,
        mode: partage.trajet?.mode ?? null, heure: partage.trajet?.heure ?? null,
        date: partage.trajet?.date ?? null, jours: partage.trajet?.jours ?? null,
      } },
    });
    return { partage, prevenus: annonce.prevenus.length, ...(annonce.raison ? { annonce: annonce.raison } : {}) };
  }
  api.get('/partages', metier((req, res) => { const s = exiger(req, res); if (s) res.json(accounts.partagesDe(s.uid)); }));
  api.post('/partages', metier(async (req, res) => {
    const s = exiger(req, res); if (!s) return;
    res.status(201).json(await creerPartage(s.uid, req.body ?? {}));
  }));
  api.get('/partages/:id', metier((req, res) => { const s = exiger(req, res); if (s) res.json({ partage: accounts.partage(s.uid, req.params.id) }); }));
  api.delete('/partages/:id', metier((req, res) => { const s = exiger(req, res); if (s) res.json(accounts.retirerPartage(s.uid, req.params.id)); }));
  // Même effet, en POST : c'est ce qu'une page qui se ferme peut encore envoyer
  // (`navigator.sendBeacon` ne sait faire que cela). Sans ce geste, un partage
  // de position survivrait à la page qui l'alimentait.
  api.post('/partages/:id/arreter', metier((req, res) => { const s = exiger(req, res); if (s) res.json(accounts.retirerPartage(s.uid, req.params.id)); }));
  api.post('/partages/:id/position', metier((req, res) => { const s = exiger(req, res); if (s) res.json(accounts.majPosition(s.uid, req.params.id, req.body ?? {})); }));
  // Un ami garde pour lui un trajet qu'on lui a partagé.
  api.post('/partages/:id/enregistrer', metier((req, res) => {
    const s = exiger(req, res); if (!s) return;
    const p = accounts.partage(s.uid, req.params.id);
    if (!p.trajet?.de || !p.trajet?.a) throw new Refus('Ce partage ne contient pas de trajet à enregistrer.');
    const out = { trajet: accounts.enregistrerTrajet(s.uid, { nom: p.trajet.nom, de: p.trajet.de, a: p.trajet.a }) };
    if (p.trajet.heure && (p.trajet.date || p.trajet.jours)) {
      // Un trajet daté déjà passé ne se planifie pas : on garde le trajet seul.
      try {
        const plan = accounts.planifier(s.uid, p.trajet);
        if (plan.passe) accounts.supprimerPlan(s.uid, plan.id); else out.planifie = plan;
      } catch (e) { if (!(e instanceof Refus)) throw e; }
    }
    res.status(201).json(out);
  }));

  // --- assistants autorisés -----------------------------------------------------
  api.get('/assistants', metier((req, res) => { const s = exiger(req, res); if (s) res.json({ assistants: oauth.autorisations(s.uid), adresse: `${baseDe(req)}/mcp/compte` }); }));
  api.delete('/assistants/:id', metier((req, res) => { const s = exiger(req, res); if (s) res.json({ ok: true, retires: oauth.revoquer(s.uid, req.params.id) }); }));

  app.use('/api/compte', api);

  // =========================================================================
  //  OAuth des assistants
  // =========================================================================
  const RESSOURCE = '/mcp/compte';
  for (const suffixe of ['', '/mcp', '/mcp/compte']) {
    app.get(`/.well-known/oauth-protected-resource${suffixe}`, (req, res) => {
      const base = baseDe(req);
      // Chaque adresse MCP se décrit elle-même : un client vérifie que
      // `resource` est bien l'adresse qu'il appelle.
      const ressource = `${base}${suffixe === '/mcp' ? '/mcp' : RESSOURCE}`;
      res.set('Cache-Control', 'public, max-age=300').json(documentsDecouverte(base, ressource).ressource);
    });
    app.get(`/.well-known/oauth-authorization-server${suffixe}`, (req, res) => {
      res.set('Cache-Control', 'public, max-age=300').json(documentsDecouverte(baseDe(req), '').serveur);
    });
  }
  // Certains clients cherchent la configuration OpenID avant celle d'OAuth.
  app.get('/.well-known/openid-configuration', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(documentsDecouverte(baseDe(req), '').serveur);
  });

  const erreurOAuth = (res, e) => res.status(e.statut ?? 400).set('Cache-Control', 'no-store').json({ error: e.error, error_description: e.message });

  app.post('/oauth/register', debitInscription, json, (req, res) => {
    try { res.status(201).set('Cache-Control', 'no-store').json(oauth.enregistrerClient(req.body ?? {})); }
    catch (e) { if (e instanceof ErreurOAuth) return erreurOAuth(res, e); throw e; }
  });

  app.get(AUTORISER, debitConnexion, (req, res) => {
    let id;
    try { id = oauth.ouvrirDemande(req.query); } catch (e) {
      if (!(e instanceof ErreurOAuth)) throw e;
      if (e.versClient) {
        const u = new URL(e.redirectUri);
        u.searchParams.set('error', e.error);
        u.searchParams.set('error_description', e.message);
        if (e.state != null) u.searchParams.set('state', String(e.state));
        return res.redirect(u.toString());
      }
      return envoyerPage(res, page('Autorisation', `<h1>Demande refusée</h1><p>${esc(e.message)}</p>`, { statut: 400 }));
    }
    res.set('Cache-Control', 'no-store').redirect(`${ACCORD}?demande=${id}`);
  });

  app.get(ACCORD, (req, res) => {
    const id = String(req.query.demande ?? '');
    const d = oauth.demande(id);
    if (!d) return envoyerPage(res, page('Autorisation', '<h1>Demande expirée</h1><p>Relance la connexion depuis l’assistant.</p>', { statut: 400 }));
    const s = sessionDe(req);
    if (!s) return res.redirect(`${CONNEXION}?retour=${encodeURIComponent(`${ACCORD}?demande=${id}`)}`);
    const hotes = d.client.hotes.join(', ');
    envoyerPage(res, page('Autoriser un assistant', `
<h1>Autoriser cet assistant ?</h1>
<div class="qui"><div><b>${esc(d.client.nom)}</b><small>Les réponses partiront vers : ${esc(hotes)}</small></div></div>
<p>Connecté en tant que <b>${esc(s.pseudo)}</b>. Cet assistant pourra, en ton nom :</p>
<ul>
<li>lire, créer, modifier et supprimer tes <b>trajets enregistrés</b> et <b>planifiés</b> ;</li>
<li>calculer des itinéraires et interroger le réseau, comme le connecteur public.</li>
</ul>
<p>Ce que tu lui demandes et ce qu’il lit est traité par le service qui l’exploite (${esc(hotes)}), pas par Tisséo Live.</p>
<form method="post" action="${ACCORD}">
<input type="hidden" name="demande" value="${esc(id)}">
<label class="case"><input type="checkbox" name="amis" value="1"><span><b>Aussi : ce que mes amis partagent avec moi</b><small>Leurs trajets partagés, la liste de mes contacts Atlas, et le droit de partager un trajet avec eux. La position d’un ami n’est transmise que si cet ami l’a lui-même permis.</small></span></label>
<div class="actions"><button name="choix" value="non">Refuser</button><button class="oui" name="choix" value="oui">Autoriser</button></div>
</form>
<p class="note">Tu pourras retirer cette autorisation à tout moment, dans Tisséo Live → Compte → Assistants.</p>`));
  });

  app.post([ACCORD, '/oauth/accord'], formulaire, (req, res) => {
    const s = sessionDe(req);
    // Le cookie ne part pas sur un envoi inter-sites (SameSite=Lax) : une page
    // tierce ne peut donc pas valider l'accord à la place de l'utilisateur.
    if (!s || !origineSure(req)) return envoyerPage(res, page('Autorisation', '<h1>Session expirée</h1><p>Relance la connexion depuis l’assistant.</p>', { statut: 401 }));
    try {
      const vers = oauth.conclure(String(req.body?.demande ?? ''), s.uid, { accord: req.body?.choix === 'oui', amis: req.body?.amis === '1' });
      res.set('Cache-Control', 'no-store').redirect(303, vers);
    } catch (e) {
      if (e instanceof ErreurOAuth) return envoyerPage(res, page('Autorisation', `<h1>Demande expirée</h1><p>${esc(e.message)}</p>`, { statut: 400 }));
      throw e;
    }
  });

  // RFC 6749 : le point des jetons reçoit un FORMULAIRE. On accepte aussi le
  // JSON, que plusieurs clients envoient malgré tout.
  app.post('/oauth/token', debitCompte, formulaire, json, (req, res) => {
    try { res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json(oauth.echanger(req.body ?? {})); }
    catch (e) { if (e instanceof ErreurOAuth) return erreurOAuth(res, e); throw e; }
  });
  app.post('/oauth/revoke', debitCompte, formulaire, json, (req, res) => {
    oauth.revoquerJeton(req.body?.token);
    res.status(200).json({}); // RFC 7009 : 200 même pour un jeton inconnu
  });

  // =========================================================================
  //  Identification d'un assistant, pour /mcp
  // =========================================================================
  /**
   * Middleware : pose `req.mcp = { uid, pseudo, portees, client }` quand un
   * jeton valide est présenté. `obligatoire` : sans jeton, 401 avec l'en-tête
   * qui indique où s'autoriser — c'est ce qui déclenche le parcours OAuth
   * chez le client. Un jeton présenté mais invalide est TOUJOURS un 401 : le
   * servir comme anonyme cacherait à l'assistant que son accès a été retiré.
   */
  function identifierAssistant({ obligatoire = false } = {}) {
    return (req, res, next) => {
      const jeton = porteur(req);
      const refus = (message) => {
        const base = baseDe(req);
        res.set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${RESSOURCE}", scope="tisseo"`);
        res.status(401).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32001, message } });
      };
      if (!jeton) return obligatoire ? refus('Connexion requise : autorise cet assistant avec ton compte Atlas.') : next();
      const a = oauth.verifier(jeton);
      const c = a ? accounts.compte(a.uid) : null;
      if (!a || !c) return refus('Autorisation expirée ou retirée : reconnecte l’assistant.');
      req.mcp = { uid: a.uid, pseudo: c.pseudo, portees: a.portees, client: a.client };
      next();
    };
  }

  return { identifierAssistant, sessionDe, baseDe, creerPartage, calculTrajet, calculPlan, amisDe, preparer, log };
}
