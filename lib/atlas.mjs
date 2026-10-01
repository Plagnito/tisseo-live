// Atlas — l'identité et le carnet de contacts.
// ---------------------------------------------------------------
// Tisséo Live ne gère ni mot de passe ni liste d'amis : il les demande à Atlas.
//
//   • L'IDENTITÉ : OAuth « code + PKCE » auprès du SSO Atlas (client public
//     `tisseo-live`). Le serveur fait l'échange lui-même : aucun secret à
//     déposer sur le Raspberry Pi, et le jeton Atlas ne passe jamais par le
//     navigateur.
//   • LES AMIS : le carnet d'Atlas Contacts. « Ami » veut dire contact ACCEPTÉ
//     des deux côtés ; Tisséo Live ne tient aucune liste à lui. Retirer un
//     contact dans Atlas le retire donc d'ici.
//   • PRÉVENIR : une carte d'invitation dans Atlas Contacts, pour que l'ami
//     apprenne le partage sans avoir Tisséo Live ouvert.
//
// Tout appel peut échouer (Atlas redéploie plusieurs fois par jour). Aucune
// fonction d'ici ne lève une erreur brute de `fetch` : c'est toujours un Refus
// avec un message qu'on peut afficher.
// ---------------------------------------------------------------
import { randomBytes, createHash } from 'node:crypto';
import { Refus } from './account.mjs';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
export const defiPkce = (verifier) => b64url(createHash('sha256').update(String(verifier)).digest());

export function createAtlas({
  base = process.env.ATLAS_URL || 'https://plagnito.com',
  clientId = process.env.ATLAS_CLIENT_ID || 'tisseo-live',
  fetcher = fetch,
  timeoutMs = 8000,
} = {}) {
  const racine = String(base).replace(/\/+$/, '');
  const sso = `${racine}/api/plugins/comet-sso`;

  async function appel(url, { method = 'GET', jeton = null, corps = null } = {}) {
    let res;
    try {
      res = await fetcher(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(corps ? { 'Content-Type': 'application/json' } : {}),
          ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
        },
        body: corps ? JSON.stringify(corps) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch {
      throw new Refus('Atlas ne répond pas pour l’instant. Réessaie dans un moment.', 'ATLAS_INJOIGNABLE', 502);
    }
    let json = null;
    try { json = await res.json(); } catch { /* corps vide ou HTML : traité par le statut */ }
    return { statut: res.status, ok: res.ok, json };
  }

  return {
    base: racine,
    clientId,

    urlAutorisation({ redirectUri, state, challenge }) {
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        state, code_challenge: challenge, code_challenge_method: 'S256',
      });
      return `${sso}/authorize?${q}`;
    },

    /** Échange le code contre des jetons Atlas. Rend `{ acces, expire, rafraichir, profil }`. */
    async echangerCode({ code, redirectUri, verifier }, maintenant) {
      const r = await appel(`${sso}/token`, {
        method: 'POST',
        corps: { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier },
      });
      if (!r.ok || !r.json?.access_token) {
        // `client_invalide` : le client tisseo-live n'est pas (encore) déclaré
        // côté Atlas. Le dire, plutôt qu'un « connexion impossible » qui fait
        // chercher du côté du mot de passe.
        const cause = r.json?.error === 'client_invalide'
          ? 'Tisséo Live n’est pas encore reconnu par Atlas.'
          : 'Atlas a refusé la connexion (code expiré ou déjà utilisé).';
        throw new Refus(`${cause} Recommence la connexion.`, 'ATLAS_REFUS', 502);
      }
      return jetons(r.json, maintenant);
    },

    async rafraichir(refresh, maintenant) {
      const r = await appel(`${sso}/token`, {
        method: 'POST',
        corps: { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh },
      });
      if (!r.ok || !r.json?.access_token) throw new Refus('Ta connexion Atlas a expiré. Reconnecte-toi.', 'ATLAS_SESSION', 401);
      return jetons(r.json, maintenant);
    },

    /** Le carnet : les contacts acceptés du compte. */
    async contacts(jeton) {
      const r = await appel(`${racine}/api/contacts/destinataires`, { jeton });
      if (r.statut === 401) throw new Refus('Ta connexion Atlas a expiré. Reconnecte-toi.', 'ATLAS_SESSION', 401);
      if (!r.ok || !Array.isArray(r.json?.contacts)) throw new Refus('Le carnet de contacts Atlas est indisponible pour l’instant.', 'ATLAS_INJOIGNABLE', 502);
      return r.json.contacts.map((c) => ({
        id: String(c.id),
        pseudo: String(c.pseudo ?? 'Contact').slice(0, 40),
        nom: c.carte?.nom ? String(c.carte.nom).slice(0, 60) : null,
      }));
    },

    /**
     * Prévient des contacts par une carte dans Atlas Contacts. N'échoue jamais :
     * le partage existe déjà côté Tisséo Live, la carte n'est qu'une annonce.
     * Rend `{ prevenus: [ids] }`.
     */
    async prevenir(jeton, { type, vers, donnees }) {
      try {
        const r = await appel(`${racine}/api/contacts/invitations`, {
          method: 'POST', jeton, corps: { app: 'tisseo', type, vers: vers.map(Number), donnees },
        });
        if (!r.ok) return { prevenus: [], raison: r.json?.error ?? `Atlas a répondu ${r.statut}` };
        // Atlas rend une invitation par destinataire servi : `vers: { id, pseudo }`.
        return { prevenus: (r.json?.invitations ?? []).map((i) => String(i?.vers?.id ?? '')).filter(Boolean), lot: r.json?.lot ?? null };
      } catch (e) {
        return { prevenus: [], raison: e.message };
      }
    },
  };

  function jetons(j, maintenant) {
    const profil = j.player && j.player.id != null ? { id: String(j.player.id), pseudo: String(j.player.pseudo ?? '') } : null;
    return {
      acces: String(j.access_token),
      expire: maintenant + Math.max(60, Number(j.expires_in) || 600),
      rafraichir: j.refresh_token ? String(j.refresh_token) : null,
      profil,
    };
  }
}

