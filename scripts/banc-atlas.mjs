// Faux Atlas — pour essayer les comptes sans toucher à la production.
// ---------------------------------------------------------------
// Tisséo Live demande trois choses à Atlas : qui se connecte (OAuth code +
// PKCE), qui sont ses contacts, et de prévenir un contact. Ce banc répond aux
// trois, avec trois comptes en dur, et RIEN d'autre : pas de mot de passe, pas
// de base, aucune donnée réelle.
//
//   node scripts/banc-atlas.mjs            # écoute sur 4731
//   $env:ATLAS_URL='http://127.0.0.1:4731'; npm start
//
// La page de connexion propose les comptes ; « Plagnito » a pour contacts
// « Bruno » et « Kiri », qui ne se connaissent pas entre eux — de quoi vérifier
// qu'on ne partage pas avec quelqu'un qui n'est pas son contact.
//
// Il applique les MÊMES refus que le vrai (client inconnu, hôte de retour non
// déclaré, PKCE absent, code à usage unique, jeton de rafraîchissement tournant) :
// un banc plus tolérant que la production ferait passer des erreurs.
// ---------------------------------------------------------------
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function creerFauxAtlas({
  comptes = { 1: 'Plagnito', 2: 'Bruno', 3: 'Kiri' },
  liens = [[1, 2], [1, 3]],
  clientId = 'tisseo-live',
  hotesRetour = ['localhost', '127.0.0.1'],
  dureeAcces = 600,
  typesInvitation = ['itineraire', 'position'],
} = {}) {
  const codes = new Map(), acces = new Map(), rafraichir = new Map();
  const invitations = [];
  const etat = { panne: false, typesInvitation };
  const contactsDe = (id) => liens.filter((l) => l.includes(Number(id))).map((l) => (l[0] === Number(id) ? l[1] : l[0]));

  const json = (res, statut, corps) => { res.writeHead(statut, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(corps)); };
  const lire = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });
  const porteur = (req) => {
    const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const e = acces.get(t);
    return e && e.exp > Date.now() ? e.id : null;
  };
  function emettre(id) {
    const a = randomBytes(24).toString('hex'), r = randomBytes(24).toString('hex');
    acces.set(a, { id, exp: Date.now() + dureeAcces * 1000 });
    rafraichir.set(r, { id });
    return { access_token: a, refresh_token: r, token_type: 'bearer', expires_in: dureeAcces, player: { id, pseudo: comptes[id], userId: null, cometEmail: null }, orgs: [] };
  }

  const serveur = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://banc');
    if (etat.panne) return json(res, 503, { error: 'banc en panne simulée' });

    if (req.method === 'GET' && u.pathname === '/api/plugins/comet-sso/authorize') {
      const q = u.searchParams;
      let hote = null; try { hote = new URL(q.get('redirect_uri')).hostname; } catch { /* */ }
      if (q.get('client_id') !== clientId) { res.writeHead(400); return res.end('Client SSO inconnu ou non configuré.'); }
      if (!hotesRetour.includes(hote)) { res.writeHead(400); return res.end('redirect_uri non autorisée.'); }
      if (!q.get('code_challenge')) { res.writeHead(400); return res.end('PKCE requis (code_challenge) pour ce client public.'); }
      if (String(q.get('code_challenge_method')).toUpperCase() !== 'S256') { res.writeHead(400); return res.end('PKCE S256 requis pour ce client public.'); }
      const id = Number(q.get('compte'));
      if (!comptes[id]) {
        const liens2 = Object.entries(comptes).map(([k, v]) => { const x = new URL(u); x.searchParams.set('compte', k); return `<a href="${x.pathname}${x.search.replace(/&/g, '&amp;')}">${v}</a>`; }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Faux Atlas</title>
<style>body{font:18px system-ui;background:#11161c;color:#e8edf2;display:grid;place-items:center;min-height:100vh;margin:0}main{padding:24px;max-width:420px}a{display:block;margin:12px 0;padding:16px;border-radius:10px;background:#1f2731;color:#fff;text-decoration:none;text-align:center;border:1px solid #3b4756}small{color:#8a97a6}</style>
<main><h1>Faux Atlas</h1><p><small>Banc d’essai : aucun compte réel. Choisis qui se connecte.</small></p>${liens2}</main>`);
      }
      const code = randomBytes(24).toString('hex');
      codes.set(code, { id, redirectUri: q.get('redirect_uri'), defi: q.get('code_challenge'), exp: Date.now() + 5 * 60_000 });
      const retour = new URL(q.get('redirect_uri'));
      retour.searchParams.set('code', code);
      if (q.get('state')) retour.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: retour.toString() });
      return res.end();
    }

    if (req.method === 'POST' && u.pathname === '/api/plugins/comet-sso/token') {
      const b = await lire(req);
      if (b.client_id !== clientId) return json(res, 401, { error: 'client_invalide' });
      if (b.grant_type === 'refresh_token') {
        const r = rafraichir.get(b.refresh_token);
        if (!r) return json(res, 400, { error: 'refresh_invalide' });
        rafraichir.delete(b.refresh_token);
        return json(res, 200, emettre(r.id));
      }
      const c = codes.get(b.code);
      if (!c || c.exp < Date.now()) return json(res, 400, { error: 'code_invalide' });
      if (b.redirect_uri !== c.redirectUri) return json(res, 400, { error: 'redirect_uri_mismatch' });
      if (!b.code_verifier || b64url(createHash('sha256').update(String(b.code_verifier)).digest()) !== c.defi) return json(res, 400, { error: 'pkce_invalide' });
      codes.delete(b.code);
      return json(res, 200, emettre(c.id));
    }

    if (req.method === 'GET' && u.pathname === '/api/contacts/destinataires') {
      const moi = porteur(req);
      if (!moi) return json(res, 401, { ok: false, error: 'Connexion Atlas requise.' });
      return json(res, 200, { ok: true, contacts: contactsDe(moi).map((id) => ({ id, pseudo: comptes[id], carte: null, eligible: true, raison: null })), groupes: [] });
    }

    if (req.method === 'POST' && u.pathname === '/api/contacts/invitations') {
      const moi = porteur(req);
      if (!moi) return json(res, 401, { ok: false, error: 'Connexion Atlas requise.' });
      const b = await lire(req);
      if (b.app !== 'tisseo' || !etat.typesInvitation.includes(b.type)) return json(res, 400, { ok: false, error: 'Type d’invitation inconnu.', code: 'TYPE' });
      const vers = (Array.isArray(b.vers) ? b.vers : []).map(Number);
      if (vers.some((id) => !contactsDe(moi).includes(id))) return json(res, 403, { ok: false, error: 'Tu ne peux inviter que tes contacts.', code: 'PAS_CONTACT' });
      const lot = randomBytes(6).toString('hex');
      const creees = vers.map((id) => ({ id: randomBytes(6).toString('hex'), app: b.app, type: b.type, de: { id: moi, pseudo: comptes[moi] }, vers: { id, pseudo: comptes[id] }, donnees: b.donnees }));
      invitations.push(...creees);
      return json(res, 200, { ok: true, lot, invitations: creees.map(({ donnees, ...i }) => i), nonRemises: 0, message: null });
    }

    if (req.method === 'GET' && u.pathname === '/banc/invitations') return json(res, 200, { invitations });
    json(res, 404, { error: 'route inconnue du banc' });
  });

  return { serveur, invitations, etat, comptes, expirerAcces() { for (const e of acces.values()) e.exp = 0; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.BANC_ATLAS_PORT) || 4731;
  const { serveur } = creerFauxAtlas();
  serveur.listen(port, '127.0.0.1', () => console.log(`Faux Atlas : http://127.0.0.1:${port}  (comptes : Plagnito, Bruno, Kiri)`));
}
