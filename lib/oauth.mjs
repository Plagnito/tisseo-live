// OAuth pour les assistants (ChatGPT, Claude…) — le serveur d'autorisation.
// ---------------------------------------------------------------
// Le connecteur MCP public (`/mcp`) ne demande rien : il lit des données
// publiques. Dès qu'un assistant doit lire ou modifier LES TRAJETS DE QUELQU'UN,
// il lui faut une autorisation de cette personne, révocable, et qui dise ce
// qu'elle couvre. C'est ce module.
//
// Le parcours est celui que la spécification MCP décrit, et que ChatGPT et
// Claude suivent seuls :
//   1. découverte   /.well-known/oauth-protected-resource → ce serveur
//   2. inscription  POST /oauth/register (RFC 7591) : le client se déclare
//   3. accord       GET /oauth/authorize → connexion Atlas → écran d'accord
//   4. jetons       POST /oauth/token (code + PKCE S256, puis rafraîchissement)
//
// CE QUI REND L'INSCRIPTION LIBRE ACCEPTABLE. N'importe qui peut déclarer un
// client, mais :
//   • un client ne peut faire revenir le code d'autorisation QUE chez ChatGPT,
//     chez Claude, ou sur la machine même ; un site quelconque ne peut pas se
//     faire passer pour un assistant et récupérer un jeton ;
//   • le client est PUBLIC : pas de secret, donc PKCE S256 obligatoire ;
//   • rien n'est accordé sans un humain connecté qui lit l'écran d'accord, et
//     cet écran affiche le DOMAINE où part le code, pas seulement le nom que le
//     client s'est donné.
//
// DEUX PORTÉES, ET POURQUOI DEUX.
//   `tisseo` : les trajets enregistrés et planifiés du compte.
//   `amis`   : ce que les amis ont partagé avec ce compte. Séparée, et décochée
//     par défaut, parce qu'elle fait sortir des données d'AUTRES personnes vers
//     un tiers. Et même accordée, elle ne livre la position d'un ami que si cet
//     ami l'a permis de son côté (voir account.mjs, `vuePartage`).
// ---------------------------------------------------------------
import { alea, empreinte, texte, Refus } from './account.mjs';
import { defiPkce } from './atlas.mjs';

export const PORTEES = ['tisseo', 'amis'];
const HOTES_ASSISTANTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com', 'localhost', '127.0.0.1'];
const DUREE = { code: 5 * 60, demande: 10 * 60, acces: 3600, rafraichir: 90 * 86400, clientInactif: 120 * 86400 };
const MAX_CLIENTS = 300;

export class ErreurOAuth extends Error {
  constructor(error, description, statut = 400) { super(description); this.error = error; this.statut = statut; }
}