/**
 * Tient à jour le jeton Atlas de chaque compte. Le jeton d'accès vit dix
 * minutes ; le jeton de rafraîchissement est à USAGE UNIQUE (rotation) : deux
 * rafraîchissements lancés en même temps se voleraient le jeton, et le
 * perdant déconnecterait l'utilisateur. D'où la file par compte.
 */
export function createAtlasSessions({ atlas, accounts, now = () => Math.floor(Date.now() / 1000) }) {
  const enCours = new Map();

  async function jetonPour(uid) {
    const j = accounts.jetonsAtlas(uid);
    if (!j) throw new Refus('Reconnecte-toi avec Atlas pour utiliser tes contacts.', 'ATLAS_SESSION', 401);
    if (j.acces && j.expire - 45 > now()) return j.acces;
    if (!j.rafraichir) throw new Refus('Ta connexion Atlas a expiré. Reconnecte-toi.', 'ATLAS_SESSION', 401);
    if (enCours.has(uid)) return enCours.get(uid);
    const travail = (async () => {
      try {
        const neuf = await atlas.rafraichir(j.rafraichir, now());
        accounts.poserJetonsAtlas(uid, { acces: neuf.acces, expire: neuf.expire, rafraichir: neuf.rafraichir ?? j.rafraichir });
        return neuf.acces;
      } catch (e) {
        // Un refus franc d'Atlas : le jeton de rafraîchissement est mort, on
        // l'oublie pour ne pas le rejouer à chaque requête. Une panne réseau,
        // elle, ne doit rien effacer.
        if (e.code === 'ATLAS_SESSION') accounts.poserJetonsAtlas(uid, null);
        throw e;
      } finally {
        enCours.delete(uid);
      }
    })();
    enCours.set(uid, travail);
    return travail;
  }

  return {
    jetonPour,
    async contacts(uid) { return atlas.contacts(await jetonPour(uid)); },
    async prevenir(uid, quoi) {
      let jeton;
      try { jeton = await jetonPour(uid); } catch (e) { return { prevenus: [], raison: e.message }; }
      return atlas.prevenir(jeton, quoi);
    },
  };
}