export function createOAuth({ store, now = () => Math.floor(Date.now() / 1000), hotesSupplementaires = [] }) {
  const col = store.collection('oauth', () => ({ clients: {}, jetons: {} }));
  const HOTES = [...HOTES_ASSISTANTS, ...hotesSupplementaires];
  const codes = new Map();     // code -> { uid, client, redirectUri, defi, portees, expire }
  const demandes = new Map();  // id   -> { client, redirectUri, state, defi, portees, expire }

  function menage() {
    const t = now();
    for (const [k, v] of codes) if (v.expire < t) codes.delete(k);
    for (const [k, v] of demandes) if (v.expire < t) demandes.delete(k);
    const d = col.lire();
    const mortsJ = Object.entries(d.jetons).filter(([, j]) => j.expire < t);
    const vivants = new Set(Object.values(d.jetons).filter((j) => j.expire >= t).map((j) => j.client));
    const mortsC = Object.values(d.clients).filter((c) => !vivants.has(c.id) && t - (c.vu ?? c.cree) > DUREE.clientInactif);
    if (!mortsJ.length && !mortsC.length) return;
    col.changer((x) => {
      for (const [k] of mortsJ) delete x.jetons[k];
      for (const c of mortsC) delete x.clients[c.id];
    });
  }

  // --- inscription ----------------------------------------------------------
  function validerRedirections(liste) {
    if (!Array.isArray(liste) || !liste.length || liste.length > 8) {
      throw new ErreurOAuth('invalid_redirect_uri', 'redirect_uris : de 1 à 8 adresses.');
    }
    const uris = [];
    for (const brut of liste) {
      let u;
      try { u = new URL(String(brut)); } catch { throw new ErreurOAuth('invalid_redirect_uri', `Adresse de redirection illisible : ${String(brut).slice(0, 80)}`); }
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.username || u.password || u.hash) throw new ErreurOAuth('invalid_redirect_uri', 'Adresse de redirection refusée.');
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new ErreurOAuth('invalid_redirect_uri', 'Redirection en https uniquement (http admis sur la machine locale).');
      if (!HOTES.includes(u.hostname)) {
        throw new ErreurOAuth('invalid_redirect_uri', `Redirection refusée vers ${u.hostname}. Hôtes admis : ${HOTES.join(', ')}.`);
      }
      uris.push(u.toString());
    }
    return [...new Set(uris)];
  }

  function enregistrerClient(b = {}) {
    menage();
    if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none') {
      throw new ErreurOAuth('invalid_client_metadata', 'Seuls les clients publics sont acceptés (PKCE, token_endpoint_auth_method « none »).');
    }
    const uris = validerRedirections(b.redirect_uris);
    const hotes = [...new Set(uris.map((u) => new URL(u).hostname))];
    const t = now();
    return col.changer((d) => {
      if (Object.keys(d.clients).length >= MAX_CLIENTS) throw new ErreurOAuth('temporarily_unavailable', 'Trop de clients enregistrés. Réessaie plus tard.', 503);
      const id = `tl_${alea(12)}`;
      d.clients[id] = { id, nom: texte(b.client_name, 60) || 'Assistant', redirections: uris, hotes, cree: t, vu: t };
      return {
        client_id: id, client_id_issued_at: t, client_name: d.clients[id].nom, redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none', scope: PORTEES.join(' '),
      };
    });
  }
  const client = (id) => col.lire().clients[String(id ?? '')] ?? null;
  /** Ce que l'écran d'accord affiche : le nom déclaré ET les domaines réels. */
  const clientPublic = (c) => (c ? { id: c.id, nom: c.nom, hotes: c.hotes } : null);

  // --- demande d'autorisation -------------------------------------------------
  /**
   * Vérifie une demande. Lève ErreurOAuth ; `e.versClient` vaut true quand
   * l'erreur peut être renvoyée au client par redirection (client et adresse
   * de retour déjà vérifiés) — sinon elle s'affiche ici, jamais ailleurs.
   */
  function ouvrirDemande(q) {
    menage();
    const c = client(q.client_id);
    if (!c) throw new ErreurOAuth('invalid_client', 'Client inconnu. Retire le connecteur et ajoute-le de nouveau.');
    const redirectUri = String(q.redirect_uri ?? '');
    if (!c.redirections.includes(redirectUri)) throw new ErreurOAuth('invalid_request', 'Adresse de retour non déclarée par ce client.');
    const versClient = (err) => Object.assign(err, { versClient: true, redirectUri, state: q.state });
    if (q.response_type !== 'code') throw versClient(new ErreurOAuth('unsupported_response_type', 'response_type=code attendu.'));
    const defi = String(q.code_challenge ?? '');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(defi) || String(q.code_challenge_method ?? '') !== 'S256') {
      throw versClient(new ErreurOAuth('invalid_request', 'PKCE S256 requis (code_challenge, code_challenge_method=S256).'));
    }
    const demandees = String(q.scope ?? '').split(/\s+/).filter((s) => PORTEES.includes(s));
    const id = alea(18);
    demandes.set(id, {
      client: c.id, redirectUri, state: q.state != null ? String(q.state).slice(0, 600) : null, defi,
      // `tisseo` est le socle : un connecteur sans lui n'aurait aucun outil.
      portees: [...new Set(['tisseo', ...demandees])],
      expire: now() + DUREE.demande,
    });
    return id;
  }
  function demande(id) {
    const d = demandes.get(String(id ?? ''));
    if (!d || d.expire < now()) return null;
    return { ...d, client: clientPublic(client(d.client)) };
  }
  /**
   * La réponse de l'humain. `accord` false = refus. `amis` : la case de l'écran.
   * Rend l'adresse où renvoyer le navigateur.
   */
  function conclure(id, uid, { accord, amis = false }) {
    const d = demandes.get(String(id ?? ''));
    if (!d || d.expire < now()) throw new ErreurOAuth('invalid_request', 'Cette demande a expiré. Relance la connexion depuis l’assistant.');
    demandes.delete(String(id));
    const retour = new URL(d.redirectUri);
    if (d.state != null) retour.searchParams.set('state', d.state);
    if (!accord) {
      retour.searchParams.set('error', 'access_denied');
      retour.searchParams.set('error_description', 'Autorisation refusée.');
      return retour.toString();
    }
    const code = alea(24);
    codes.set(code, {
      uid: String(uid), client: d.client, redirectUri: d.redirectUri, defi: d.defi,
      // La case « amis » décide, pas la demande du client : un client qui
      // réclame tout n'obtient que ce que la personne a coché.
      portees: amis ? ['tisseo', 'amis'] : ['tisseo'],
      expire: now() + DUREE.code,
    });
    retour.searchParams.set('code', code);
    return retour.toString();
  }

  // --- jetons -----------------------------------------------------------------
  function emettre(d, uid, clientId, portees) {
    const t = now();
    const acces = alea(32), rafraichir = alea(32);
    d.jetons[empreinte(acces)] = { uid, client: clientId, portees, genre: 'acces', cree: t, expire: t + DUREE.acces };
    d.jetons[empreinte(rafraichir)] = { uid, client: clientId, portees, genre: 'rafraichir', cree: t, expire: t + DUREE.rafraichir };
    if (d.clients[clientId]) d.clients[clientId].vu = t;
    return { access_token: acces, token_type: 'Bearer', expires_in: DUREE.acces, refresh_token: rafraichir, scope: portees.join(' ') };
  }

  function echanger(b = {}) {
    menage();
    const c = client(b.client_id);
    if (!c) throw new ErreurOAuth('invalid_client', 'Client inconnu.', 401);
    if (b.grant_type === 'authorization_code') {
      const cle = String(b.code ?? '');
      const e = codes.get(cle);
      // Usage unique, y compris en cas d'échec : un code présenté deux fois est
      // le signe qu'il a fuité.
      codes.delete(cle);
      if (!e || e.expire < now() || e.client !== c.id) throw new ErreurOAuth('invalid_grant', 'Code invalide, expiré ou déjà utilisé.');
      if (String(b.redirect_uri ?? '') !== e.redirectUri) throw new ErreurOAuth('invalid_grant', 'redirect_uri différente de celle de la demande.');
      if (!b.code_verifier || defiPkce(b.code_verifier) !== e.defi) throw new ErreurOAuth('invalid_grant', 'code_verifier incorrect (PKCE).');
      return col.changer((d) => emettre(d, e.uid, c.id, e.portees));
    }
    if (b.grant_type === 'refresh_token') {
      const cle = empreinte(String(b.refresh_token ?? ''));
      const j = col.lire().jetons[cle];
      if (!j || j.genre !== 'rafraichir' || j.expire < now() || j.client !== c.id) throw new ErreurOAuth('invalid_grant', 'Jeton de rafraîchissement invalide ou expiré.');
      return col.changer((d) => { delete d.jetons[cle]; return emettre(d, j.uid, c.id, j.portees); });
    }
    throw new ErreurOAuth('unsupported_grant_type', 'grant_type : authorization_code ou refresh_token.');
  }

  /** Le compte derrière un jeton d'accès : `{ uid, client, portees }` ou null. */
  function verifier(jeton) {
    if (!jeton || typeof jeton !== 'string' || jeton.length > 200) return null;
    const j = col.lire().jetons[empreinte(jeton)];
    if (!j || j.genre !== 'acces' || j.expire < now()) return null;
    const c = client(j.client);
    return { uid: j.uid, client: clientPublic(c) ?? { id: j.client, nom: 'Assistant', hotes: [] }, portees: j.portees };
  }

  // --- ce que l'utilisateur voit et retire -----------------------------------
  function autorisations(uid) {
    menage();
    const d = col.lire();
    const parClient = new Map();
    for (const j of Object.values(d.jetons)) {
      if (j.uid !== String(uid)) continue;
      const c = d.clients[j.client];
      const e = parClient.get(j.client) ?? { id: j.client, nom: c?.nom ?? 'Assistant', hotes: c?.hotes ?? [], portees: j.portees, depuis: j.cree };
      e.depuis = Math.min(e.depuis, j.cree);
      e.portees = [...new Set([...e.portees, ...j.portees])];
      parClient.set(j.client, e);
    }
    return [...parClient.values()].sort((a, b) => b.depuis - a.depuis);
  }
  function revoquer(uid, clientId) {
    return col.changer((d) => {
      let n = 0;
      for (const [k, j] of Object.entries(d.jetons)) if (j.uid === String(uid) && j.client === String(clientId)) { delete d.jetons[k]; n++; }
      return n;
    });
  }
  function revoquerJeton(jeton) {
    const cle = empreinte(String(jeton ?? ''));
    return col.changer((d) => {
      const j = d.jetons[cle];
      if (!j) return false;
      // Révoquer un jeton révoque la paire : garder l'accès après avoir retiré
      // le rafraîchissement (ou l'inverse) ne correspondrait à aucune intention.
      for (const [k, x] of Object.entries(d.jetons)) if (x.uid === j.uid && x.client === j.client && x.cree === j.cree) delete d.jetons[k];
      return true;
    });
  }
  function oublierCompte(uid) {
    col.changer((d) => { for (const [k, j] of Object.entries(d.jetons)) if (j.uid === String(uid)) delete d.jetons[k]; });
  }

  return {
    enregistrerClient, client, ouvrirDemande, demande, conclure, echanger, verifier,
    autorisations, revoquer, revoquerJeton, oublierCompte, HOTES,
  };
}

/** Les deux documents de découverte (RFC 9728 et RFC 8414). */
export function documentsDecouverte(base, ressource) {
  return {
    ressource: {
      resource: ressource,
      authorization_servers: [base],
      scopes_supported: PORTEES,
      bearer_methods_supported: ['header'],
      resource_name: 'Tisséo Live — compte',
      resource_documentation: 'https://docu.plagnito.com/tisseo-live',
    },
    serveur: {
      issuer: base,
      // Sous /api/ : seule adresse de ce document que le NAVIGATEUR visite, donc
      // la seule qu'un service worker pourrait intercepter (voir compte-routes).
      authorization_endpoint: `${base}/api/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: PORTEES,
    },
  };
}

export { Refus };
